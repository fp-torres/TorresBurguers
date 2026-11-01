import { Logger, NotFoundException } from '@nestjs/common';
import { DataSource, SelectQueryBuilder } from 'typeorm';
import type { Plan } from '../billing/entities/plan.entity';
import {
  SubscriptionStatus,
  type Subscription,
} from '../billing/entities/subscription.entity';
import { ENTITIES } from '../database/entities';
import {
  STORE_UNAVAILABLE_MESSAGE,
  storeAccessState,
} from '../tenancy/store-access';
import type { TenantContext } from '../tenancy/tenant-context';
import type { TenantService } from '../tenancy/tenant.service';
import { Store, StoreAccountStatus } from './entities/store.entity';
import { StoreDirectoryService } from './store-directory.service';
import type { StoreService } from './store.service';

const NOW = new Date('2026-10-11T12:00:00Z');

function storeRow(overrides: Partial<Store> = {}): Store {
  return {
    id: 7,
    slug: 'loja-7',
    name: 'Loja 7',
    legal_name: 'Loja Sete LTDA',
    document: '11222333000181',
    email: 'contato@loja7.com',
    phone: '21999999999',
    description: 'Hambúrgueres',
    logo: 's7-logo.webp',
    primary_color: '#E11D48',
    address_zip_code: '20040003',
    address_street: 'Av. Rio Branco',
    address_number: '156',
    address_complement: null,
    address_neighborhood: 'Centro',
    address_city: 'Rio de Janeiro',
    address_state: 'RJ',
    latitude: null,
    longitude: null,
    account_status: StoreAccountStatus.ACTIVE,
    status_reason: null,
    status_changed_at: null,
    is_open: true,
    opening_message: 'Bem-vindo!',
    closing_message: null,
    delivery_enabled: true,
    takeout_enabled: true,
    delivery_zones: null,
    takeout_estimate: null,
    opening_hours: [{ day: 2, open: '18:00', close: '23:00' }],
    time_zone: 'America/Sao_Paulo',
    mp_public_key: null,
    mp_access_token_encrypted: null,
    custom_domain: null,
    owner_user_id: 3,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-02T00:00:00Z'),
    ...overrides,
  };
}

function contextOf(
  store: Store,
  options: {
    features?: Plan['features'];
    status?: SubscriptionStatus;
  } = {},
): TenantContext {
  const subscription = {
    status: options.status ?? SubscriptionStatus.ACTIVE,
    plan: {
      features: options.features ?? { online_payments: true },
    } as Plan,
  } as Subscription;
  return {
    storeId: store.id,
    store,
    subscription,
    access: storeAccessState(store, subscription, NOW),
  };
}

const ENV_KEYS = ['NODE_ENV', 'MP_ACCESS_TOKEN', 'MP_PUBLIC_KEY'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = 'production'; // sem sandbox: só credenciais de verdade liberam o pagamento online
  delete process.env.MP_ACCESS_TOKEN;
  delete process.env.MP_PUBLIC_KEY;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  jest.restoreAllMocks();
});

