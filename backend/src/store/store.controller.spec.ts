import {
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import type { AuthUser } from '../auth/auth-user';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { SubscriptionStatus } from '../billing/entities/subscription.entity';
import { setupApp } from '../config/app-setup';
import { TenantService } from '../tenancy/tenant.service';
import { UserRole } from '../users/entities/user.entity';
import { Store, StoreAccountStatus } from './entities/store.entity';
import { StoreCustomersController } from './store-customers.controller';
import { StoreCustomersService } from './store-customers.service';
import { StoreDeliveryToolsService } from './store-delivery-tools.service';
import { StoreDirectoryService } from './store-directory.service';
import { StoreSettingsService } from './store-settings.service';
import { StoreController } from './store.controller';
import { StoreService } from './store.service';
import { StoresController } from './stores.controller';

// PNG 1x1 válido
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function storeRow(overrides: Partial<Store>): Store {
  return {
    name: 'Loja',
    is_open: true,
    opening_message: null,
    closing_message: null,
    account_status: StoreAccountStatus.ACTIVE,
    status_reason: null,
    delivery_enabled: true,
    takeout_enabled: true,
    time_zone: 'America/Sao_Paulo',
    ...overrides,
  } as Store;
}

/** Lojas do banco falso: 7 é a loja padrão. */
const STORES = [
  storeRow({ id: 7, slug: 'loja-7', opening_message: 'Bem-vindo' }),
  storeRow({
    id: 8,
    slug: 'loja-8',
    is_open: false,
    closing_message: 'Fechada',
  }),
  storeRow({
    id: 9,
    slug: 'loja-suspensa',
    account_status: StoreAccountStatus.SUSPENDED,
    status_reason: 'Inadimplência',
  }),
  storeRow({
    id: 10,
    slug: 'loja-desativada',
    account_status: StoreAccountStatus.INACTIVE,
  }),
];

const user = (
  role: UserRole,
  storeId: number | null,
  extra: Partial<AuthUser> = {},
): AuthUser => ({
  id: 100 + (storeId ?? 0),
  email: `${role.toLowerCase()}@loja.com`,
  role,
  name: role,
  storeId,
  platformRole: null,
  supportSession: null,
  ...extra,
});

const ADMIN_7 = user(UserRole.ADMIN, 7);
const EMPLOYEE_8 = user(UserRole.EMPLOYEE, 8);
const KITCHEN_7 = user(UserRole.KITCHEN, 7);
const CLIENT = user(UserRole.CLIENT, null);

/** Usuário "autenticado" do teste: cabeçalho x-test-user com o JSON de req.user. */
function userFrom(context: ExecutionContext): AuthUser | null {
  const req = context
    .switchToHttp()
    .getRequest<{ headers: Record<string, string>; user?: unknown }>();
  const header = req.headers['x-test-user'];
  const parsed = header ? (JSON.parse(header) as AuthUser) : null;
  req.user = parsed;
  return parsed;
}

const as = (who: AuthUser) => ({ 'x-test-user': JSON.stringify(who) });

const messageOf = (res: request.Response) =>
  JSON.stringify((res.body as { message?: unknown }).message ?? '');

describe('Loja (HTTP): /store e /stores', () => {
  let app: INestApplication<App>;
  let server: App;
  const savedDefaultSlug = process.env.DEFAULT_STORE_SLUG;

  const storeService = {
    updateStatus: jest.fn((storeId: number) =>
      Promise.resolve({
        id: storeId,
        is_open: false,
        opening_message: null,
        closing_message: null,
      }),
    ),
  };
  const settings = {
    getSettings: jest.fn((tenant: { storeId: number }) =>
      Promise.resolve({ id: tenant.storeId }),
    ),
    updateSettings: jest.fn((tenant: { storeId: number }) =>
      Promise.resolve({ id: tenant.storeId }),
    ),
    setPaymentCredentials: jest.fn().mockResolvedValue({}),
    removePaymentCredentials: jest.fn().mockResolvedValue({}),
    uploadLogo: jest.fn().mockResolvedValue({ logo: 's7-logo.webp' }),
    removeLogo: jest.fn().mockResolvedValue({ logo: null }),
  };
  // Ferramentas da entrega por distância (localizar a loja, testar um endereço)
  const deliveryTools = {
    geocodeStore: jest.fn((tenant: { storeId: number }) =>
      Promise.resolve({
        latitude: -22.9,
        longitude: -43.2,
        store: tenant.storeId,
      }),
    ),
    simulate: jest.fn((tenant: { storeId: number }) =>
      Promise.resolve({ mode: 'distance', store: tenant.storeId }),
    ),
  };
  const customers = {
    list: jest.fn().mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    }),
    detail: jest.fn().mockResolvedValue({}),
  };
  const directory = {
    list: jest.fn().mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    }),
    defaultProfile: jest.fn().mockResolvedValue({ id: 7 }),
    profile: jest.fn((context: { storeId: number }) =>
      Promise.resolve({ id: context.storeId }),
    ),
  };

  // TenantService REAL sobre repositórios falsos: os guards resolvem a loja como em produção
  const tenants = new TenantService(
    {
      findOne: ({ where }: { where: { id?: number; slug?: string } }) =>
        Promise.resolve(
          STORES.find((store) =>
            where.id !== undefined
              ? store.id === where.id
              : store.slug === where.slug,
          ) ?? null,
        ),
    } as never,
    {
      findOne: ({ where }: { where: { store_id: number } }) =>
        Promise.resolve({
          id: where.store_id,
          store_id: where.store_id,
          status: SubscriptionStatus.ACTIVE,
          plan: { features: {} },
        }),
    } as never,
    {
      findOne: () => Promise.resolve({ id: 1, default_store_id: 7 }),
    } as never,
  );

  beforeAll(async () => {
    delete process.env.DEFAULT_STORE_SLUG;
    const moduleRef = await Test.createTestingModule({
      controllers: [
        StoreController,
        StoreCustomersController,
        StoresController,
      ],
      providers: [
        { provide: StoreService, useValue: storeService },
        { provide: StoreSettingsService, useValue: settings },
        { provide: StoreDeliveryToolsService, useValue: deliveryTools },
        { provide: StoreCustomersService, useValue: customers },
        { provide: StoreDirectoryService, useValue: directory },
        { provide: TenantService, useValue: tenants },
      ],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          if (!userFrom(ctx)) {
            throw new UnauthorizedException(
              'Sessão inválida ou expirada. Faça login novamente.',
            );
          }
          return true;
        },
      })
      .overrideGuard(OptionalJwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          userFrom(ctx);
          return true;
        },
      })
      .compile();

    app = setupApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
    if (savedDefaultSlug === undefined) delete process.env.DEFAULT_STORE_SLUG;
    else process.env.DEFAULT_STORE_SLUG = savedDefaultSlug;
  });

  beforeEach(() => jest.clearAllMocks());

  describe('GET /store/status (rota antiga do app mobile)', () => {
    it('visitante e cliente veem a loja padrão, com exatamente as 4 chaves', async () => {
      for (const headers of [{}, as(CLIENT)]) {
        const res = await request(server)
          .get('/store/status')
          .set(headers)
          .expect(200);
        expect(res.body).toEqual({
          id: 7,
          is_open: true,
          opening_message: 'Bem-vindo',
          closing_message: null,
        });
      }
    });

    it('a equipe autenticada vê a própria loja', async () => {
      const res = await request(server)
        .get('/store/status')
        .set(as(EMPLOYEE_8))
        .expect(200);
      expect(res.body).toEqual({
        id: 8,
        is_open: false,
        opening_message: null,
        closing_message: 'Fechada',
      });
    });
  });

  describe('GET /stores/:storeSlug/status', () => {
    it('mesmo formato, pela loja do slug', async () => {
      const res = await request(server)
        .get('/stores/loja-8/status')
        .expect(200);
      expect(Object.keys(res.body as object).sort()).toEqual([
        'closing_message',
        'id',
        'is_open',
        'opening_message',
      ]);
      expect(res.body).toMatchObject({ id: 8, is_open: false });
    });

    it('loja inexistente, desativada ou slug inválido → 404 (mesma mensagem)', async () => {
      for (const slug of ['nao-existe', 'loja-desativada', 'Slug_Invalido!']) {
        const res = await request(server)
          .get(`/stores/${encodeURIComponent(slug)}/status`)
          .expect(404);
        expect(messageOf(res)).toContain('Loja não encontrada.');
      }
    });

    it('o token de quem chama nunca troca a loja do slug', async () => {
      const res = await request(server)
        .get('/stores/loja-8/status')
        .set(as(ADMIN_7))
        .expect(200);
      expect((res.body as { id: number }).id).toBe(8);
    });
  });

  describe('PATCH /store/status', () => {
    it('anônimo → 401; cliente, cozinha e entregador → 403', async () => {
      await request(server)
        .patch('/store/status')
        .send({ is_open: true })
        .expect(401);
      for (const who of [CLIENT, KITCHEN_7, user(UserRole.COURIER, 7)]) {
        await request(server)
          .patch('/store/status')
          .set(as(who))
          .send({ is_open: true })
          .expect(403);
      }
      expect(storeService.updateStatus).not.toHaveBeenCalled();
    });

    it('atendente altera a PRÓPRIA loja (a loja vem do usuário, não da requisição)', async () => {
      const res = await request(server)
        .patch('/store/status')
        .set(as(EMPLOYEE_8))
        .send({ is_open: false })
        .expect(200);
      expect(res.body).toEqual({
        id: 8,
        is_open: false,
        opening_message: null,
        closing_message: null,
      });
      expect(storeService.updateStatus).toHaveBeenCalledWith(
        8,
        { is_open: false },
        expect.objectContaining({
          user: expect.objectContaining({ id: EMPLOYEE_8.id }) as unknown,
        }),
      );
    });

    it('store_id/slug no corpo → 400 (nunca escolhem a loja)', async () => {
      await request(server)
        .patch('/store/status')
        .set(as(ADMIN_7))
        .send({ is_open: true, store_id: 8 })
        .expect(400);
      await request(server)
        .patch('/store/status')
        .set(as(ADMIN_7))
        .send({ slug: 'loja-8' })
        .expect(400);
      expect(storeService.updateStatus).not.toHaveBeenCalled();
    });

    it('loja suspensa → 403 com a mensagem da situação', async () => {
      const res = await request(server)
        .patch('/store/status')
        .set(as(user(UserRole.ADMIN, 9)))
        .send({ is_open: true })
        .expect(403);
      expect(messageOf(res)).toContain('Loja suspensa pela plataforma');
      expect(messageOf(res)).toContain('bloqueadas');
      expect(storeService.updateStatus).not.toHaveBeenCalled();
    });

    it('sessão de suporte é somente leitura', async () => {
      const support = user(UserRole.ADMIN, 7, {
        supportSession: { id: 1, storeId: 7, expiresAt: new Date() },
      });
      const res = await request(server)
        .patch('/store/status')
        .set(as(support))
        .send({ is_open: false })
        .expect(403);
      expect(messageOf(res)).toContain('somente leitura');
      // Leitura das configurações continua liberada
      await request(server).get('/store/settings').set(as(support)).expect(200);
    });
  });

  describe('/store/settings, /store/logo e /store/settings/payments (ADMIN)', () => {
    it('somente ADMIN da loja', async () => {
      for (const who of [EMPLOYEE_8, KITCHEN_7, CLIENT]) {
        await request(server).get('/store/settings').set(as(who)).expect(403);
        await request(server)
          .patch('/store/settings')
          .set(as(who))
          .send({ name: 'X' })
          .expect(403);
        await request(server)
          .put('/store/settings/payments')
          .set(as(who))
          .send({})
          .expect(403);
        await request(server).delete('/store/logo').set(as(who)).expect(403);
      }
      await request(server).get('/store/settings').expect(401);
      const res = await request(server)
        .get('/store/settings')
        .set(as(ADMIN_7))
        .expect(200);
      expect(res.body).toEqual({ id: 7 });
      expect(settings.getSettings).toHaveBeenCalledWith(
        expect.objectContaining({ storeId: 7 }),
      );
    });

    it('localizar a loja e testar um endereço: só ADMIN, 200, loja do usuário; DTO valida CEP, coordenadas e o rascunho', async () => {
      for (const who of [EMPLOYEE_8, KITCHEN_7, CLIENT]) {
        await request(server)
          .post('/store/settings/geocode')
          .set(as(who))
          .send({})
          .expect(403);
        await request(server)
          .post('/store/settings/delivery-simulation')
          .set(as(who))
          .send({ zip_code: '20040003' })
          .expect(403);
      }
      await request(server)
        .post('/store/settings/geocode')
        .set(as(ADMIN_7))
        .send({ zip_code: '20040-003', state: 'rj' })
        .expect(200);
      expect(deliveryTools.geocodeStore).toHaveBeenLastCalledWith(
        expect.objectContaining({ storeId: 7 }),
        expect.objectContaining({ zip_code: '20040003', state: 'RJ' }),
      );
      const simulated = await request(server)
        .post('/store/settings/delivery-simulation')
        .set(as(ADMIN_7))
        .send({
          zip_code: '20040-003',
          latitude: '-22.9',
          longitude: -43.2,
          delivery_zones: {
            mode: 'distance',
            fallback: { fee: 10, time: '60 min' },
            distance: { bands: [{ up_to_km: 3, fee: 5, time: '30 min' }] },
          },
        })
        .expect(200);
      expect(simulated.body).toEqual({ mode: 'distance', store: 7 });
      expect(deliveryTools.simulate).toHaveBeenLastCalledWith(
        expect.objectContaining({ storeId: 7 }),
        expect.objectContaining({
          zip_code: '20040003',
          latitude: -22.9,
          delivery_zones: expect.objectContaining({
            zones: [],
            mode: 'distance',
          }) as unknown,
        }),
      );

      const invalid = async (body: object, message: string) => {
        const res = await request(server)
          .post('/store/settings/delivery-simulation')
          .set(as(ADMIN_7))
          .send(body)
          .expect(400);
        expect(JSON.stringify(res.body)).toContain(message);
      };
      await invalid({}, 'Informe o CEP do endereço a testar.');
      await invalid({ zip_code: '123' }, 'CEP inválido');
      await invalid(
        { zip_code: '20040003', latitude: 91 },
        'Latitude inválida',
      );
      await invalid(
        {
          zip_code: '20040003',
          delivery_zones: { mode: 'distance', fallback: { fee: 1, time: 'x' } },
        },
        'Zonas de entrega inválidas: no modo por distância',
      );
      await invalid({ zip_code: '20040003', store_id: 8 }, 'store_id');
    });

    it('PATCH aceita o local da loja (latitude e longitude) e o modo por distância', async () => {
      await request(server)
        .patch('/store/settings')
        .set(as(ADMIN_7))
        .send({
          latitude: '-22.9035',
          longitude: -43.2096,
          delivery_zones: {
            mode: 'distance',
            outside_zones: 'refuse',
            distance: {
              bands: [{ up_to_km: 2, fee: 5, time: '25-35 min' }],
              max_km: 6,
              extra_km_fee: 1.5,
            },
          },
        })
        .expect(200);
      expect(settings.updateSettings).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          latitude: -22.9035,
          longitude: -43.2096,
          delivery_zones: {
            zones: [],
            outside_zones: 'refuse',
            mode: 'distance',
            distance: {
              bands: [{ up_to_km: 2, fee: 5, time: '25-35 min' }],
              max_km: 6,
              extra_km_fee: 1.5,
              route_factor: 1.3,
            },
          },
        }),
        expect.anything(),
      );
      const res = await request(server)
        .patch('/store/settings')
        .set(as(ADMIN_7))
        .send({ longitude: 200 })
        .expect(400);
      expect(JSON.stringify(res.body)).toContain('Longitude inválida');
    });

    it('PATCH normaliza os campos antes do serviço', async () => {
      await request(server)
        .patch('/store/settings')
        .set(as(ADMIN_7))
        .send({
          name: '  Loja Sete ',
          document: '11.222.333/0001-81',
          email: ' Contato@Loja7.com ',
          phone: '+55 (21) 99999-0000',
          address_zip_code: '20040-003',
          address_state: 'rj',
          time_zone: 'america/sao_paulo',
          primary_color: '#e11d48',
          legal_name: '',
          delivery_zones: {
            fallback: { fee: 12.5, time: ' 1h ' },
            zones: [{ neighborhoods: [' Centro '], fee: 5, time: '30 min' }],
          },
          opening_hours: [],
        })
        .expect(200);
      expect(settings.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ storeId: 7 }),
        expect.objectContaining({
          name: 'Loja Sete',
          document: '11222333000181',
          email: 'contato@loja7.com',
          phone: '21999990000',
          address_zip_code: '20040003',
          address_state: 'RJ',
          time_zone: 'America/Sao_Paulo',
          primary_color: '#E11D48',
          legal_name: null,
          opening_hours: null,
          delivery_zones: {
            fallback: { fee: 12.5, time: '1h' },
            zones: [{ neighborhoods: ['Centro'], fee: 5, time: '30 min' }],
          },
        }),
        expect.anything(),
      );
    });

    it('PATCH aceita recusar endereços fora das zonas (sem fallback) e zonas por faixa de CEP', async () => {
      await request(server)
        .patch('/store/settings')
        .set(as(ADMIN_7))
        .send({
          delivery_zones: {
            zones: [
              {
                zip_ranges: [{ from: '20000-000', to: '20099-999' }],
                fee: 5,
                time: '30 min',
              },
            ],
            outside_zones: 'REFUSE',
          },
        })
        .expect(200);
      expect(settings.updateSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({ storeId: 7 }),
        {
          delivery_zones: {
            zones: [
              {
                neighborhoods: [],
                zip_ranges: [{ from: '20000000', to: '20099999' }],
                fee: 5,
                time: '30 min',
              },
            ],
            outside_zones: 'refuse',
          },
        },
        expect.anything(),
      );
    });

    it('PATCH recusa campos não editáveis e valores inválidos, com mensagens em português', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ slug: 'novo-slug' }, 'property slug should not exist'],
        [
          { account_status: 'ACTIVE' },
          'property account_status should not exist',
        ],
        [{ custom_domain: 'x.com' }, 'property custom_domain should not exist'],
        [{ owner_user_id: 1 }, 'property owner_user_id should not exist'],
        [{ is_open: true }, 'property is_open should not exist'],
        [{ document: '11.222.333/0001-82' }, 'CNPJ inválido'],
        [{ document: '123' }, 'Informe o CPF'],
        [{ name: '' }, 'Informe o nome da loja.'],
        [{ name: null }, 'Informe o nome da loja.'],
        [{ email: 'sem-arroba' }, 'E-mail da loja inválido.'],
        [{ phone: '1234' }, 'Telefone inválido'],
        [{ address_state: 'XX' }, 'UF inválida'],
        [{ address_zip_code: '123' }, 'CEP inválido'],
        [{ time_zone: 'Lua/Base' }, 'Fuso horário inválido'],
        [{ time_zone: null }, 'Fuso horário inválido'],
        [{ primary_color: 'vermelho' }, 'Cor inválida'],
        [
          { delivery_enabled: null },
          'delivery_enabled deve ser verdadeiro ou falso.',
        ],
        [
          { delivery_zones: { zones: [] } },
          'Zonas de entrega inválidas: informe em \\"fallback\\"',
        ],
        [
          {
            delivery_zones: { fallback: { fee: '12', time: '1h' }, zones: [] },
          },
          'Zonas de entrega inválidas: \\"fallback\\" precisa de \\"fee\\"',
        ],
        [
          {
            delivery_zones: {
              fallback: { fee: 12, time: '1h' },
              zones: [],
              outside_zones: 'talvez',
            },
          },
          'Zonas de entrega inválidas: \\"outside_zones\\" deve ser',
        ],
        [
          { delivery_zones: { zones: [], outside_zones: 'refuse' } },
          'cadastre pelo menos uma zona',
        ],
        [
          { opening_hours: [{ day: 9, open: '18:00', close: '22:00' }] },
          'Horários de funcionamento inválidos',
        ],
      ];
      for (const [body, message] of cases) {
        const res = await request(server)
          .patch('/store/settings')
          .set(as(ADMIN_7))
          .send(body)
          .expect(400);
        expect(messageOf(res)).toContain(message);
      }
      expect(settings.updateSettings).not.toHaveBeenCalled();
    });

    it('PUT de credenciais inválidas → 400 sem repetir o valor enviado', async () => {
      const token = 'segredo-sem-prefixo-123456';
      const res = await request(server)
        .put('/store/settings/payments')
        .set(as(ADMIN_7))
        .send({
          mp_public_key: 'APP_USR-chave-publica-1',
          mp_access_token: token,
        })
        .expect(400);
      expect(messageOf(res)).toContain('Access Token inválido');
      expect(JSON.stringify(res.body)).not.toContain(token);
      expect(settings.setPaymentCredentials).not.toHaveBeenCalled();

      await request(server)
        .put('/store/settings/payments')
        .set(as(ADMIN_7))
        .send({
          mp_public_key: 'APP_USR-chave-publica-1',
          mp_access_token: 'APP_USR-1234567890-token',
        })
        .expect(200);
      expect(settings.setPaymentCredentials).toHaveBeenCalledWith(
        expect.objectContaining({ storeId: 7 }),
        {
          mp_public_key: 'APP_USR-chave-publica-1',
          mp_access_token: 'APP_USR-1234567890-token',
        },
        expect.anything(),
      );
    });

    it('POST /store/logo entrega o arquivo ao serviço com a loja do usuário', async () => {
      const res = await request(server)
        .post('/store/logo')
        .set(as(ADMIN_7))
        .attach('file', PNG, { filename: 'logo.png', contentType: 'image/png' })
        .expect(201);
      expect(res.body).toEqual({ logo: 's7-logo.webp' });
      const [tenant, file] = settings.uploadLogo.mock.calls[0] as [
        { storeId: number },
        Express.Multer.File,
      ];
      expect(tenant.storeId).toBe(7);
      expect(file.buffer.equals(PNG)).toBe(true);
    });
  });

  describe('/store/customers (ADMIN e atendente)', () => {
    it('cozinha e cliente não acessam; atendente lista a própria loja', async () => {
      await request(server)
        .get('/store/customers')
        .set(as(KITCHEN_7))
        .expect(403);
      await request(server).get('/store/customers').set(as(CLIENT)).expect(403);

      await request(server)
        .get('/store/customers?search=maria&page=2&pageSize=10')
        .set(as(EMPLOYEE_8))
        .expect(200);
      expect(customers.list).toHaveBeenCalledWith(8, {
        search: 'maria',
        page: 2,
        pageSize: 10,
      });
    });

    it('paginação inválida ou loja na query → 400', async () => {
      for (const query of [
        'page=abc',
        'page=0',
        'pageSize=1.5',
        'store_id=7',
      ]) {
        await request(server)
          .get(`/store/customers?${query}`)
          .set(as(ADMIN_7))
          .expect(400);
      }
      expect(customers.list).not.toHaveBeenCalled();
    });

    it('detalhe pelo id do cliente, sempre na loja do usuário', async () => {
      await request(server)
        .get('/store/customers/abc')
        .set(as(ADMIN_7))
        .expect(400);
      await request(server)
        .get('/store/customers/3')
        .set(as(EMPLOYEE_8))
        .expect(200);
      expect(customers.detail).toHaveBeenCalledWith(8, 3);
    });
  });

  describe('GET /stores (vitrine pública)', () => {
    it('diretório paginado', async () => {
      await request(server)
        .get('/stores?search=pizza&pageSize=500')
        .expect(200);
      expect(directory.list).toHaveBeenCalledWith({
        search: 'pizza',
        pageSize: 500,
      });
    });

    it('"default" é rota literal (antes de :storeSlug)', async () => {
      await request(server).get('/stores/default').expect(200);
      expect(directory.defaultProfile).toHaveBeenCalled();
      expect(directory.profile).not.toHaveBeenCalled();
    });

    it('perfil pelo slug; desativada ou inexistente → 404', async () => {
      const res = await request(server).get('/stores/loja-8').expect(200);
      expect(res.body).toEqual({ id: 8 });
      await request(server).get('/stores/loja-desativada').expect(404);
      await request(server).get('/stores/nao-existe').expect(404);
      // Loja suspensa continua com vitrine (indisponível para pedidos)
      await request(server).get('/stores/loja-suspensa').expect(200);
    });
  });
});
