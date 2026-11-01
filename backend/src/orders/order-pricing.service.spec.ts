import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { FindOperator, type Repository } from 'typeorm';
import type { AddressLocationService } from '../addresses/address-location.service';
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
} from './order-pricing.service';
import {
  DELIVERY_OUT_OF_AREA_CODE,
  DELIVERY_OUT_OF_AREA_MESSAGE,
  DELIVERY_ZONES_MISSING_MESSAGE,
  DELIVERY_DISABLED_MESSAGE,
  TAKEOUT_DISABLED_MESSAGE,
} from './order-rules';
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
  const service = new OrderPricingService(
    productRepository as unknown as Repository<Product>,
    addonRepository as unknown as Repository<Addon>,
    addressRepository as unknown as Repository<Address>,
    tenants as unknown as TenantService,
    blockRepository as unknown as Repository<StoreCustomerBlock>,
    locations as unknown as AddressLocationService,
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
});