describe('StoreDirectoryService — perfil público', () => {
  function setup(options: { credentials?: boolean; isDefault?: boolean } = {}) {
    const storeService = {
      hasOwnPaymentCredentials: jest
        .fn()
        .mockResolvedValue(options.credentials ?? false),
      isDefaultStore: jest.fn().mockResolvedValue(options.isDefault ?? false),
    };
    const tenants = { publicContext: jest.fn() };
    const service = new StoreDirectoryService(
      {} as never,
      tenants as unknown as TenantService,
      storeService as unknown as StoreService,
    );
    return { service, storeService, tenants };
  }

  it('só campos públicos: nunca documento, responsável, motivo interno ou credenciais', async () => {
    const { service, storeService } = setup({ credentials: true });
    const store = storeRow({
      mp_public_key: 'APP_USR-pk-da-loja',
      mp_access_token_encrypted: 'v1:segredo:cifrado:aqui',
      status_reason: 'Motivo interno',
      custom_domain: 'loja7.com.br',
      delivery_zones: { fallback: { fee: 8, time: '40 min' }, zones: [] },
    });
    const profile = await service.profile(contextOf(store));

    expect(profile).toEqual({
      id: 7,
      slug: 'loja-7',
      name: 'Loja 7',
      description: 'Hambúrgueres',
      logo: 's7-logo.webp',
      primary_color: '#E11D48',
      phone: '21999999999',
      email: 'contato@loja7.com',
      address: {
        zip_code: '20040003',
        street: 'Av. Rio Branco',
        number: '156',
        complement: null,
        neighborhood: 'Centro',
        city: 'Rio de Janeiro',
        state: 'RJ',
      },
      opening_hours: [{ day: 2, open: '18:00', close: '23:00' }],
      time_zone: 'America/Sao_Paulo',
      is_open: true,
      opening_message: 'Bem-vindo!',
      closing_message: null,
      delivery_enabled: true,
      delivers_outside_zones: true,
      takeout_enabled: true,
      takeout_estimate: '15-20 min',
      ordering_available: true,
      unavailable_message: null,
      payments: { online_enabled: true, mp_public_key: 'APP_USR-pk-da-loja' },
      // Sem pedido mínimo nem frete grátis configurados
      order_rules: {
        min_order: null,
        min_order_takeout: false,
        free_delivery_above: null,
        varies_by_zone: false,
      },
      // Entrega por zonas (o padrão): sem "Entrega até X km"
      delivery_distance: null,
    });
    const json = JSON.stringify(profile);
    for (const secret of [
      '11222333000181',
      'Loja Sete LTDA',
      'segredo',
      'Motivo interno',
      'owner_user_id',
      'loja7.com.br',
    ]) {
      expect(json).not.toContain(secret);
    }
    expect(storeService.hasOwnPaymentCredentials).toHaveBeenCalledWith(7);
    // Com credencial própria, ser ou não a loja padrão não importa
    expect(storeService.isDefaultStore).not.toHaveBeenCalled();
  });

  it('entrega só aparece com zonas próprias (ou na loja padrão, com as zonas da plataforma)', async () => {
    const { service, storeService } = setup();
    storeService.isDefaultStore.mockResolvedValue(false);
    const withoutZones = await service.profile(contextOf(storeRow()));
    expect(withoutZones.delivery_enabled).toBe(false);

    storeService.isDefaultStore.mockResolvedValue(true);
    const defaultStore = await service.profile(contextOf(storeRow()));
    expect(defaultStore.delivery_enabled).toBe(true);
  });

  it('mostra se a loja entrega fora das zonas (outside_zones): "refuse" → false; padrão ou "fallback" → true', async () => {
    const { service } = setup({ credentials: true });
    const zone = { neighborhoods: ['Centro'], fee: 5, time: '30 min' };
    const refuses = await service.profile(
      contextOf(
        storeRow({
          delivery_zones: { zones: [zone], outside_zones: 'refuse' },
        }),
      ),
    );
    expect(refuses).toMatchObject({
      delivery_enabled: true,
      delivers_outside_zones: false,
    });

    for (const delivery_zones of [
      { zones: [zone], fallback: { fee: 9, time: '1 h' } },
      {
        zones: [zone],
        fallback: { fee: 9, time: '1 h' },
        outside_zones: 'fallback' as const,
      },
    ]) {
      const accepts = await service.profile(
        contextOf(storeRow({ delivery_zones })),
      );
      expect(accepts.delivers_outside_zones).toBe(true);
    }

    // Loja padrão sem zonas próprias: a política das zonas da plataforma (DELIVERY_ZONES_*)
    const platform = setup({ isDefault: true });
    const saved = process.env.DELIVERY_ZONES_JSON;
    process.env.DELIVERY_ZONES_JSON = JSON.stringify({
      zones: [zone],
      outside_zones: 'refuse',
    });
    try {
      const profile = await platform.service.profile(contextOf(storeRow()));
      expect(profile).toMatchObject({
        delivery_enabled: true,
        delivers_outside_zones: false,
      });
    } finally {
      if (saved === undefined) delete process.env.DELIVERY_ZONES_JSON;
      else process.env.DELIVERY_ZONES_JSON = saved;
    }
  });

  it('loja suspensa: vitrine aberta, sem pedidos, com mensagem genérica (sem o motivo)', async () => {
    const { service } = setup();
    const store = storeRow({
      account_status: StoreAccountStatus.SUSPENDED,
      status_reason: 'Fraude em investigação',
    });
    const profile = await service.profile(contextOf(store));
    expect(profile.ordering_available).toBe(false);
    expect(profile.unavailable_message).toBe(STORE_UNAVAILABLE_MESSAGE);
    expect(JSON.stringify(profile)).not.toContain('Fraude');
  });

  it('loja padrão sem credencial própria: MP_ACCESS_TOKEN + MP_PUBLIC_KEY do ambiente', async () => {
    process.env.MP_ACCESS_TOKEN = 'APP_USR-token-da-plataforma';
    process.env.MP_PUBLIC_KEY = 'APP_USR-pk-da-plataforma';
    const { service } = setup({ isDefault: true });
    const profile = await service.profile(contextOf(storeRow()));
    expect(profile.payments).toEqual({
      online_enabled: true,
      mp_public_key: 'APP_USR-pk-da-plataforma',
    });
    expect(JSON.stringify(profile)).not.toContain('token-da-plataforma');
  });

  it('outra loja sem credencial: o ambiente não vale para ela', async () => {
    process.env.MP_ACCESS_TOKEN = 'APP_USR-token-da-plataforma';
    process.env.MP_PUBLIC_KEY = 'APP_USR-pk-da-plataforma';
    const { service } = setup({ isDefault: false });
    const profile = await service.profile(contextOf(storeRow()));
    expect(profile.payments).toEqual({
      online_enabled: false,
      mp_public_key: null,
    });
  });

  it('plano sem pagamentos online: desligado mesmo com credencial', async () => {
    const { service } = setup({ credentials: true });
    const profile = await service.profile(
      contextOf(storeRow({ mp_public_key: 'APP_USR-pk' }), {
        features: { online_payments: false },
      }),
    );
    expect(profile.payments.online_enabled).toBe(false);
  });

  it('credencial de teste da loja em produção: a cobrança recusaria, então não anuncia', async () => {
    const { service } = setup({ credentials: true });
    const profile = await service.profile(
      contextOf(storeRow({ mp_public_key: 'TEST-pk-da-loja' })),
    );
    expect(profile.payments).toEqual({
      online_enabled: false,
      mp_public_key: 'TEST-pk-da-loja',
    });
  });

  it('sandbox de development/test libera o pagamento online simulado', async () => {
    process.env.NODE_ENV = 'test';
    const { service } = setup();
    const profile = await service.profile(contextOf(storeRow()));
    expect(profile.payments.online_enabled).toBe(true);
  });

  it('prazo da retirada próprio da loja', async () => {
    const { service } = setup();
    const profile = await service.profile(
      contextOf(storeRow({ takeout_estimate: '10 min' })),
    );
    expect(profile.takeout_estimate).toBe('10 min');
  });

  it('GET /stores/default: perfil da loja padrão; sem loja padrão → 404', async () => {
    const { service, tenants, storeService } = setup();
    tenants.publicContext.mockResolvedValueOnce(contextOf(storeRow()));
    await expect(service.defaultProfile()).resolves.toMatchObject({ id: 7 });
    expect(tenants.publicContext).toHaveBeenCalledWith(null);
    expect(storeService.isDefaultStore).not.toHaveBeenCalled();

    tenants.publicContext.mockRejectedValueOnce(
      new NotFoundException(
        'Nenhuma loja está configurada nesta plataforma ainda.',
      ),
    );
    await expect(service.defaultProfile()).rejects.toThrow(NotFoundException);
  });
});

