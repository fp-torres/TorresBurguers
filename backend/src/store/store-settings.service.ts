import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { PlanLimitsService } from '../billing/plan-limits.service';
import {
  CredentialsKeyError,
  decryptStoreSecret,
  encryptStoreSecret,
  maskSecret,
} from '../common/crypto/secret-box';
import { withOptimizedImage } from '../common/pipes/optimize-image.pipe';
import { isStoreFile, storeFilePrefix } from '../common/uploads/store-files';
import { isProduction } from '../config/env';
import { storeLocationError } from '../orders/delivery-distance';
import { uploadsDir } from '../config/paths';
import { STORE_NOT_FOUND_MESSAGE } from '../tenancy/tenant.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { StorePaymentCredentialsDto } from './dto/store-payment-credentials.dto';
import {
  STORE_SETTINGS_FIELDS,
  UpdateStoreSettingsDto,
  type StoreSettingsField,
} from './dto/update-store-settings.dto';
import { Store } from './entities/store.entity';
import {
  presentStoreSettings,
  type StorePaymentsSettingsView,
  type StoreSettingsView,
} from './store-presenter';
import {
  featuresOf,
  mercadoPagoCredentialEnvironment,
  platformAccessTokenConfigured,
} from './store-rules';
import { StoreService, type StoreActor } from './store.service';

export const DELIVERY_ZONES_REQUIRED_MESSAGE =
  'Configure as zonas de entrega (bairros, taxas e prazos) antes de habilitar a entrega.';
export const FULFILLMENT_REQUIRED_MESSAGE =
  'Mantenha pelo menos uma forma de atendimento ativa: entrega ou retirada no balcão.';
export const CREDENTIALS_KEY_MISSING_MESSAGE =
  'A plataforma ainda não está configurada para guardar credenciais de pagamento com segurança (chave de criptografia ausente). Fale com o suporte da plataforma.';
export const NO_LOGO_FILE_MESSAGE =
  'Nenhuma imagem enviada. Envie o logo no campo "file".';

/** Comparação de valores (inclusive JSON) sem depender da ordem das chaves gravada pelo jsonb. */
function sameValue(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : item,
  );
}

/**
 * Configurações da loja da equipe (painel do ADMIN): dados comerciais, endereço, operação, entrega,
 * horários, fuso, identidade visual, logo e credenciais do Mercado Pago. Tudo é lido e gravado na
 * loja do contexto (users.store_id do usuário autenticado), nunca numa loja vinda da requisição.
 */
@Injectable()
export class StoreSettingsService {
  private readonly logger = new Logger(StoreSettingsService.name);

  constructor(
    @InjectRepository(Store)
    private readonly stores: Repository<Store>,
    private readonly storeService: StoreService,
    private readonly planLimits: PlanLimitsService,
    private readonly audit: AuditService,
  ) {}

  /** GET /store/settings: loja sem segredos + credenciais (só a dica) + situação + recursos do plano. */
  async getSettings(tenant: TenantContext): Promise<StoreSettingsView> {
    const store = await this.loadStore(tenant.storeId);
    const isDefault = await this.storeService.isDefaultStore(tenant.storeId);
    return presentStoreSettings(store, {
      is_default_store: isDefault,
      payments: this.paymentsView(store, isDefault),
      access: tenant.access,
      features: featuresOf(tenant.subscription),
    });
  }

  /** PATCH /store/settings: aplica só o que foi enviado e mudou; audita os nomes dos campos alterados. */
  async updateSettings(
    tenant: TenantContext,
    dto: UpdateStoreSettingsDto,
    actor: StoreActor,
  ): Promise<StoreSettingsView> {
    const storeId = tenant.storeId;
    const current = await this.loadStore(storeId);

    // Lista de permitidos: só os campos editáveis do DTO (nunca slug, situação, responsável...)
    const changes: Partial<Pick<Store, StoreSettingsField>> = {};
    for (const field of STORE_SETTINGS_FIELDS) {
      const value = dto[field];
      if (value !== undefined && !sameValue(value, current[field])) {
        Object.assign(changes, { [field]: value });
      }
    }
    const fields = Object.keys(changes) as StoreSettingsField[];

    // Definir uma cor própria exige o recurso do plano; voltar à cor padrão (null) não — como remover
    // o logo, uma loja que mudou para um plano sem identidade visual precisa conseguir tirá-la
    if (fields.includes('primary_color') && changes.primary_color !== null) {
      await this.planLimits.assertFeature(storeId, 'custom_branding');
    }
    await this.assertFulfillment(storeId, current, changes);
    // Local da loja (entrega por distância): coordenadas juntas e obrigatórias no modo distância
    if (
      'latitude' in changes ||
      'longitude' in changes ||
      'delivery_zones' in changes
    ) {
      const locationError = storeLocationError({ ...current, ...changes });
      if (locationError) throw new BadRequestException(locationError);
    }

    if (fields.length) {
      const result = await this.stores.update({ id: storeId }, changes);
      if (!result.affected) {
        throw new NotFoundException(STORE_NOT_FOUND_MESSAGE);
      }
      await this.audit.record({
        actor: actor.user,
        storeId,
        action: 'store.settings.update',
        targetType: 'store',
        targetId: storeId,
        // Só os nomes dos campos: valores (documento, contatos...) não vão para a trilha
        metadata: { fields },
        request: actor.request,
      });
    }
    return this.getSettings(tenant);
  }

