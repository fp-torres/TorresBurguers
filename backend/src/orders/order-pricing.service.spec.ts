import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { FindOperator, type Repository } from 'typeorm';
import type { AddressGeoService } from '../addresses/address-geo.service';
import type { AddressLocationService } from '../addresses/address-location.service';
import type { GeocodingService } from '../addresses/geocoding.service';
import type { Address } from '../addresses/entities/address.entity';
import type { Addon } from '../products/entities/addon.entity';
import type { Product } from '../products/entities/product.entity';
import type { StoreCustomerBlock } from '../store/entities/store-customer-block.entity';
import { StoreAccountStatus, type Store } from '../store/entities/store.entity';
import type { TenantContext } from '../tenancy/tenant-context';
import type { TenantService } from '../tenancy/tenant.service';
import type { QuoteOrderDto } from './dto/create-order.dto';
import {
  CUSTOMER_BLOCKED_MESSAGE,
  OrderPricingService,
  toQuoteResponse,
} from './order-pricing.service';
import {
  DELIVERY_OUT_OF_AREA_CODE,
  DELIVERY_OUT_OF_AREA_MESSAGE,
  DELIVERY_ZONES_MISSING_MESSAGE,
  DELIVERY_DISABLED_MESSAGE,
  TAKEOUT_DISABLED_MESSAGE,
} from './order-rules';
import {
  ADDRESS_NOT_LOCATED_MESSAGE,
  straightDeliveryKm,
} from './delivery-distance';
import { toOrderSnapshot } from './order-snapshot';
import { OrderType } from './order.enums';

const STORE_A = 1;
const STORE_B = 2;
const CLIENT_ID = 7;

/** Igualdade, objetos aninhados e In/IsNull do TypeORM. */
function matches(row: Record<string, unknown>, where: object): boolean {
  return Object.entries(where as Record<string, unknown>).every(
    ([key, expected]) => {
      const value = row[key];
      if (expected instanceof FindOperator) {
        if (expected.type === 'in')
          return (expected.value as unknown as unknown[]).includes(value);
        if (expected.type === 'isNull')
          return value === null || value === undefined;
        throw new Error(`operador não suportado no teste: ${expected.type}`);
      }
      if (expected && typeof expected === 'object')
        return matches((value ?? {}) as Record<string, unknown>, expected);
      return value === expected;
    },
  );
}

function table<T extends object>(rows: T[]) {
  const filter = (where: object) =>
    rows.filter((row) => matches(row as Record<string, unknown>, where));
  return {
    find: jest.fn(({ where }: { where: object }) =>
      Promise.resolve(filter(where)),
    ),
    findOne: jest.fn(({ where }: { where: object }) =>
      Promise.resolve(filter(where)[0] ?? null),
    ),
    exists: jest.fn(({ where }: { where: object }) =>
      Promise.resolve(filter(where).length > 0),
    ),
  };
}

const addon = (id: number, storeId: number, name: string, price: string) =>
  ({
    id,
    store_id: storeId,
    name,
    price,
    available: true,
    deleted_at: null,
  }) as unknown as Addon;

const bacon = addon(3, STORE_A, 'Bacon', '4.00');
const cheese = addon(5, STORE_A, 'Queijo', '3.00');
const catupiryB = addon(9, STORE_B, 'Catupiry da Loja B', '5.00');

const product = (
  id: number,
  storeId: number,
  name: string,
  price: string,
  allowed: Addon[] = [],
) =>
  ({
    id,
    store_id: storeId,
    name,
    price,
    promotion_price: null,
    available: true,
    deleted_at: null,
    allowed_addons: allowed,
  }) as unknown as Product;

const trashedBacon = {
  ...addon(6, STORE_A, 'Bacon Secreto', '9.00'),
  deleted_at: new Date('2026-01-01T00:00:00Z'),
};

const products = [
  product(1, STORE_A, 'X-Bacon', '30.00', [bacon, trashedBacon]),
  product(2, STORE_A, 'Combo', '40.00', [bacon]),
  // Sem adicionais configurados: a vitrine (web e app) e o painel não oferecem nenhum
  product(3, STORE_A, 'Refrigerante lata', '6.00'),
  // Na lixeira: só a equipe conhece o nome
  {
    ...product(5, STORE_A, 'Lançamento Secreto', '25.00'),
    deleted_at: new Date('2026-01-01T00:00:00Z'),
  },
  // Vínculo inconsistente (o banco recusa; aqui só para provar a defesa extra)
  product(4, STORE_A, 'Lanche Estranho', '20.00', [catupiryB]),
  product(10, STORE_B, 'Pizza da Loja B', '50.00'),
  // Em promoção: R$ 30,00 por R$ 25,90 (o pedido mínimo e o frete grátis olham o preço cobrado)
  {
    ...product(11, STORE_A, 'Burger da Semana', '30.00'),
    promotion_price: '25.90',
  } as unknown as Product,
];

const addresses = [
  {
    id: 20,
    user: { id: CLIENT_ID },
    deleted_at: null,
    street: 'Rua dos Pinheiros',
    number: '100',
    complement: null,
    neighborhood: 'Pinheiros',
    city: 'São Paulo',
    state: 'SP',
    zipCode: '05422000',
    nickname: 'Casa',
  },
];

function storeRow(id: number, extra: Partial<Store> = {}): Store {
  return {
    id,
    slug: `loja-${id}`,
    name: `Loja ${id}`,
    account_status: StoreAccountStatus.ACTIVE,
    is_open: true,
    delivery_enabled: true,
    takeout_enabled: true,
    delivery_zones: null,
    takeout_estimate: null,
    ...extra,
  } as Store;
}

function tenant(store: Store, canSell = true): TenantContext {
  return {
    storeId: store.id,
    store,
    subscription: null,
    access: {
      availability: canSell ? 'OPERATIONAL' : 'SUSPENDED',
      canSell,
      canRead: true,
      canOperate: true,
      canManage: canSell,
      canManageBilling: true,
      publicVisible: true,
      message: canSell ? null : 'Loja suspensa.',
    },
  };
}