/** Só os metadados das entidades, sem conectar: o QueryBuilder monta o SQL de verdade. */
class OfflineDataSource extends DataSource {
  async loadMetadata(): Promise<this> {
    await this.buildMetadatas();
    return this;
  }
}

describe('StoreDirectoryService — diretório (SQL)', () => {
  let service: StoreDirectoryService;
  let queries: { sql: string; params: unknown[] }[];
  let rows: unknown[];

  beforeAll(async () => {
    const dataSource = await new OfflineDataSource({
      type: 'postgres',
      entities: ENTITIES,
      invalidWhereValuesBehavior: { null: 'throw', undefined: 'throw' },
    }).loadMetadata();
    service = new StoreDirectoryService(
      dataSource.getRepository(Store),
      {} as TenantService,
      {} as StoreService,
    );
  });

  beforeEach(() => {
    queries = [];
    rows = [];
    jest
      .spyOn(SelectQueryBuilder.prototype, 'getCount')
      .mockImplementation(function (this: SelectQueryBuilder<Store>) {
        const [sql, params] = this.getQueryAndParameters();
        queries.push({ sql, params });
        return Promise.resolve(rows.length);
      });
    jest
      .spyOn(SelectQueryBuilder.prototype, 'getRawMany')
      .mockImplementation(function (this: SelectQueryBuilder<Store>) {
        const [sql, params] = this.getQueryAndParameters();
        queries.push({ sql, params });
        return Promise.resolve(rows);
      });
  });

  const sellingRow = {
    slug: 'loja-7',
    name: 'Loja 7',
    description: null,
    logo: null,
    primary_color: null,
    address_city: 'Rio de Janeiro',
    address_state: 'RJ',
    is_open: true,
    account_status: StoreAccountStatus.ACTIVE,
    subscription_status: SubscriptionStatus.ACTIVE,
    cancel_at_period_end: false,
    current_period_end: null,
    grace_period_ends_at: null,
  };

  it('só lojas ativas com assinatura que permite vender (mesma regra de storeAccessState)', async () => {
    rows = [sellingRow];
    const page = await service.list({ page: 1, pageSize: 5 }, NOW);

    expect(page).toEqual({
      items: [
        {
          slug: 'loja-7',
          name: 'Loja 7',
          description: null,
          logo: null,
          primary_color: null,
          address_city: 'Rio de Janeiro',
          address_state: 'RJ',
          is_open: true,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 5,
    });

    const [, list] = queries;
    expect(list.sql).toContain('"store"."account_status" = $');
    expect(list.sql).toContain('"sub"."status" <> $');
    expect(list.sql).toContain(
      'NOT ("sub"."cancel_at_period_end" = true AND "sub"."current_period_end" IS NOT NULL AND "sub"."current_period_end" <= $',
    );
    expect(list.sql).toContain(
      '("sub"."grace_period_ends_at" IS NULL OR "sub"."grace_period_ends_at" > $',
    );
    expect(list.params).toEqual(
      expect.arrayContaining([
        'ACTIVE',
        'CANCELED',
        'TRIALING',
        'PAST_DUE',
        NOW,
      ]),
    );
    expect(list.sql).toContain('LIMIT 5 OFFSET 0');
    // Nunca seleciona dados internos ou segredos
    for (const column of [
      'document',
      'mp_access_token_encrypted',
      'owner_user_id',
      'status_reason',
    ]) {
      expect(list.sql).not.toContain(`"store"."${column}"`);
    }
  });

  it('busca por nome, slug, descrição ou cidade', async () => {
    await service.list({ search: 'pizza' }, NOW);
    expect(queries[1].sql).toContain('"store"."name" ILIKE $');
    expect(queries[1].sql).toContain('"store"."address_city" ILIKE $');
    expect(queries[1].params).toContain('%pizza%');
  });

  it('rede de segurança: linha que não pode vender é descartada mesmo se o SQL deixar passar', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    rows = [
      sellingRow,
      {
        ...sellingRow,
        slug: 'suspensa',
        subscription_status: SubscriptionStatus.SUSPENDED,
      },
      {
        ...sellingRow,
        slug: 'tolerancia-vencida',
        subscription_status: SubscriptionStatus.PAST_DUE,
        grace_period_ends_at: new Date('2026-10-10T00:00:00Z'),
      },
    ];
    const page = await service.list({}, NOW);
    expect(page.items.map((item) => item.slug)).toEqual(['loja-7']);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
