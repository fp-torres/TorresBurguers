import {
  BadRequestException,
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Repository } from 'typeorm';
import type { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth-user';
import type { Plan } from '../billing/entities/plan.entity';
import {
  SubscriptionStatus,
  type Subscription,
} from '../billing/entities/subscription.entity';
import type { PlanLimitsService } from '../billing/plan-limits.service';
import {
  decryptStoreSecret,
  encryptSecret,
  encryptStoreSecret,
  secretFormatVersion,
} from '../common/crypto/secret-box';
import { storeAccessState } from '../tenancy/store-access';
import type { TenantContext } from '../tenancy/tenant-context';
import { UserRole } from '../users/entities/user.entity';
import { Store, StoreAccountStatus } from './entities/store.entity';
import {
  CREDENTIALS_KEY_MISSING_MESSAGE,
  DELIVERY_ZONES_REQUIRED_MESSAGE,
  FULFILLMENT_REQUIRED_MESSAGE,
  StoreSettingsService,
} from './store-settings.service';
import type { StoreService } from './store.service';

// PNG 1x1 válido
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const TOKEN = 'APP_USR-1234567890123456-101112-abcdef0123456789-123456789';
const PUBLIC_KEY = 'APP_USR-5a6b2c43-1e71-4b0e-9b5a-0a1b2c3d4e5f';

const ADMIN: AuthUser = {
  id: 1,
  email: 'admin@loja7.com',
  role: UserRole.ADMIN,
  name: 'Admin',
  storeId: 7,
  platformRole: null,
};
const actor = { user: ADMIN };

function storeRow(overrides: Partial<Store> = {}): Store {
  return {
    id: 7,
    slug: 'loja-7',
    name: 'Loja 7',
    legal_name: null,
    document: '11222333000181',
    email: 'contato@loja7.com',
    phone: '21999999999',
    description: null,
    logo: null,
    primary_color: null,
    address_zip_code: null,
    address_street: null,
    address_number: null,
    address_complement: null,
    address_neighborhood: null,
    address_city: 'Rio de Janeiro',
    address_state: 'RJ',
    account_status: StoreAccountStatus.ACTIVE,
    status_reason: null,
    status_changed_at: null,
    is_open: true,
    opening_message: null,
    closing_message: null,
    delivery_enabled: false,
    takeout_enabled: true,
    delivery_zones: null,
    takeout_estimate: null,
    opening_hours: null,
    time_zone: 'America/Sao_Paulo',
    mp_public_key: null,
    mp_access_token_encrypted: null,
    custom_domain: null,
    owner_user_id: 3,
    // Relação carregada por engano nunca pode vazar (tem hash de senha)
    owner: { id: 3, password_hash: 'hash-secreto' } as never,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-02T00:00:00Z'),
    ...overrides,
  };
}

function tenantOf(
  store: Store,
  features: Plan['features'] = { custom_branding: true, online_payments: true },
): TenantContext {
  const subscription = {
    status: SubscriptionStatus.ACTIVE,
    plan: { features } as Plan,
  } as Subscription;
  return {
    storeId: store.id,
    store,
    subscription,
    access: storeAccessState(store, subscription),
  };
}

function setup(
  initial: Partial<Store> = {},
  options: { isDefault?: boolean; branding?: boolean } = {},
) {
  const row = storeRow(initial);
  const qb = {
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getOne: jest.fn(() => Promise.resolve({ ...row })),
  };
  const tx = {
    findOne: jest.fn(() => Promise.resolve({ id: row.id, logo: row.logo })),
    update: jest.fn(
      (_entity: unknown, _criteria: unknown, changes: Partial<Store>) => {
        Object.assign(row, changes);
        return Promise.resolve({ affected: 1 });
      },
    ),
  };
  const stores = {
    createQueryBuilder: jest.fn(() => qb),
    update: jest.fn((criteria: { id: number }, changes: Partial<Store>) => {
      if (criteria.id !== row.id) return Promise.resolve({ affected: 0 });
      Object.assign(row, changes);
      return Promise.resolve({ affected: 1 });
    }),
    manager: {
      transaction: jest.fn((work: (manager: typeof tx) => Promise<unknown>) =>
        work(tx),
      ),
    },
  };
  const storeService = {
    isDefaultStore: jest.fn().mockResolvedValue(options.isDefault ?? false),
  };
  const planLimits = {
    assertFeature: jest.fn(() =>
      options.branding === false
        ? Promise.reject(
            new ForbiddenException(
              'O plano Essencial não inclui identidade visual própria (logo e cor).',
            ),
          )
        : Promise.resolve(),
    ),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new StoreSettingsService(
    stores as unknown as Repository<Store>,
    storeService as unknown as StoreService,
    planLimits as unknown as PlanLimitsService,
    audit as unknown as AuditService,
  );
  return {
    service,
    row,
    qb,
    tx,
    stores,
    storeService,
    planLimits,
    audit,
    tenant: tenantOf(storeRow(initial)),
  };
}

const ENV_KEYS = [
  'NODE_ENV',
  'MP_ACCESS_TOKEN',
  'CREDENTIALS_ENCRYPTION_KEY',
  'UPLOADS_DIR',
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  delete process.env.MP_ACCESS_TOKEN;
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  jest.restoreAllMocks();
});

describe('StoreSettingsService — leitura', () => {
  it('token da própria loja (v2) mostra a dica; token copiado de outra loja não decifra (sem dica)', async () => {
    const own = setup({
      mp_public_key: PUBLIC_KEY,
      mp_access_token_encrypted: encryptStoreSecret(7, TOKEN),
    });
    expect((await own.service.getSettings(own.tenant)).payments).toMatchObject({
      access_token_configured: true,
      access_token_hint: 'APP_USR-12…6789',
    });

    const copied = setup({
      mp_public_key: PUBLIC_KEY,
      mp_access_token_encrypted: encryptStoreSecret(8, TOKEN),
    });
    expect(
      (await copied.service.getSettings(copied.tenant)).payments,
    ).toMatchObject({ access_token_configured: true, access_token_hint: null });
  });

  it('devolve a loja do contexto sem segredos, com a dica do token, a situação e os recursos', async () => {
    // Formato antigo (v1, sem vínculo com a loja): continua legível até ser regravado
    const encrypted = encryptSecret(TOKEN);
    const { service, tenant, qb } = setup({
      mp_public_key: PUBLIC_KEY,
      mp_access_token_encrypted: encrypted,
    });
    const settings = await service.getSettings(tenant);

    expect(qb.where).toHaveBeenCalledWith('store.id = :storeId', {
      storeId: 7,
    });
    expect(settings).toMatchObject({
      id: 7,
      slug: 'loja-7',
      document: '11222333000181',
      owner_user_id: 3,
      is_default_store: false,
      payments: {
        mp_public_key: PUBLIC_KEY,
        access_token_configured: true,
        access_token_hint: 'APP_USR-12…6789',
        using_platform_credentials: false,
      },
      access: { availability: 'OPERATIONAL', canManage: true },
      features: {
        online_payments: true,
        advanced_reports: false,
        custom_branding: true,
      },
    });
    const json = JSON.stringify(settings);
    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain(encrypted);
    expect(json).not.toContain('mp_access_token_encrypted');
    expect(json).not.toContain('hash-secreto');
    expect(settings).not.toHaveProperty('owner');
  });

  it('loja padrão sem credencial própria usa o MP_ACCESS_TOKEN do ambiente', async () => {
    process.env.MP_ACCESS_TOKEN = 'APP_USR-plataforma-123456789';
    const { service, tenant } = setup({}, { isDefault: true });
    const settings = await service.getSettings(tenant);
    expect(settings.is_default_store).toBe(true);
    expect(settings.payments).toEqual({
      mp_public_key: null,
      access_token_configured: false,
      access_token_hint: null,
      using_platform_credentials: true,
    });
    expect(JSON.stringify(settings)).not.toContain('plataforma-123456789');
  });

  it('token gravado que não decifra (chave trocada): configurado, sem dica, sem derrubar a tela', async () => {
    const { service, tenant } = setup({
      mp_access_token_encrypted: 'v1:aaaa:bbbb:cccc',
    });
    const settings = await service.getSettings(tenant);
    expect(settings.payments).toMatchObject({
      access_token_configured: true,
      access_token_hint: null,
    });
  });
});

describe('StoreSettingsService — PATCH /store/settings', () => {
  it('grava só os campos que mudaram, pelo id da loja, e audita só os nomes', async () => {
    const { service, tenant, stores, audit } = setup();
    const result = await service.updateSettings(
      tenant,
      {
        name: 'Loja Sete',
        document: '52998224725',
        phone: '21999999999', // igual ao atual: não conta como alteração
        opening_hours: [{ day: 1, open: '18:00', close: '23:00' }],
      },
      actor,
    );
    expect(stores.update).toHaveBeenCalledWith(
      { id: 7 },
      {
        name: 'Loja Sete',
        document: '52998224725',
        opening_hours: [{ day: 1, open: '18:00', close: '23:00' }],
      },
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'store.settings.update',
        storeId: 7,
        metadata: { fields: ['name', 'document', 'opening_hours'] },
      }),
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(
      '52998224725',
    );
    // A resposta é a configuração já atualizada
    expect(result).toMatchObject({
      name: 'Loja Sete',
      document: '52998224725',
    });
  });

  it('nada mudou: não grava nem audita', async () => {
    const { service, tenant, stores, audit } = setup({
      delivery_zones: {
        zones: [{ neighborhoods: ['Centro'], fee: 5, time: '30 min' }],
        fallback: { fee: 10, time: '1h' },
      },
    });
    await service.updateSettings(
      tenant,
      {
        name: 'Loja 7',
        // mesma configuração com as chaves em outra ordem (o jsonb reordena)
        delivery_zones: {
          fallback: { time: '1h', fee: 10 },
          zones: [{ fee: 5, neighborhoods: ['Centro'], time: '30 min' }],
        },
      },
      actor,
    );
    expect(stores.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('cor da marca exige o recurso custom_branding do plano (403 sem gravar)', async () => {
    const { service, tenant, stores, planLimits } = setup(
      {},
      { branding: false },
    );
    await expect(
      service.updateSettings(tenant, { primary_color: '#E11D48' }, actor),
    ).rejects.toThrow(ForbiddenException);
    expect(planLimits.assertFeature).toHaveBeenCalledWith(7, 'custom_branding');
    expect(stores.update).not.toHaveBeenCalled();
  });

  it('reenviar a mesma cor não exige o recurso (formulário completo)', async () => {
    const { service, tenant, planLimits } = setup(
      { primary_color: '#E11D48' },
      { branding: false },
    );
    await service.updateSettings(
      tenant,
      { primary_color: '#E11D48', name: 'Outro nome' },
      actor,
    );
    expect(planLimits.assertFeature).not.toHaveBeenCalled();
  });

  it('voltar à cor padrão (null) não exige o recurso: loja que mudou de plano consegue tirar a cor', async () => {
    const { service, tenant, stores, planLimits } = setup(
      { primary_color: '#E11D48' },
      { branding: false },
    );
    await service.updateSettings(tenant, { primary_color: null }, actor);
    expect(planLimits.assertFeature).not.toHaveBeenCalled();
    expect(stores.update).toHaveBeenCalledWith(
      { id: 7 },
      { primary_color: null },
    );
  });

  it('habilitar entrega sem zonas: só na loja padrão (zonas do ambiente)', async () => {
    const other = setup({ delivery_enabled: false });
    await expect(
      other.service.updateSettings(
        other.tenant,
        { delivery_enabled: true },
        actor,
      ),
    ).rejects.toThrow(DELIVERY_ZONES_REQUIRED_MESSAGE);
    expect(other.stores.update).not.toHaveBeenCalled();

    const main = setup({ delivery_enabled: false }, { isDefault: true });
    await main.service.updateSettings(
      main.tenant,
      { delivery_enabled: true },
      actor,
    );
    expect(main.stores.update).toHaveBeenCalledWith(
      { id: 7 },
      { delivery_enabled: true },
    );

    // Com as zonas na mesma requisição, qualquer loja pode
    const withZones = setup({ delivery_enabled: false });
    await withZones.service.updateSettings(
      withZones.tenant,
      {
        delivery_enabled: true,
        delivery_zones: { fallback: { fee: 9, time: '1h' }, zones: [] },
      },
      actor,
    );
    expect(withZones.stores.update).toHaveBeenCalled();
  });

  it('remover as zonas com a entrega ligada também é recusado fora da loja padrão', async () => {
    const { service, tenant } = setup({
      delivery_enabled: true,
      delivery_zones: { fallback: { fee: 9, time: '1h' }, zones: [] },
    });
    await expect(
      service.updateSettings(tenant, { delivery_zones: null }, actor),
    ).rejects.toThrow(BadRequestException);
  });

  it('loja recém-criada (entrega ligada sem zonas) ainda edita os outros dados', async () => {
    const { service, tenant, stores } = setup({ delivery_enabled: true });
    await service.updateSettings(tenant, { name: 'Nome novo' }, actor);
    expect(stores.update).toHaveBeenCalledWith(
      { id: 7 },
      { name: 'Nome novo' },
    );
  });

  it('precisa manter entrega ou retirada', async () => {
    const { service, tenant } = setup({
      delivery_enabled: false,
      takeout_enabled: true,
    });
    await expect(
      service.updateSettings(tenant, { takeout_enabled: false }, actor),
    ).rejects.toThrow(FULFILLMENT_REQUIRED_MESSAGE);
  });
});

describe('StoreSettingsService — credenciais do Mercado Pago', () => {
  it('cifra o token, grava na loja do contexto e nunca devolve nem audita o token', async () => {
    const { service, tenant, stores, audit, row } = setup();
    const result = await service.setPaymentCredentials(
      tenant,
      { mp_public_key: PUBLIC_KEY, mp_access_token: TOKEN },
      actor,
    );

    expect(stores.update).toHaveBeenCalledWith(
      { id: 7 },
      expect.objectContaining({ mp_public_key: PUBLIC_KEY }),
    );
    expect(row.mp_access_token_encrypted).not.toBe(TOKEN);
    // Gravado preso à loja (v2 com AAD "store:7"): só decifra no contexto da própria loja
    const stored = row.mp_access_token_encrypted ?? '';
    expect(secretFormatVersion(stored)).toBe('v2');
    expect(decryptStoreSecret(7, stored)).toBe(TOKEN);
    expect(() => decryptStoreSecret(8, stored)).toThrow();

    expect(result).toEqual({
      mp_public_key: PUBLIC_KEY,
      access_token_configured: true,
      access_token_hint: 'APP_USR-12…6789',
      using_platform_credentials: false,
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);

    const auditJson = JSON.stringify(audit.record.mock.calls);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'store.payments.update',
        metadata: { provider: 'MERCADO_PAGO', environment: 'PRODUCTION' },
      }),
    );
    expect(auditJson).not.toContain(TOKEN);
    expect(auditJson).not.toContain(row.mp_access_token_encrypted);
  });

  it('chave pública e token precisam ser do mesmo tipo', async () => {
    const { service, tenant, stores } = setup();
    await expect(
      service.setPaymentCredentials(
        tenant,
        { mp_public_key: 'TEST-5a6b2c43-1e71', mp_access_token: TOKEN },
        actor,
      ),
    ).rejects.toThrow(/mesmo tipo/);
    expect(stores.update).not.toHaveBeenCalled();
  });

  it('em produção recusa credenciais de teste (TEST-)', async () => {
    process.env.NODE_ENV = 'production';
    const { service, tenant } = setup();
    await expect(
      service.setPaymentCredentials(
        tenant,
        {
          mp_public_key: 'TEST-5a6b2c43-1e71',
          mp_access_token: 'TEST-1234567890-abc',
        },
        actor,
      ),
    ).rejects.toThrow(/não podem ser usadas em produção/);
  });

  it('sem CREDENTIALS_ENCRYPTION_KEY em produção → 503 com mensagem clara, nada gravado', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    const { service, tenant, stores } = setup();
    const error = await service
      .setPaymentCredentials(
        tenant,
        { mp_public_key: PUBLIC_KEY, mp_access_token: TOKEN },
        actor,
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toBe(CREDENTIALS_KEY_MISSING_MESSAGE);
    expect(stores.update).not.toHaveBeenCalled();
  });

  it('DELETE limpa as credenciais da loja e audita', async () => {
    process.env.MP_ACCESS_TOKEN = 'APP_USR-plataforma-123456789';
    const { service, tenant, stores, audit } = setup(
      { mp_public_key: PUBLIC_KEY, mp_access_token_encrypted: 'v1:x:y:z' },
      { isDefault: true },
    );
    await expect(
      service.removePaymentCredentials(tenant, actor),
    ).resolves.toEqual({
      mp_public_key: null,
      access_token_configured: false,
      access_token_hint: null,
      using_platform_credentials: true,
    });
    expect(stores.update).toHaveBeenCalledWith(
      { id: 7 },
      { mp_public_key: null, mp_access_token_encrypted: null },
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'store.payments.remove', storeId: 7 }),
    );
  });

  it('loja que sumiu → 404', async () => {
    const { service, stores } = setup();
    const ghost = tenantOf(storeRow({ id: 70 }));
    await expect(
      service.removePaymentCredentials(ghost, actor),
    ).rejects.toThrow(NotFoundException);
    expect(stores.update).toHaveBeenCalledWith({ id: 70 }, expect.any(Object));
  });
});

