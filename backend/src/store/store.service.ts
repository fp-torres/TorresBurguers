import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { IsNull, Not, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth-user';
import { omitUndefined } from '../common/transforms';
import {
  STORE_NOT_FOUND_MESSAGE,
  TenantService,
} from '../tenancy/tenant.service';
import { UpdateStoreStatusDto } from './dto/update-store-status.dto';
import { Store } from './entities/store.entity';
import { presentStoreStatus, type StoreStatusView } from './store-presenter';

/** Quem fez a alteração e a requisição (IP e navegador), para a auditoria. */
export interface StoreActor {
  user: AuthUser;
  request?: Request | null;
}

type StatusField = keyof UpdateStoreStatusDto;
const STATUS_FIELDS: StatusField[] = [
  'is_open',
  'opening_message',
  'closing_message',
];

/**
 * Status da loja (aberta/fechada e mensagens da vitrine) e consultas básicas usadas por outros
 * módulos. Toda consulta recebe o storeId já resolvido pelo guard (equipe ou vitrine) e filtra por ele.
 */
@Injectable()
export class StoreService {
  constructor(
    @InjectRepository(Store)
    private readonly stores: Repository<Store>,
    private readonly tenants: TenantService,
    private readonly audit: AuditService,
  ) {}

  /** { id, is_open, opening_message, closing_message } (contrato do app mobile). */
  async getStatus(storeId: number): Promise<StoreStatusView> {
    const store = await this.stores.findOne({
      where: { id: storeId },
      select: {
        id: true,
        is_open: true,
        opening_message: true,
        closing_message: true,
      },
    });
    if (!store) throw new NotFoundException(STORE_NOT_FOUND_MESSAGE);
    return presentStoreStatus(store);
  }

  /**
   * Abre/fecha a loja e atualiza as mensagens da vitrine. Grava só o que mudou de fato (corpo vazio
   * ou valores iguais não alteram nada nem geram auditoria).
   */
  async updateStatus(
    storeId: number,
    dto: UpdateStoreStatusDto,
    actor: StoreActor,
  ): Promise<StoreStatusView> {
    const current = await this.getStatus(storeId);
    const requested = omitUndefined(dto);
    const changes: Partial<Pick<Store, StatusField>> = {};
    for (const field of STATUS_FIELDS) {
      const value = requested[field];
      if (value !== undefined && value !== current[field]) {
        Object.assign(changes, { [field]: value });
      }
    }

    const fields = Object.keys(changes) as StatusField[];
    if (!fields.length) return current;

    const result = await this.stores.update({ id: storeId }, changes);
    if (!result.affected) throw new NotFoundException(STORE_NOT_FOUND_MESSAGE);

    await this.audit.record({
      actor: actor.user,
      storeId,
      action: 'store.status.update',
      targetType: 'store',
      targetId: storeId,
      // Só os nomes dos campos e o novo estado de abertura (as mensagens não vão para a trilha)
      metadata: {
        fields,
        ...(changes.is_open !== undefined ? { is_open: changes.is_open } : {}),
      },
      request: actor.request,
    });
    return { ...current, ...changes };
  }

  /** Loja aberta para novos pedidos? Loja inexistente conta como fechada (falha fechada). */
  async isOpen(storeId: number): Promise<boolean> {
    const store = await this.stores.findOne({
      where: { id: storeId },
      select: { id: true, is_open: true },
    });
    return store?.is_open === true;
  }

  /**
   * É a loja padrão das rotas antigas? Ela usa as credenciais (MP_ACCESS_TOKEN/MP_PUBLIC_KEY) e as
   * zonas de entrega do ambiente quando não tem as próprias. Mesma regra do TenantService.
   */
  async isDefaultStore(storeId: number): Promise<boolean> {
    const store = await this.tenants.defaultStore();
    return store?.id === storeId;
  }

  /** A loja gravou um Access Token próprio do Mercado Pago? (o valor nunca sai daqui) */
  hasOwnPaymentCredentials(storeId: number): Promise<boolean> {
    return this.stores.exists({
      where: { id: storeId, mp_access_token_encrypted: Not(IsNull()) },
    });
  }
}