  /**
   * Entrega exige zonas: as da loja ou, só na loja padrão, as do ambiente (DELIVERY_ZONES_*).
   * E a loja precisa manter entrega ou retirada. Conferido só quando a requisição mexe nesses campos,
   * para não travar a edição de outros dados de uma loja recém-criada.
   */
  private async assertFulfillment(
    storeId: number,
    current: Store,
    changes: Partial<Pick<Store, StoreSettingsField>>,
  ): Promise<void> {
    const touchesDelivery =
      'delivery_enabled' in changes || 'delivery_zones' in changes;
    const touchesFulfillment =
      'delivery_enabled' in changes || 'takeout_enabled' in changes;
    if (!touchesDelivery && !touchesFulfillment) return;

    const next = { ...current, ...changes };
    if (touchesFulfillment && !next.delivery_enabled && !next.takeout_enabled) {
      throw new BadRequestException(FULFILLMENT_REQUIRED_MESSAGE);
    }
    if (
      touchesDelivery &&
      next.delivery_enabled &&
      !next.delivery_zones &&
      !(await this.storeService.isDefaultStore(storeId))
    ) {
      throw new BadRequestException(DELIVERY_ZONES_REQUIRED_MESSAGE);
    }
  }

  // ---------------------------------------------------------------------------
  // Logo (recurso custom_branding)
  // ---------------------------------------------------------------------------

  /** POST /store/logo: grava o logo otimizado (s<storeId>-...webp) e apaga o anterior da própria loja. */
  async uploadLogo(
    tenant: TenantContext,
    file: Express.Multer.File | undefined,
    actor: StoreActor,
  ): Promise<{ logo: string | null }> {
    const storeId = tenant.storeId;
    // Antes de processar a imagem: um plano sem o recurso não deixa arquivo órfão em /uploads
    await this.planLimits.assertFeature(storeId, 'custom_branding');
    if (!file) throw new BadRequestException(NO_LOGO_FILE_MESSAGE);

    const logo = await withOptimizedImage(
      file,
      async (filename) => {
        if (!filename) throw new BadRequestException(NO_LOGO_FILE_MESSAGE);
        const previous = await this.replaceLogo(storeId, filename);
        await this.removeStoreFile(storeId, previous);
        return filename;
      },
      { prefix: storeFilePrefix(storeId) },
    );

    await this.audit.record({
      actor: actor.user,
      storeId,
      action: 'store.logo.update',
      targetType: 'store',
      targetId: storeId,
      metadata: { logo },
      request: actor.request,
    });
    return { logo };
  }

  /**
   * DELETE /store/logo: remove o logo (e o arquivo, se for desta loja). Não exige o recurso
   * custom_branding: uma loja que mudou para um plano sem identidade visual precisa conseguir tirá-la.
   */
  async removeLogo(
    tenant: TenantContext,
    actor: StoreActor,
  ): Promise<{ logo: null }> {
    const storeId = tenant.storeId;

    const previous = await this.replaceLogo(storeId, null);
    if (previous) {
      await this.removeStoreFile(storeId, previous);
      await this.audit.record({
        actor: actor.user,
        storeId,
        action: 'store.logo.remove',
        targetType: 'store',
        targetId: storeId,
        request: actor.request,
      });
    }
    return { logo: null };
  }