function setup(defaultStoreId: number | null = STORE_A) {
  const productRepository = table(products);
  const addonRepository = table([bacon, cheese, catupiryB, trashedBacon]);
  const addressRepository = table(addresses);
  const tenants = {
    defaultStore: jest
      .fn()
      .mockResolvedValue(defaultStoreId ? { id: defaultStoreId } : null),
  };
  // Bloqueios de clientes por loja (store_customer_blocks): "loja:cliente" bloqueados
  const blocked = new Set<string>();
  const blockRepository = {
    exists: jest.fn(
      ({ where }: { where: { store_id: number; user_id: number } }) =>
        Promise.resolve(blocked.has(`${where.store_id}:${where.user_id}`)),
    ),
  };
  // Conferência do CEP no orçamento (endereços antigos): devolve o endereço como está, salvo se o teste mudar
  const locations = {
    refresh: jest.fn((address: Address) => Promise.resolve(address)),
  };
  // Coordenadas do endereço (entrega por distância): devolve o endereço como está, salvo se o teste mudar
  const addressGeo = {
    refresh: jest.fn((address: Address) => Promise.resolve(address)),
  };
  // Distância por rua (Google Routes): indisponível, salvo se o teste mudar
  const geocoder = {
    roadDistanceKm: jest.fn(() => Promise.resolve(null as number | null)),
  };
  const service = new OrderPricingService(
    productRepository as unknown as Repository<Product>,
    addonRepository as unknown as Repository<Addon>,
    addressRepository as unknown as Repository<Address>,
    tenants as unknown as TenantService,
    blockRepository as unknown as Repository<StoreCustomerBlock>,
    locations as unknown as AddressLocationService,
    addressGeo as unknown as AddressGeoService,
    geocoder as unknown as GeocodingService,
  );
  return {
    service,
    productRepository,
    addonRepository,
    addressRepository,
    tenants,
    blocked,
    blockRepository,
    locations,
    addressGeo,
    geocoder,
  };
}

const takeout = (
  items: QuoteOrderDto['items'],
  extra: Partial<QuoteOrderDto> = {},
): QuoteOrderDto => ({ items, type: OrderType.TAKEOUT, ...extra });

const delivery = (addressId = 20): QuoteOrderDto => ({
  items: [{ productId: 1, quantity: 1 }],
  type: OrderType.DELIVERY,
  addressId,
});