describe('StoreSettingsService — logo', () => {
  let uploads: string;
  const file = () =>
    ({
      buffer: PNG,
      size: PNG.length,
      originalname: 'logo.png',
      mimetype: 'image/png',
    }) as Express.Multer.File;

  beforeEach(() => {
    uploads = mkdtempSync(join(tmpdir(), 'store-logo-spec-'));
    process.env.UPLOADS_DIR = uploads;
  });
  afterEach(() => rmSync(uploads, { recursive: true, force: true }));

  it('grava o logo com o prefixo da loja e apaga o anterior DESTA loja', async () => {
    writeFileSync(join(uploads, 's7-antigo.webp'), 'x');
    const { service, tenant, tx, audit } = setup({ logo: 's7-antigo.webp' });

    const { logo } = await service.uploadLogo(tenant, file(), actor);

    expect(logo).toMatch(/^s7-compressed-.+\.webp$/);
    expect(readdirSync(uploads)).toEqual([logo]);
    expect(tx.findOne).toHaveBeenCalledWith(
      Store,
      expect.objectContaining({
        where: { id: 7 },
        lock: { mode: 'pessimistic_write' },
      }),
    );
    expect(tx.update).toHaveBeenCalledWith(Store, { id: 7 }, { logo });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'store.logo.update', storeId: 7 }),
    );
  });

  it('nunca apaga arquivo de outra loja nem fora de /uploads', async () => {
    writeFileSync(join(uploads, 's8-da-outra-loja.webp'), 'x');
    const { service, tenant } = setup({ logo: 's8-da-outra-loja.webp' });
    await service.uploadLogo(tenant, file(), actor);
    expect(existsSync(join(uploads, 's8-da-outra-loja.webp'))).toBe(true);

    const escape = setup({ logo: '../s7-fora.webp' });
    await expect(
      escape.service.removeLogo(escape.tenant, actor),
    ).resolves.toEqual({ logo: null });
  });

  it('plano sem identidade visual → 403 antes de processar a imagem', async () => {
    const { service, tenant, tx } = setup({}, { branding: false });
    await expect(service.uploadLogo(tenant, file(), actor)).rejects.toThrow(
      ForbiddenException,
    );
    expect(readdirSync(uploads)).toEqual([]);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('plano sem identidade visual ainda pode REMOVER o logo (ex.: depois de um downgrade)', async () => {
    writeFileSync(join(uploads, 's7-logo-antigo.webp'), 'x');
    const { service, tenant } = setup(
      { logo: 's7-logo-antigo.webp' },
      { branding: false },
    );
    await expect(service.removeLogo(tenant, actor)).resolves.toEqual({
      logo: null,
    });
    expect(existsSync(join(uploads, 's7-logo-antigo.webp'))).toBe(false);
  });

  it('sem arquivo → 400; imagem inválida não deixa arquivo nem altera a loja', async () => {
    const { service, tenant, tx } = setup();
    await expect(service.uploadLogo(tenant, undefined, actor)).rejects.toThrow(
      /Nenhuma imagem enviada/,
    );
    const gif = {
      ...file(),
      buffer: Buffer.from('GIF89a'),
      size: 6,
    } as Express.Multer.File;
    await expect(service.uploadLogo(tenant, gif, actor)).rejects.toThrow(
      BadRequestException,
    );
    expect(readdirSync(uploads)).toEqual([]);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('falha ao gravar no banco apaga a imagem recém-salva', async () => {
    const { service, tenant, tx } = setup();
    tx.findOne.mockResolvedValueOnce(null as never);
    await expect(service.uploadLogo(tenant, file(), actor)).rejects.toThrow(
      NotFoundException,
    );
    expect(readdirSync(uploads)).toEqual([]);
  });

  it('DELETE remove o arquivo da loja e limpa o logo', async () => {
    writeFileSync(join(uploads, 's7-atual.webp'), 'x');
    const { service, tenant, row, audit } = setup({ logo: 's7-atual.webp' });
    await expect(service.removeLogo(tenant, actor)).resolves.toEqual({
      logo: null,
    });
    expect(row.logo).toBeNull();
    expect(readdirSync(uploads)).toEqual([]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'store.logo.remove' }),
    );
  });
});