  /** Troca o logo com a linha da loja travada (uploads simultâneos não perdem o arquivo anterior). */
  private replaceLogo(
    storeId: number,
    logo: string | null,
  ): Promise<string | null> {
    return this.stores.manager.transaction(async (tx) => {
      const current = await tx.findOne(Store, {
        where: { id: storeId },
        select: { id: true, logo: true },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current) throw new NotFoundException(STORE_NOT_FOUND_MESSAGE);
      if (current.logo !== logo) {
        await tx.update(Store, { id: storeId }, { logo });
      }
      return current.logo ?? null;
    });
  }

  /** Apaga um arquivo de /uploads somente se ele for desta loja (prefixo s<storeId>-). */
  private async removeStoreFile(
    storeId: number,
    filename: string | null,
  ): Promise<void> {
    if (!filename || path.basename(filename) !== filename) return;
    if (!isStoreFile(filename, storeId)) return;
    await fs
      .unlink(path.join(uploadsDir(), filename))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          this.logger.warn(
            `Não foi possível apagar o logo antigo da loja ${storeId} (${filename}): ${error.message}`,
          );
        }
      });
  }

  // ---------------------------------------------------------------------------
  // Credenciais do Mercado Pago da loja
  // ---------------------------------------------------------------------------

  /** PUT /store/settings/payments: valida, cifra e grava. A resposta nunca traz o token. */
  async setPaymentCredentials(
    tenant: TenantContext,
    dto: StorePaymentCredentialsDto,
    actor: StoreActor,
  ): Promise<StorePaymentsSettingsView> {
    const storeId = tenant.storeId;
    const publicKeyEnv = mercadoPagoCredentialEnvironment(dto.mp_public_key);
    const tokenEnv = mercadoPagoCredentialEnvironment(dto.mp_access_token);
    if (!publicKeyEnv || !tokenEnv) {
      throw new BadRequestException(
        'Credenciais inválidas: a chave pública e o Access Token começam com APP_USR- (produção) ou TEST- (teste).',
      );
    }
    if (publicKeyEnv !== tokenEnv) {
      throw new BadRequestException(
        'A chave pública e o Access Token precisam ser do mesmo tipo: os dois de produção (APP_USR-) ou os dois de teste (TEST-).',
      );
    }
    if (tokenEnv === 'TEST' && isProduction()) {
      throw new BadRequestException(
        'Credenciais de teste (TEST-) não podem ser usadas em produção. Use as credenciais de produção (APP_USR-) da conta Mercado Pago da loja.',
      );
    }

    let encrypted: string;
    try {
      // Presa à loja (v2 com AAD "store:<id>"): copiada para outra loja no banco, não decifra
      encrypted = encryptStoreSecret(storeId, dto.mp_access_token);
    } catch (error) {
      if (error instanceof CredentialsKeyError) {
        this.logger.error(
          `Credenciais da loja ${storeId} não gravadas: ${error.message}`,
        );
        throw new ServiceUnavailableException(CREDENTIALS_KEY_MISSING_MESSAGE);
      }
      throw error;
    }

    const result = await this.stores.update(
      { id: storeId },
      {
        mp_public_key: dto.mp_public_key,
        mp_access_token_encrypted: encrypted,
      },
    );
    if (!result.affected) throw new NotFoundException(STORE_NOT_FOUND_MESSAGE);

    await this.audit.record({
      actor: actor.user,
      storeId,
      action: 'store.payments.update',
      targetType: 'store',
      targetId: storeId,
      // Nunca o token (nem cifrado): só o ambiente da conta configurada
      metadata: { provider: 'MERCADO_PAGO', environment: tokenEnv },
      request: actor.request,
    });
    return {
      mp_public_key: dto.mp_public_key,
      access_token_configured: true,
      access_token_hint: maskSecret(dto.mp_access_token),
      using_platform_credentials: false,
    };
  }

  /** DELETE /store/settings/payments: apaga as credenciais da loja. */
  async removePaymentCredentials(
    tenant: TenantContext,
    actor: StoreActor,
  ): Promise<StorePaymentsSettingsView> {
    const storeId = tenant.storeId;
    const result = await this.stores.update(
      { id: storeId },
      { mp_public_key: null, mp_access_token_encrypted: null },
    );
    if (!result.affected) throw new NotFoundException(STORE_NOT_FOUND_MESSAGE);

    await this.audit.record({
      actor: actor.user,
      storeId,
      action: 'store.payments.remove',
      targetType: 'store',
      targetId: storeId,
      metadata: { provider: 'MERCADO_PAGO' },
      request: actor.request,
    });
    const isDefault = await this.storeService.isDefaultStore(storeId);
    return {
      mp_public_key: null,
      access_token_configured: false,
      access_token_hint: null,
      using_platform_credentials:
        isDefault && platformAccessTokenConfigured(process.env),
    };
  }

  // ---------------------------------------------------------------------------

  /** Loja completa, incluindo o token cifrado (select: false na entidade) só para montar a dica. */
  private async loadStore(storeId: number): Promise<Store> {
    const store = await this.stores
      .createQueryBuilder('store')
      .addSelect('store.mp_access_token_encrypted')
      .where('store.id = :storeId', { storeId })
      .getOne();
    if (!store) throw new NotFoundException(STORE_NOT_FOUND_MESSAGE);
    return store;
  }

  private paymentsView(
    store: Store,
    isDefault: boolean,
  ): StorePaymentsSettingsView {
    const configured = !!store.mp_access_token_encrypted;
    return {
      mp_public_key: store.mp_public_key ?? null,
      access_token_configured: configured,
      access_token_hint: configured ? this.tokenHint(store) : null,
      using_platform_credentials:
        isDefault && !configured && platformAccessTokenConfigured(process.env),
    };
  }

  /** Dica do token gravado; se não der para decifrar (chave trocada/ausente), só registra no log. */
  private tokenHint(store: Store): string | null {
    try {
      return maskSecret(
        decryptStoreSecret(store.id, store.mp_access_token_encrypted ?? ''),
      );
    } catch (error) {
      this.logger.warn(
        `Não foi possível ler o Access Token gravado da loja ${store.id}: ${(error as Error).message}`,
      );
      return null;
    }
  }
}