describe('OrderPricingService (por loja)', () => {
  const saved = {
    json: process.env.DELIVERY_ZONES_JSON,
    file: process.env.DELIVERY_ZONES_FILE,
  };
  beforeAll(() => {
    // Zonas padrão da plataforma (delivery-zones.config.ts), independentes do ambiente
    delete process.env.DELIVERY_ZONES_JSON;
    delete process.env.DELIVERY_ZONES_FILE;
  });
  afterAll(() => {
    if (saved.json !== undefined) process.env.DELIVERY_ZONES_JSON = saved.json;
    if (saved.file !== undefined) process.env.DELIVERY_ZONES_FILE = saved.file;
  });

  describe('cliente bloqueado pela loja (store_customer_blocks)', () => {
    it('recusa com 403 genérico antes de consultar o cardápio (orçamento, pedido e cobranças usam este cálculo)', async () => {
      const { service, blocked, blockRepository, productRepository } = setup();
      blocked.add(`${STORE_A}:${CLIENT_ID}`);
      const failure = service.price(
        takeout([{ productId: 1, quantity: 1 }]),
        CLIENT_ID,
        tenant(storeRow(STORE_A)),
      );
      await expect(failure).rejects.toThrow(
        new ForbiddenException(CUSTOMER_BLOCKED_MESSAGE),
      );
      expect(CUSTOMER_BLOCKED_MESSAGE).toBe(
        'Não é possível fazer pedidos nesta loja. Fale com a loja.',
      );
      expect(blockRepository.exists).toHaveBeenCalledWith({
        where: { store_id: STORE_A, user_id: CLIENT_ID },
      });
      expect(productRepository.find).not.toHaveBeenCalled();
    });

    it('o bloqueio vale só na loja que bloqueou: o mesmo cliente compra nas outras', async () => {
      const { service, blocked } = setup();
      blocked.add(`${STORE_A}:${CLIENT_ID}`);
      const priced = await service.price(
        takeout([{ productId: 10, quantity: 1 }]),
        CLIENT_ID,
        tenant(storeRow(STORE_B)),
      );
      expect(priced.storeId).toBe(STORE_B);
      // Outro cliente na loja que bloqueou também segue normal
      await expect(
        service.price(
          takeout([{ productId: 1, quantity: 1 }]),
          CLIENT_ID + 1,
          tenant(storeRow(STORE_A)),
        ),
      ).resolves.toMatchObject({ storeId: STORE_A });
    });

    it('pagamento já aprovado (alreadyPaid): o bloqueio não impede o pedido', async () => {
      const { service, blocked, blockRepository } = setup();
      blocked.add(`${STORE_A}:${CLIENT_ID}`);
      const priced = await service.price(
        takeout([{ productId: 1, quantity: 1 }]),
        CLIENT_ID,
        tenant(storeRow(STORE_A)),
        { alreadyPaid: true },
      );
      expect(priced.storeId).toBe(STORE_A);
      expect(blockRepository.exists).not.toHaveBeenCalled();
    });
  });

  it('calcula com o cardápio da loja e guarda a loja no orçamento e no retrato', async () => {
    const { service, productRepository } = setup();
    const priced = await service.price(
      takeout([{ productId: 1, quantity: 2, addonIds: [3, 3] }]),
      CLIENT_ID,
      tenant(storeRow(STORE_A)),
    );
    expect(priced).toMatchObject({
      storeId: STORE_A,
      subtotal: 76,
      total: 76,
      store_open: true,
    });
    expect(toOrderSnapshot(priced).storeId).toBe(STORE_A);
    expect(productRepository.find.mock.calls[0][0].where).toMatchObject({
      store_id: STORE_A,
    });
  });

  it('produto de outra loja → "Produto #id não encontrado." (igual a um id inexistente, sem citar o nome)', async () => {
    const { service } = setup();
    for (const productId of [10, 999]) {
      const failure = service.price(
        takeout([{ productId, quantity: 1 }]),
        CLIENT_ID,
        tenant(storeRow(STORE_A)),
      );
      await expect(failure).rejects.toThrow(
        new BadRequestException(`Produto #${productId} não encontrado.`),
      );
    }
    await expect(
      service.price(
        takeout([{ productId: 10, quantity: 1 }]),
        CLIENT_ID,
        tenant(storeRow(STORE_A)),
      ),
    ).rejects.not.toThrow(/Pizza/);
    // Na loja dona, o mesmo produto vale
    await expect(
      service.price(
        takeout([{ productId: 10, quantity: 1 }]),
        CLIENT_ID,
        tenant(storeRow(STORE_B)),
      ),
    ).resolves.toMatchObject({ storeId: STORE_B, total: 50 });
  });

  it('adicional de outra loja → "Adicional #id não encontrado."; vínculo permitido de outra loja não libera nada', async () => {
    const { service, addonRepository } = setup();
    const storeA = tenant(storeRow(STORE_A));
    await expect(
      service.price(
        takeout([{ productId: 1, quantity: 1, addonIds: [9] }]),
        CLIENT_ID,
        storeA,
      ),
    ).rejects.toThrow('Adicional #9 não encontrado.');
    expect(addonRepository.find.mock.calls[0][0].where).toMatchObject({
      store_id: STORE_A,
    });

    // O produto 4 só "permite" um adicional da loja B: para a loja A, ele não aceita adicionais
    await expect(
      service.price(
        takeout([{ productId: 4, quantity: 1, addonIds: [3] }]),
        CLIENT_ID,
        storeA,
      ),
    ).rejects.toThrow('O produto "Lanche Estranho" não aceita adicionais.');
    // Com lista, só os adicionais dela
    await expect(
      service.price(
        takeout([{ productId: 2, quantity: 1, addonIds: [5] }]),
        CLIENT_ID,
        storeA,
      ),
    ).rejects.toThrow('não pode ser adicionado');
    await expect(
      service.price(
        takeout([{ productId: 2, quantity: 1, addonIds: [3] }]),
        CLIENT_ID,
        storeA,
      ),
    ).resolves.toMatchObject({ total: 44 });
  });

  it('produto sem adicionais configurados não aceita nenhum (como a vitrine e o painel)', async () => {
    const { service } = setup();
    const storeA = tenant(storeRow(STORE_A));
    await expect(
      service.price(
        takeout([{ productId: 3, quantity: 1, addonIds: [3, 3, 5] }]),
        CLIENT_ID,
        storeA,
      ),
    ).rejects.toThrow('O produto "Refrigerante lata" não aceita adicionais.');
    // Sem adicionais, o produto continua vendendo normalmente
    await expect(
      service.price(
        takeout([{ productId: 3, quantity: 2 }]),
        CLIENT_ID,
        storeA,
      ),
    ).resolves.toMatchObject({ total: 12 });
  });

  it('produto e adicional da lixeira respondem como id inexistente (sem revelar o nome)', async () => {
    const { service, productRepository, addonRepository } = setup();
    const storeA = tenant(storeRow(STORE_A));
    const trashedProduct = service.price(
      takeout([{ productId: 5, quantity: 1 }]),
      CLIENT_ID,
      storeA,
    );
    await expect(trashedProduct).rejects.toBeInstanceOf(BadRequestException);
    await expect(trashedProduct).rejects.toThrow('Produto #5 não encontrado.');
    await expect(trashedProduct).rejects.not.toThrow('Lançamento Secreto');

    const trashedAddon = service.price(
      takeout([{ productId: 1, quantity: 1, addonIds: [6] }]),
      CLIENT_ID,
      storeA,
    );
    await expect(trashedAddon).rejects.toThrow('Adicional #6 não encontrado.');
    await expect(trashedAddon).rejects.not.toThrow('Bacon Secreto');

    // A consulta nem carrega a lixeira
    for (const repository of [productRepository, addonRepository]) {
      for (const [options] of repository.find.mock.calls as [
        { withDeleted?: boolean },
      ][])
        expect(options.withDeleted).toBeUndefined();
    }
  });

  it('loja aberta = aberta pela equipe E podendo vender (situação da conta e da assinatura)', async () => {
    const { service } = setup();
    const dto = takeout([{ productId: 1, quantity: 1 }]);
    const open = (input: TenantContext | Store) =>
      service.price(dto, CLIENT_ID, input).then((p) => p.store_open);

    expect(await open(tenant(storeRow(STORE_A)))).toBe(true);
    expect(await open(tenant(storeRow(STORE_A, { is_open: false })))).toBe(
      false,
    );
    expect(await open(tenant(storeRow(STORE_A), false))).toBe(false);
    // Só a entidade (sem o contexto): vale a situação da conta
    expect(await open(storeRow(STORE_A))).toBe(true);
    expect(
      await open(
        storeRow(STORE_A, { account_status: StoreAccountStatus.SUSPENDED }),
      ),
    ).toBe(false);
  });

  it('entrega ou retirada desligada na loja → 400 antes de consultar o cardápio', async () => {
    const { service, productRepository } = setup();
    await expect(
      service.price(
        delivery(),
        CLIENT_ID,
        tenant(storeRow(STORE_A, { delivery_enabled: false })),
      ),
    ).rejects.toThrow(new BadRequestException(DELIVERY_DISABLED_MESSAGE));
    await expect(
      service.price(
        takeout([{ productId: 1, quantity: 1 }]),
        CLIENT_ID,
        tenant(storeRow(STORE_A, { takeout_enabled: false })),
      ),
    ).rejects.toThrow(new BadRequestException(TAKEOUT_DISABLED_MESSAGE));
    expect(productRepository.find).not.toHaveBeenCalled();
  });

  it('zonas de entrega da loja substituem as da plataforma; sem zonas próprias, as da plataforma', async () => {
    const { service } = setup();
    const own = storeRow(STORE_A, {
      delivery_zones: {
        fallback: { fee: 12, time: '50 min' },
        zones: [{ neighborhoods: ['Pinheiros'], fee: 6.5, time: '25 min' }],
      },
    });
    await expect(
      service.price(delivery(), CLIENT_ID, tenant(own)),
    ).resolves.toMatchObject({
      delivery_fee: 6.5,
      total: 36.5,
      estimated_delivery_time: '25 min',
    });
    // Sem zonas próprias: padrão da plataforma (Pinheiros não está nele → faixa padrão)
    await expect(
      service.price(delivery(), CLIENT_ID, tenant(storeRow(STORE_A))),
    ).resolves.toMatchObject({
      delivery_fee: 15,
      estimated_delivery_time: '50-60 min',
    });
  });

  it('loja que não é a padrão e não configurou zonas: entrega recusada (as zonas da plataforma não valem para ela)', async () => {
    const { service, tenants } = setup(STORE_A);
    await expect(
      service.price(delivery(), CLIENT_ID, tenant(storeRow(STORE_B))),
    ).rejects.toThrow(new BadRequestException(DELIVERY_ZONES_MISSING_MESSAGE));
    expect(tenants.defaultStore).toHaveBeenCalled();
    // Retirada continua liberada
    await expect(
      service.price(
        takeout([{ productId: 10, quantity: 1 }]),
        CLIENT_ID,
        tenant(storeRow(STORE_B)),
      ),
    ).resolves.toMatchObject({ delivery_fee: 0 });
  });

  it('zonas inválidas gravadas na loja não derrubam o orçamento: valem as da plataforma', async () => {
    const { service } = setup();
    const broken = storeRow(STORE_A, {
      delivery_zones: { zones: 'Pinheiros' } as never,
    });
    await expect(
      service.price(delivery(), CLIENT_ID, tenant(broken)),
    ).resolves.toMatchObject({ delivery_fee: 15 });
  });

  it('retirada: prazo da loja (takeout_estimate) ou o padrão, sem taxa', async () => {
    const { service } = setup();
    const dto = takeout([{ productId: 1, quantity: 1 }]);
    await expect(
      service.price(
        dto,
        CLIENT_ID,
        tenant(storeRow(STORE_A, { takeout_estimate: '5-10 min' })),
      ),
    ).resolves.toMatchObject({
      delivery_fee: 0,
      estimated_delivery_time: '5-10 min',
    });
    await expect(
      service.price(dto, CLIENT_ID, tenant(storeRow(STORE_A))),
    ).resolves.toMatchObject({ estimated_delivery_time: '15-20 min' });
  });

  describe('área de entrega: bairro pelo CEP, faixas de CEP e recusa fora das zonas', () => {
    const zones = {
      fallback: { fee: 12, time: '50 min' },
      zones: [
        { neighborhoods: ['Pinheiros'], fee: 6.5, time: '25 min' },
        { neighborhoods: ['Vila Madalena'], fee: 9, time: '35 min' },
      ],
    };
    const refusing = storeRow(STORE_A, {
      delivery_zones: { ...zones, outside_zones: 'refuse' },
    });
    /** O orçamento confere o CEP: o endereço volta com o bairro canônico informado. */
    const conferred = (
      locations: { refresh: jest.Mock },
      fields: Partial<Address>,
    ) =>
      locations.refresh.mockImplementation((address: Address) =>
        Promise.resolve({ ...address, ...fields }),
      );

    it('confere o CEP do endereço no orçamento de entrega (endereços antigos), nunca na retirada', async () => {
      const { service, locations } = setup();
      await service.price(delivery(), CLIENT_ID, tenant(storeRow(STORE_A)));
      expect(locations.refresh).toHaveBeenCalledWith(
        expect.objectContaining({ id: 20, zipCode: '05422000' }),
      );
      locations.refresh.mockClear();
      await service.price(
        takeout([{ productId: 1, quantity: 1 }]),
        CLIENT_ID,
        tenant(storeRow(STORE_A)),
      );
      expect(locations.refresh).not.toHaveBeenCalled();
    });

    it('bairro digitado errado: a zona vem do bairro do CEP (canônico)', async () => {
      const { service, locations } = setup();
      // Digitou "Pinheiros" (zona de R$ 6,50), mas o CEP é da Vila Madalena (R$ 9,00)
      conferred(locations, {
        canonical_neighborhood: 'Vila Madalena',
        canonical_city: 'São Paulo',
        neighborhood_source: 'CEP',
        cep_status: 'FOUND',
      });
      const own = storeRow(STORE_A, { delivery_zones: zones });
      await expect(
        service.price(delivery(), CLIENT_ID, tenant(own)),
      ).resolves.toMatchObject({
        delivery_fee: 9,
        estimated_delivery_time: '35 min',
        total: 39,
      });
    });

    it('CEP sem bairro, inexistente ou serviço fora do ar: vale o bairro digitado', async () => {
      const { service, locations } = setup();
      conferred(locations, {
        canonical_neighborhood: null,
        canonical_city: 'São Paulo',
        neighborhood_source: 'MANUAL',
        cep_status: 'NO_NEIGHBORHOOD',
      });
      const own = storeRow(STORE_A, { delivery_zones: zones });
      await expect(
        service.price(delivery(), CLIENT_ID, tenant(own)),
      ).resolves.toMatchObject({ delivery_fee: 6.5 });
    });

    it('política padrão (sem outside_zones ou "fallback"): fora das zonas paga a faixa padrão', async () => {
      const { service, locations } = setup();
      conferred(locations, {
        canonical_neighborhood: 'Butantã',
        neighborhood_source: 'CEP',
        cep_status: 'FOUND',
      });
      for (const delivery_zones of [
        zones,
        { ...zones, outside_zones: 'fallback' as const },
      ]) {
        await expect(
          service.price(
            delivery(),
            CLIENT_ID,
            tenant(storeRow(STORE_A, { delivery_zones })),
          ),
        ).resolves.toMatchObject({
          delivery_fee: 12,
          estimated_delivery_time: '50 min',
        });
      }
    });

    it('loja que recusa fora das zonas: 400 com mensagem clara e code, antes de olhar os itens', async () => {
      const { service, locations } = setup();
      conferred(locations, {
        canonical_neighborhood: 'Butantã',
        neighborhood_source: 'CEP',
        cep_status: 'FOUND',
      });
      const failure = await service
        .price(
          { ...delivery(), items: [{ productId: 999, quantity: 1 }] },
          CLIENT_ID,
          tenant(refusing),
        )
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(BadRequestException);
      expect((failure as BadRequestException).getResponse()).toEqual({
        statusCode: 400,
        message: DELIVERY_OUT_OF_AREA_MESSAGE,
        error: 'Bad Request',
        code: DELIVERY_OUT_OF_AREA_CODE,
      });
      expect(DELIVERY_OUT_OF_AREA_MESSAGE).toBe(
        'Este endereço está fora da área de entrega da loja.',
      );

      // Dentro da zona (pelo bairro do CEP), a mesma loja entrega
      conferred(locations, {
        canonical_neighborhood: 'Pinheiros',
        neighborhood_source: 'CEP',
        cep_status: 'FOUND',
      });
      await expect(
        service.price(delivery(), CLIENT_ID, tenant(refusing)),
      ).resolves.toMatchObject({ delivery_fee: 6.5 });
      // Retirada não depende da área
      await expect(
        service.price(
          takeout([{ productId: 1, quantity: 1 }]),
          CLIENT_ID,
          tenant(refusing),
        ),
      ).resolves.toMatchObject({ delivery_fee: 0 });
    });

    it('pagamento já aprovado (alreadyPaid) não é recusado: o endereço fora das zonas paga o fallback', async () => {
      const { service, locations } = setup();
      conferred(locations, {
        canonical_neighborhood: 'Butantã',
        neighborhood_source: 'CEP',
        cep_status: 'FOUND',
      });
      await expect(
        service.price(delivery(), CLIENT_ID, tenant(refusing), {
          alreadyPaid: true,
        }),
      ).resolves.toMatchObject({ delivery_fee: 12, total: 42 });

      // Recusa sem "fallback" gravado: vale o "fallback" da plataforma
      const { fallback: _ignored, ...withoutFallback } = zones;
      void _ignored;
      await expect(
        service.price(
          delivery(),
          CLIENT_ID,
          tenant(
            storeRow(STORE_A, {
              delivery_zones: { ...withoutFallback, outside_zones: 'refuse' },
            }),
          ),
          { alreadyPaid: true },
        ),
      ).resolves.toMatchObject({ delivery_fee: 15 });
    });

    it('zona por faixa de CEP: vale mesmo sem o bairro na lista (e em qualquer cidade)', async () => {
      const { service } = setup();
      const byZip = storeRow(STORE_A, {
        delivery_zones: {
          zones: [
            {
              neighborhoods: [],
              zip_ranges: [{ from: '05400000', to: '05499999' }],
              fee: 4,
              time: '20 min',
            },
          ],
          outside_zones: 'refuse',
        },
      });
      // Endereço com CEP 05422000 (não conferido): cai na faixa
      await expect(
        service.price(delivery(), CLIENT_ID, tenant(byZip)),
      ).resolves.toMatchObject({
        delivery_fee: 4,
        estimated_delivery_time: '20 min',
      });
    });
  });

  it('entrega só para endereço do próprio cliente (endereços são globais; de outro cliente → 404)', async () => {
    const { service, addressRepository } = setup();
    await expect(
      service.price(delivery(), 8, tenant(storeRow(STORE_A))),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(addressRepository.findOne.mock.calls[0][0].where).toMatchObject({
      id: 20,
      user: { id: 8 },
    });
  });

  it('referências ainda existentes (pagamento aprovado depois): só produtos e adicionais da loja do pedido', async () => {
    const { service } = setup();
    const references = await service.existingReferences({
      storeId: STORE_A,
      productIds: [1, 10, 999],
      addonIds: [3, 9],
      addressId: 20,
      userId: CLIENT_ID,
    });
    expect([...references.productIds]).toEqual([1]);
    expect([...references.addonIds]).toEqual([3]);
    expect(references.addressExists).toBe(true);

    // Endereço de outro cliente não é ligado ao pedido
    const stranger = await service.existingReferences({
      storeId: STORE_A,
      productIds: [],
      addonIds: [],
      addressId: 20,
      userId: 8,
    });
    expect(stranger.addressExists).toBe(false);
  });

  describe('pedido mínimo e frete grátis (no JSON de entrega da loja)', () => {
    /** Pinheiros (o endereço 20) na zona 1, com taxa de R$ 7,00; fora das zonas, R$ 12,00. */
    const rulesStore = (
      rules: Record<string, unknown> = {},
      zoneRules: Record<string, unknown> = {},
    ) =>
      storeRow(STORE_A, {
        delivery_zones: {
          fallback: { fee: 12, time: '50 min' },
          zones: [
            {
              neighborhoods: ['Pinheiros'],
              fee: 7,
              time: '25 min',
              ...zoneRules,
            },
          ],
          ...rules,
        },
      });
    /** Entrega no endereço 20 com os itens informados. */
    const deliver = (items: QuoteOrderDto['items']): QuoteOrderDto => ({
      items,
      type: OrderType.DELIVERY,
      addressId: 20,
    });
    // X-Bacon: R$ 30,00; Refrigerante: R$ 6,00; Burger da Semana: R$ 25,90 (promoção de R$ 30,00)
    const promo = [{ productId: 11, quantity: 1 }];

    async function belowMinimum(promise: Promise<unknown>) {
      const error = await promise.then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(BadRequestException);
      return (error as BadRequestException).getResponse();
    }

    it('nada configurado: mesmos valores de antes e o orçamento informa só nulos', async () => {
      const { service } = setup();
      const priced = await service.price(
        deliver(promo),
        CLIENT_ID,
        tenant(rulesStore()),
      );
      expect(priced).toMatchObject({
        subtotal: 25.9,
        delivery_fee: 7,
        total: 32.9,
      });
      expect(toQuoteResponse(priced)).toMatchObject({
        delivery_fee: 7,
        delivery_fee_original: 7,
        free_delivery_applied: false,
        free_delivery_threshold: null,
        missing_for_free_delivery: null,
        min_order_value: null,
        missing_for_min_order: null,
      });
    });

    it('orçamento abaixo do mínimo NÃO falha: informa o mínimo e quanto falta (com a promoção)', async () => {
      const { service } = setup();
      const priced = await service.price(
        deliver(promo),
        CLIENT_ID,
        tenant(rulesStore({ min_order: 30 })),
        { allowBelowMinimum: true },
      );
      expect(toQuoteResponse(priced)).toMatchObject({
        subtotal: 25.9,
        delivery_fee: 7,
        total: 32.9,
        min_order_value: 30,
        missing_for_min_order: 4.1,
      });
    });

    it('pedido e cobranças abaixo do mínimo → 400 ORDER_BELOW_MINIMUM com mensagem clara', async () => {
      const { service } = setup();
      const body = await belowMinimum(
        service.price(
          deliver(promo),
          CLIENT_ID,
          tenant(rulesStore({ min_order: 30 })),
        ),
      );
      expect(body).toEqual({
        statusCode: 400,
        message:
          'O pedido mínimo desta loja para entrega é R$ 30,00. Faltam R$ 4,10.',
        error: 'Bad Request',
        code: 'ORDER_BELOW_MINIMUM',
        min_order_value: 30,
        missing_for_min_order: 4.1,
      });
    });

    it('no limite exato passa; pagamento já aprovado nunca é recusado', async () => {
      const { service } = setup();
      await expect(
        service.price(
          deliver([{ productId: 1, quantity: 1 }]),
          CLIENT_ID,
          tenant(rulesStore({ min_order: 30 })),
        ),
      ).resolves.toMatchObject({ subtotal: 30, total: 37 });
      await expect(
        service.price(
          deliver(promo),
          CLIENT_ID,
          tenant(rulesStore({ min_order: 30 })),
          { alreadyPaid: true },
        ),
      ).resolves.toMatchObject({ subtotal: 25.9, total: 32.9 });
    });

    it('frete grátis zera a taxa no total e no retrato do pedido (valor cobrado)', async () => {
      const { service } = setup();
      const store = tenant(rulesStore({ free_delivery_above: 36 }));
      const below = await service.price(
        deliver([
          { productId: 1, quantity: 1 },
          { productId: 3, quantity: 1 },
        ]),
        CLIENT_ID,
        store,
      );
      // R$ 36,00 exatos: grátis
      expect(below).toMatchObject({ subtotal: 36, delivery_fee: 0, total: 36 });
      expect(toOrderSnapshot(below)).toMatchObject({
        deliveryFee: 0,
        total: 36,
      });
      expect(toQuoteResponse(below)).toMatchObject({
        delivery_fee: 0,
        delivery_fee_original: 7,
        free_delivery_applied: true,
        free_delivery_threshold: 36,
        missing_for_free_delivery: 0,
      });
      // Com a promoção (R$ 25,90), não chega: a taxa continua e o orçamento diz quanto falta
      const promoQuote = toQuoteResponse(
        await service.price(deliver(promo), CLIENT_ID, store),
      );
      expect(promoQuote).toMatchObject({
        delivery_fee: 7,
        total: 32.9,
        free_delivery_applied: false,
        missing_for_free_delivery: 10.1,
      });
    });

    it('a zona sobrescreve a loja; fora das zonas valem os da loja', async () => {
      const { service, addressRepository } = setup();
      const store = tenant(
        rulesStore(
          { min_order: 20, free_delivery_above: 100 },
          { min_order: 40, free_delivery_above: 30 },
        ),
      );
      // Pinheiros (zona): mínimo 40, grátis a partir de 30
      const zoneBody = await belowMinimum(
        service.price(
          deliver([{ productId: 1, quantity: 1 }]),
          CLIENT_ID,
          store,
        ),
      );
      expect(zoneBody).toMatchObject({
        message:
          'O pedido mínimo desta loja para entrega é R$ 40,00. Faltam R$ 10,00.',
      });
      await expect(
        service.price(
          deliver([{ productId: 2, quantity: 1 }]),
          CLIENT_ID,
          store,
        ),
      ).resolves.toMatchObject({ subtotal: 40, delivery_fee: 0, total: 40 });

      // Outro bairro (fora das zonas: fallback de R$ 12,00): mínimo 20, grátis a partir de 100
      addressRepository.findOne.mockResolvedValueOnce({
        ...addresses[0],
        neighborhood: 'Butantã',
      });
      await expect(
        service.price(
          deliver([{ productId: 1, quantity: 1 }]),
          CLIENT_ID,
          store,
        ),
      ).resolves.toMatchObject({ subtotal: 30, delivery_fee: 12, total: 42 });
    });

    it('retirada: o mínimo só vale com min_order_takeout; nunca há taxa', async () => {
      const { service } = setup();
      const dto = takeout(promo);
      await expect(
        service.price(dto, CLIENT_ID, tenant(rulesStore({ min_order: 30 }))),
      ).resolves.toMatchObject({ subtotal: 25.9, delivery_fee: 0 });
      const body = await belowMinimum(
        service.price(
          dto,
          CLIENT_ID,
          tenant(rulesStore({ min_order: 30, min_order_takeout: true })),
        ),
      );
      expect(body).toMatchObject({
        code: 'ORDER_BELOW_MINIMUM',
        message:
          'O pedido mínimo desta loja para retirada é R$ 30,00. Faltam R$ 4,10.',
      });
    });

    it('zonas da plataforma (loja padrão sem zonas próprias) não têm pedido mínimo nem frete grátis', async () => {
      const previous = process.env.DELIVERY_ZONES_JSON;
      process.env.DELIVERY_ZONES_JSON = JSON.stringify({
        fallback: { fee: 9, time: '45 min' },
        zones: [],
        min_order: 500,
        free_delivery_above: 1,
      });
      try {
        const { service } = setup(STORE_A);
        await expect(
          service.price(deliver(promo), CLIENT_ID, tenant(storeRow(STORE_A))),
        ).resolves.toMatchObject({ delivery_fee: 9, total: 34.9 });
      } finally {
        if (previous === undefined) delete process.env.DELIVERY_ZONES_JSON;
        else process.env.DELIVERY_ZONES_JSON = previous;
      }
    });
  });

  describe('entrega por distância (faixas de km a partir do local da loja)', () => {
    /** Loja na Av. Paulista; o cliente fica "km" quilômetros ao norte, em linha reta. */
    const ORIGIN = { lat: -23.5617, lng: -46.656 };
    const north = (km: number) => ({
      geo_latitude: ORIGIN.lat + km / 111.19492664,
      geo_longitude: ORIGIN.lng,
      geo_status: 'FOUND' as const,
    });
    const DISTANCE = {
      bands: [
        { up_to_km: 2, fee: 5, time: '25-35 min' },
        { up_to_km: 5, fee: 8, time: '35-45 min', min_order: 40 },
        { up_to_km: 8, fee: 12, time: '45-55 min', free_delivery_above: 25 },
      ],
      route_factor: 1.3,
    };
    const distanceStore = (
      extra: Record<string, unknown> = {},
      distance: Record<string, unknown> = {},
      location: Partial<Store> = {
        latitude: ORIGIN.lat,
        longitude: ORIGIN.lng,
      },
    ) =>
      storeRow(STORE_A, {
        ...location,
        delivery_zones: {
          // As zonas continuam guardadas, mas não valem no modo distância
          zones: [{ neighborhoods: ['Pinheiros'], fee: 1, time: '5 min' }],
          fallback: { fee: 15, time: '60-70 min' },
          mode: 'distance',
          distance: { ...DISTANCE, ...distance },
          ...extra,
        } as Store['delivery_zones'],
      });
    const locate = (
      addressGeo: { refresh: jest.Mock },
      fields: Partial<Address>,
    ) =>
      addressGeo.refresh.mockImplementation((address: Address) =>
        Promise.resolve({ ...address, ...fields }),
      );
    async function rejection(promise: Promise<unknown>) {
      const error = await promise.then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(BadRequestException);
      return (error as BadRequestException).getResponse() as Record<
        string,
        unknown
      >;
    }

    it('a faixa da distância (linha reta × fator 1,3) define taxa e prazo; o orçamento traz delivery_mode e distance_km', async () => {
      const { service, addressGeo, locations } = setup();
      locate(addressGeo, north(1)); // 1 km em linha reta → 1,3 km
      const priced = await service.price(
        delivery(),
        CLIENT_ID,
        tenant(distanceStore()),
      );
      expect(priced).toMatchObject({
        delivery_fee: 5,
        estimated_delivery_time: '25-35 min',
        total: 35,
        delivery: { mode: 'distance', distanceKm: 1.3 },
      });
      expect(addressGeo.refresh).toHaveBeenCalledWith(
        expect.objectContaining({ id: 20 }),
      );
      // A conferência do CEP continua (o bairro canônico segue no endereço)
      expect(locations.refresh).toHaveBeenCalled();
      expect(toQuoteResponse(priced)).toMatchObject({
        delivery_fee: 5,
        delivery_mode: 'distance',
        distance_km: 1.3,
      });
    });

    it('limites inclusivos e fator configurável: 2,0 km cabe em "até 2 km"; fator 1 = linha reta', async () => {
      const { service, addressGeo } = setup();
      locate(addressGeo, north(2));
      await expect(
        service.price(
          delivery(),
          CLIENT_ID,
          tenant(distanceStore({}, { route_factor: 1 })),
        ),
      ).resolves.toMatchObject({
        delivery_fee: 5,
        delivery: { distanceKm: 2 },
      });
      // Mesmo ponto com o fator padrão: 2,6 km → faixa 2 (pedido mínimo de R$ 40 > R$ 30)
      expect(
        straightDeliveryKm(ORIGIN, {
          lat: north(2).geo_latitude,
          lng: ORIGIN.lng,
        }),
      ).toBe(2.6);
      await expect(
        service.price(delivery(), CLIENT_ID, tenant(distanceStore()), {
          allowBelowMinimum: true,
        }),
      ).resolves.toMatchObject({
        delivery_fee: 8,
        delivery: { distanceKm: 2.6 },
      });
    });

    it('pedido mínimo e frete grátis próprios da faixa', async () => {
      const { service, addressGeo } = setup();
      locate(addressGeo, north(3)); // 3,9 km → faixa 2 (mínimo R$ 40)
      const body = await rejection(
        service.price(delivery(), CLIENT_ID, tenant(distanceStore())),
      );
      expect(body).toMatchObject({
        code: 'ORDER_BELOW_MINIMUM',
        min_order_value: 40,
        missing_for_min_order: 10,
      });
      // O orçamento não recusa: mostra quanto falta
      await expect(
        service.price(delivery(), CLIENT_ID, tenant(distanceStore()), {
          allowBelowMinimum: true,
        }),
      ).resolves.toMatchObject({
        delivery_fee: 8,
        rules: { minOrderCents: 4000, missingForMinOrderCents: 1000 },
      });
      // 6,5 km → faixa 3, frete grátis a partir de R$ 25 (o X-Bacon custa R$ 30)
      locate(addressGeo, north(5));
      await expect(
        service.price(delivery(), CLIENT_ID, tenant(distanceStore())),
      ).resolves.toMatchObject({
        delivery_fee: 0,
        total: 30,
        rules: { originalFeeCents: 1200, freeDeliveryApplied: true },
      });
    });

    it('taxa por km adicional além da última faixa, até o raio máximo (com as regras da última faixa)', async () => {
      const { service, addressGeo } = setup();
      const store = distanceStore({}, { max_km: 12, extra_km_fee: 1.5 });
      locate(addressGeo, north(7.3)); // 9,5 km → 2 km além de 8 → 12 + 2 × 1,50 = 15
      await expect(
        service.price(delivery(), CLIENT_ID, tenant(store)),
      ).resolves.toMatchObject({
        // frete grátis da última faixa (a partir de R$ 25) vale também no km adicional
        delivery_fee: 0,
        rules: { originalFeeCents: 1500 },
        estimated_delivery_time: '45-55 min',
        delivery: { distanceKm: 9.5 },
      });
    });

    it('além do raio: taxa padrão ("fallback") ou recusa; pagamento já aprovado nunca é recusado', async () => {
      const { service, addressGeo } = setup();
      locate(addressGeo, north(10)); // 13 km
      await expect(
        service.price(delivery(), CLIENT_ID, tenant(distanceStore())),
      ).resolves.toMatchObject({
        delivery_fee: 15,
        estimated_delivery_time: '60-70 min',
        delivery: { mode: 'distance', distanceKm: 13 },
      });
      const refusing = distanceStore({ outside_zones: 'refuse' });
      const body = await rejection(
        service.price(delivery(), CLIENT_ID, tenant(refusing)),
      );
      expect(body).toEqual({
        statusCode: 400,
        message: DELIVERY_OUT_OF_AREA_MESSAGE,
        error: 'Bad Request',
        code: DELIVERY_OUT_OF_AREA_CODE,
      });
      await expect(
        service.price(delivery(), CLIENT_ID, tenant(refusing), {
          alreadyPaid: true,
        }),
      ).resolves.toMatchObject({ delivery_fee: 15 });
    });

    it('endereço não localizado (provedores sem resposta): política de fora da área, com o motivo na recusa', async () => {
      const { service, addressGeo } = setup();
      locate(addressGeo, {
        geo_latitude: null,
        geo_longitude: null,
        geo_status: 'UNAVAILABLE',
      });
      await expect(
        service.price(delivery(), CLIENT_ID, tenant(distanceStore())),
      ).resolves.toMatchObject({
        delivery_fee: 15,
        delivery: { mode: 'distance', distanceKm: null },
      });
      const body = await rejection(
        service.price(
          delivery(),
          CLIENT_ID,
          tenant(distanceStore({ outside_zones: 'refuse' })),
        ),
      );
      expect(body).toMatchObject({
        code: DELIVERY_OUT_OF_AREA_CODE,
        reason: 'ADDRESS_NOT_LOCATED',
        message: ADDRESS_NOT_LOCATED_MESSAGE,
      });
    });

    it('loja sem local no mapa: não localiza o endereço e vale a política de fora da área', async () => {
      const { service, addressGeo } = setup();
      const store = distanceStore({}, {}, { latitude: null, longitude: null });
      await expect(
        service.price(delivery(), CLIENT_ID, tenant(store)),
      ).resolves.toMatchObject({ delivery_fee: 15 });
      expect(addressGeo.refresh).not.toHaveBeenCalled();
    });

    it('distância por rua (quando a loja pede): usada sem o fator; sem resposta, volta para a linha reta', async () => {
      const { service, addressGeo, geocoder } = setup();
      locate(addressGeo, north(1)); // linha reta: 1,3 km (faixa 1)
      geocoder.roadDistanceKm.mockResolvedValueOnce(4.2);
      const store = distanceStore({}, { road_distance: true });
      await expect(
        service.price(delivery(), CLIENT_ID, tenant(store), {
          allowBelowMinimum: true,
        }),
      ).resolves.toMatchObject({
        delivery_fee: 8,
        delivery: { distanceKm: 4.2 },
      });
      await expect(
        service.price(delivery(), CLIENT_ID, tenant(store)),
      ).resolves.toMatchObject({
        delivery_fee: 5,
        delivery: { distanceKm: 1.3 },
      });
      expect(geocoder.roadDistanceKm).toHaveBeenCalledTimes(2);
    });

    it('padrão (modo por zonas) e retirada: nada é localizado e o orçamento traz delivery_mode "zones" / null', async () => {
      const { service, addressGeo, geocoder } = setup();
      const zones = storeRow(STORE_A, {
        latitude: ORIGIN.lat,
        longitude: ORIGIN.lng,
        delivery_zones: {
          zones: [{ neighborhoods: ['Pinheiros'], fee: 6, time: '25 min' }],
          fallback: { fee: 12, time: '50 min' },
          // Faixas guardadas para depois: no modo por zonas, não valem
          distance: DISTANCE,
        } as Store['delivery_zones'],
      });
      const priced = await service.price(delivery(), CLIENT_ID, tenant(zones));
      expect(toQuoteResponse(priced)).toMatchObject({
        delivery_fee: 6,
        delivery_mode: 'zones',
        distance_km: null,
      });
      const pickup = await service.price(
        takeout([{ productId: 1, quantity: 1 }]),
        CLIENT_ID,
        tenant(distanceStore()),
      );
      expect(toQuoteResponse(pickup)).toMatchObject({
        delivery_fee: 0,
        delivery_mode: null,
        distance_km: null,
      });
      expect(addressGeo.refresh).not.toHaveBeenCalled();
      expect(geocoder.roadDistanceKm).not.toHaveBeenCalled();
    });

    it('configuração de distância gravada inválida: cobra pelas zonas guardadas (nunca derruba o pedido)', async () => {
      const { service, addressGeo } = setup();
      const broken = distanceStore({}, { bands: [] });
      await expect(
        service.price(delivery(), CLIENT_ID, tenant(broken)),
      ).resolves.toMatchObject({
        delivery_fee: 1,
        delivery: { mode: 'zones' },
      });
      expect(addressGeo.refresh).not.toHaveBeenCalled();
    });
  });
});
