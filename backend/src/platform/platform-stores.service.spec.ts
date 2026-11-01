import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import { Not, QueryFailedError } from 'typeorm';
import type { AuthUser } from '../auth/auth-user';
import {
  Subscription,
  SubscriptionStatus,
} from '../billing/entities/subscription.entity';
import { OrderStatus, PaymentStatus } from '../orders/order.enums';
import { StoreAccountStatus } from '../store/entities/store.entity';
import { StoreSlugHistory } from '../store/entities/store-slug-history.entity';
import { PlatformRole, User, UserRole } from '../users/entities/user.entity';
import {
  displaySubscriptions,
  OWNER_EMAIL_IN_USE_MESSAGE,
  OWNER_NOT_ELIGIBLE_MESSAGE,
  OWNER_ROLE_REQUIRED_MESSAGE,
  PlatformStoresService,
  STATUS_CHANGED_CONCURRENTLY_MESSAGE,
} from './platform-stores.service';
import {
  CUSTOM_DOMAIN_NOT_ROUTED_NOTICE,
  CUSTOM_DOMAIN_TAKEN_MESSAGE,
  SLUG_TAKEN_MESSAGE,
} from './store-identity-rules';
import { DEFAULT_STORE_DEACTIVATED_WARNING } from './store-status-rules';
import {
  callsOf,
  fakeQueryBuilder,
  paramsOf,
  sqlOf,
} from './testing/fake-query-builder.helper-spec';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const SUPER_ADMIN: AuthUser = {
  id: 1,
  email: 'ops@comestra.com',
  role: UserRole.CLIENT,
  name: 'Ops',
  storeId: null,
  platformRole: PlatformRole.SUPER_ADMIN,
  supportSession: null,
};
const REQUEST = { ip: '203.0.113.9', headers: {} } as unknown as Request;
const INVITE_URL = 'http://localhost:5173/convite/TOKEN-SECRETO-123';

function storeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    slug: 'antigo',
    name: 'Loja 5',
    logo: null,
    account_status: StoreAccountStatus.ACTIVE,
    is_open: true,
    custom_domain: null,
    owner_user_id: null,
    document: null,
    time_zone: 'America/Sao_Paulo',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function setup() {
  const storeTx = {
    create: jest.fn((data: object) => ({ ...data })),
    save: jest.fn((data: object) =>
      Promise.resolve({
        ...data,
        id: 77,
        time_zone: 'America/Sao_Paulo',
        created_at: NOW,
        updated_at: NOW,
      }),
    ),
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  // Equipe da loja (sessões revogadas ao desativar); as demais entidades usam o repositório da loja
  const usersTx = { update: jest.fn().mockResolvedValue({ affected: 2 }) };
  const manager = {
    getRepository: jest.fn((entity: unknown) =>
      entity === User ? usersTx : storeTx,
    ),
  };
  // Endereços antigos (store_slug_history)
  const slugHistory = {
    findOne: jest.fn().mockResolvedValue(null),
    upsert: jest.fn().mockResolvedValue({}),
  };
  const stores = {
    exists: jest.fn().mockResolvedValue(false),
    findOne: jest.fn().mockResolvedValue(storeRow()),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn(),
    manager: {
      getRepository: jest.fn((entity: unknown) =>
        entity === StoreSlugHistory ? slugHistory : undefined,
      ),
      transaction: jest.fn((work: (m: typeof manager) => Promise<unknown>) =>
        work(manager),
      ),
    },
  };
  const users = {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn(),
  };
  const orders = { createQueryBuilder: jest.fn(), find: jest.fn() };
  const subscriptions = { find: jest.fn().mockResolvedValue([]) };
  const tenants = {
    defaultStore: jest.fn().mockResolvedValue(null),
    currentSubscription: jest.fn().mockResolvedValue(null),
  };
  const subscriptionsService = {
    createForStore: jest.fn().mockResolvedValue({
      id: 300,
      store_id: 77,
      plan_id: 2,
      status: SubscriptionStatus.ACTIVE,
      billing_provider: 'MANUAL',
      cancel_at_period_end: false,
      plan: {
        id: 2,
        code: 'essencial',
        name: 'Essencial',
        price: 99.9,
        billing_interval: 'MONTHLY',
        features: {},
      },
    }),
  };
  const planLimits = {
    usage: jest
      .fn()
      .mockResolvedValue({ staff_users: 0, products: 0, monthly_orders: 0 }),
    currentPlan: jest.fn().mockResolvedValue(null),
    storageUsage: jest.fn().mockResolvedValue(null),
  };
  const invitations = {
    create: jest.fn().mockResolvedValue({
      invitation: {
        id: 900,
        store_id: 77,
        email: 'dono@loja.com',
        role: UserRole.ADMIN,
        make_owner: true,
        status: 'PENDING',
        expires_at: NOW,
      },
      url: INVITE_URL,
    }),
    listByStore: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    revokeAsPlatform: jest.fn().mockResolvedValue({ id: 900 }),
  };
  const usersService = { emailInUse: jest.fn().mockResolvedValue(false) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };

  const service = new PlatformStoresService(
    stores as never,
    users as never,
    orders as never,
    subscriptions as never,
    tenants as never,
    subscriptionsService as never,
    planLimits as never,
    invitations as never,
    usersService as never,
    audit as never,
  );
  return {
    service,
    slugHistory,
    storeTx,
    usersTx,
    manager,
    stores,
    users,
    orders,
    subscriptions,
    tenants,
    subscriptionsService,
    planLimits,
    invitations,
    usersService,
    audit,
  };
}

const CREATE_DTO = {
  name: 'Lanchonete do Bairro',
  slug: 'lanchonete-do-bairro',
  plan_id: 2,
  document: '11222333000181',
  phone: '21999990000',
  owner: { email: 'Dono@Loja.com', name: 'Maria' },
};

describe('PlatformStoresService', () => {
  describe('create', () => {
    it('loja + assinatura na mesma transação; depois o convite do responsável (ADMIN, responsável)', async () => {
      const ctx = setup();
      const result = await ctx.service.create(CREATE_DTO, SUPER_ADMIN, REQUEST);

      expect(ctx.storeTx.create).toHaveBeenCalledWith({
        document: '11222333000181',
        phone: '21999990000',
        name: 'Lanchonete do Bairro',
        slug: 'lanchonete-do-bairro',
        account_status: StoreAccountStatus.ACTIVE,
        status_reason: null,
        status_changed_at: null,
        is_open: false,
        delivery_enabled: false,
        takeout_enabled: true,
        owner_user_id: null,
      });
      expect(ctx.subscriptionsService.createForStore).toHaveBeenCalledWith(
        77,
        2,
        expect.objectContaining({
          actor: SUPER_ADMIN,
          request: REQUEST,
          manager: ctx.manager,
          allowInactivePlan: false,
        }),
      );
      expect(ctx.invitations.create).toHaveBeenCalledWith({
        storeId: 77,
        email: 'dono@loja.com',
        role: UserRole.ADMIN,
        makeOwner: true,
        invitedBy: SUPER_ADMIN,
        request: REQUEST,
        // Mesma regra de POST /platform/stores/:id/invitations: com SMTP, o link vai só para o convidado
        deliverOnlyByEmail: true,
      });
      // O convite só depois da transação
      expect(
        ctx.stores.manager.transaction.mock.invocationCallOrder[0],
      ).toBeLessThan(ctx.invitations.create.mock.invocationCallOrder[0]);

      expect(result).toMatchObject({
        store: {
          id: 77,
          slug: 'lanchonete-do-bairro',
          account_status: 'ACTIVE',
        },
        subscription: { id: 300, plan: { code: 'essencial' } },
        invitation: { id: 900, url: INVITE_URL },
        warnings: [],
      });
      expect(result.store).not.toHaveProperty('mp_access_token_encrypted');

      const actions = ctx.audit.record.mock.calls.map(
        ([entry]: [{ action: string }]) => entry.action,
      );
      expect(actions).toEqual(['platform.store.create', 'subscription.create']);
      expect(ctx.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: SUPER_ADMIN,
          storeId: 77,
          action: 'platform.store.create',
          metadata: expect.objectContaining({
            slug: 'lanchonete-do-bairro',
            plan_code: 'essencial',
            subscription_id: 300,
            owner_email: 'dono@loja.com',
            invitation_id: 900,
          }) as unknown,
        }),
      );
      // O link do convite (com o token) nunca vai para a auditoria
      expect(JSON.stringify(ctx.audit.record.mock.calls)).not.toContain(
        'TOKEN-SECRETO',
      );
    });

    it('slug em uso ou e-mail do responsável com conta → 409 antes de gravar', async () => {
      const taken = setup();
      taken.stores.exists.mockResolvedValue(true);
      await expect(
        taken.service.create(CREATE_DTO as never, SUPER_ADMIN),
      ).rejects.toThrow(SLUG_TAKEN_MESSAGE);

      const email = setup();
      email.usersService.emailInUse.mockResolvedValue(true);
      const attempt = email.service.create(CREATE_DTO, SUPER_ADMIN);
      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toThrow(OWNER_EMAIL_IN_USE_MESSAGE);

      for (const ctx of [taken, email]) {
        expect(ctx.stores.manager.transaction).not.toHaveBeenCalled();
      }
    });

    it('slug criado por outra requisição no meio-tempo (índice único) → 409', async () => {
      const ctx = setup();
      ctx.storeTx.save.mockRejectedValue(
        new QueryFailedError(
          'INSERT',
          [],
          Object.assign(new Error('duplicate'), {
            code: '23505',
            constraint: 'UQ_stores_slug',
          }),
        ),
      );
      await expect(
        ctx.service.create(CREATE_DTO as never, SUPER_ADMIN),
      ).rejects.toThrow(SLUG_TAKEN_MESSAGE);
      expect(ctx.invitations.create).not.toHaveBeenCalled();
    });

    it('com SMTP o convite do responsável sai só por e-mail: url null, delivered e a mensagem do envio', async () => {
      const ctx = setup();
      ctx.invitations.create.mockResolvedValueOnce({
        invitation: {
          id: 901,
          store_id: 77,
          email: 'dono@loja.com',
          role: UserRole.ADMIN,
          make_owner: true,
          status: 'PENDING',
          expires_at: NOW,
        },
        url: null,
        delivered: true,
        message: 'Convite enviado para d***@loja.com.',
      });
      const result = await ctx.service.create(CREATE_DTO, SUPER_ADMIN);
      expect(result.invitation).toEqual(
        expect.objectContaining({
          id: 901,
          url: null,
          delivered: true,
          message: 'Convite enviado para d***@loja.com.',
        }),
      );
      expect(result.warnings).toEqual([]);
    });

    it('falha no convite não desfaz a loja: resposta com aviso', async () => {
      const ctx = setup();
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      ctx.invitations.create.mockRejectedValue(
        new ConflictException('Já existe uma conta com este e-mail.'),
      );
      const result = await ctx.service.create(CREATE_DTO, SUPER_ADMIN);
      expect(result.invitation).toBeNull();
      expect(result.warnings[0]).toContain(
        'Já existe uma conta com este e-mail.',
      );
      expect(ctx.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform.store.create',
          metadata: expect.objectContaining({ invitation_id: null }) as unknown,
        }),
      );
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('só superadmin fora de sessão de suporte', async () => {
      const ctx = setup();
      await expect(
        ctx.service.create(CREATE_DTO as never, {
          ...SUPER_ADMIN,
          supportSession: { id: 1, storeId: 5, expiresAt: NOW },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(ctx.stores.exists).not.toHaveBeenCalled();
    });
  });

  describe('changeStatus', () => {
    function withStore(status: StoreAccountStatus) {
      const ctx = setup();
      ctx.storeTx.findOne.mockResolvedValue({ id: 5, account_status: status });
      jest.spyOn(ctx.service, 'detail').mockResolvedValue({ id: 5 } as never);
      return ctx;
    }

    it('suspende com o motivo, trava a linha e grava pela situação esperada (auditado)', async () => {
      const ctx = withStore(StoreAccountStatus.ACTIVE);
      const result = await ctx.service.changeStatus(
        5,
        'suspend',
        ' Inadimplência negociada ',
        SUPER_ADMIN,
        REQUEST,
        NOW,
      );
      expect(ctx.storeTx.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 5 },
          lock: { mode: 'pessimistic_write' },
        }),
      );
      expect(ctx.storeTx.update).toHaveBeenCalledWith(
        { id: 5, account_status: StoreAccountStatus.ACTIVE },
        {
          account_status: StoreAccountStatus.SUSPENDED,
          status_reason: 'Inadimplência negociada',
          status_changed_at: NOW,
        },
      );
      expect(ctx.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId: 5,
          action: 'platform.store.suspend',
          metadata: {
            from: 'ACTIVE',
            to: 'SUSPENDED',
            reason: 'Inadimplência negociada',
            is_default_store: false,
          },
        }),
      );
      expect(result).toEqual({ id: 5, warnings: [] });
      // Suspender não derruba as sessões: a equipe continua lendo e operando os pedidos
      expect(ctx.usersTx.update).not.toHaveBeenCalled();
    });

    it('transição inválida → 409 sem gravar nem auditar', async () => {
      const ctx = withStore(StoreAccountStatus.SUSPENDED);
      await expect(
        ctx.service.changeStatus(5, 'suspend', 'x', SUPER_ADMIN),
      ).rejects.toThrow('A loja já está suspensa.');
      expect(ctx.storeTx.update).not.toHaveBeenCalled();
      expect(ctx.audit.record).not.toHaveBeenCalled();
    });

    it('desativar a loja padrão é permitido, com aviso; restaurar limpa o motivo', async () => {
      const ctx = withStore(StoreAccountStatus.SUSPENDED);
      ctx.tenants.defaultStore.mockResolvedValue({ id: 5 });
      const result = await ctx.service.changeStatus(
        5,
        'deactivate',
        'Encerrou as atividades',
        SUPER_ADMIN,
      );
      expect(result.warnings).toEqual([DEFAULT_STORE_DEACTIVATED_WARNING]);
      // Desativar derruba as sessões da equipe da loja (token_version + 1), na mesma transação
      expect(ctx.usersTx.update).toHaveBeenCalledTimes(1);
      expect(ctx.usersTx.update).toHaveBeenCalledWith(
        { store_id: 5, role: Not(UserRole.CLIENT) },
        { token_version: expect.any(Function) as unknown },
      );
      const [[, bump]] = ctx.usersTx.update.mock.calls as unknown as [
        [unknown, { token_version: () => string }],
      ];
      expect(bump.token_version()).toBe('"token_version" + 1');
      // ...e os links de redefinição pendentes da equipe vencem na mesma transação
      expect(ctx.storeTx.update).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: expect.anything() as unknown }),
        { expires_at: expect.any(Date) as unknown },
      );

      const restore = withStore(StoreAccountStatus.INACTIVE);
      await restore.service.changeStatus(5, 'restore', null, SUPER_ADMIN);
      expect(restore.usersTx.update).not.toHaveBeenCalled();
      expect(restore.storeTx.update).toHaveBeenCalledWith(
        { id: 5, account_status: StoreAccountStatus.INACTIVE },
        expect.objectContaining({
          account_status: StoreAccountStatus.ACTIVE,
          status_reason: null,
        }),
      );
    });

    it('loja inexistente → 404; situação mudou no meio-tempo → 409', async () => {
      const missing = setup();
      missing.storeTx.findOne.mockResolvedValue(null);
      await expect(
        missing.service.changeStatus(9, 'restore', null, SUPER_ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);

      const race = withStore(StoreAccountStatus.ACTIVE);
      race.storeTx.update.mockResolvedValue({ affected: 0 });
      await expect(
        race.service.changeStatus(5, 'suspend', 'Motivo', SUPER_ADMIN),
      ).rejects.toThrow(STATUS_CHANGED_CONCURRENTLY_MESSAGE);
    });
  });

  describe('update', () => {
    function withDetail() {
      const ctx = setup();
      jest.spyOn(ctx.service, 'detail').mockResolvedValue({ id: 5 } as never);
      return ctx;
    }

    it('mudança de slug: confere a unicidade e audita o antigo e o novo', async () => {
      const ctx = withDetail();
      const result = await ctx.service.update(
        5,
        { slug: 'novo', document: '11222333000181' },
        SUPER_ADMIN,
        REQUEST,
      );
      expect(ctx.stores.exists).toHaveBeenCalled();
      expect(ctx.stores.update).toHaveBeenCalledWith(
        { id: 5 },
        { slug: 'novo', document: '11222333000181' },
      );
      expect(ctx.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform.store.update',
          storeId: 5,
          metadata: {
            fields: ['slug', 'document'],
            slug: { from: 'antigo', to: 'novo' },
          },
        }),
      );
      // Documento (dado pessoal/fiscal) não vai para a trilha, só o nome do campo
      expect(JSON.stringify(ctx.audit.record.mock.calls)).not.toContain(
        '11222333000181',
      );
      expect(result.warnings[0]).toContain('/loja/antigo');
    });

    it('mudança de slug: o endereço antigo fica reservado (store_slug_history) ANTES da troca', async () => {
      const ctx = withDetail();
      await ctx.service.update(5, { slug: 'novo' }, SUPER_ADMIN);
      expect(ctx.slugHistory.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ store_id: 5, slug: 'antigo' }),
        ['slug'],
      );
      expect(ctx.slugHistory.upsert.mock.invocationCallOrder[0]).toBeLessThan(
        ctx.stores.update.mock.invocationCallOrder[0],
      );

      // Sem troca de slug, nada é reservado
      const other = withDetail();
      await other.service.update(5, { name: 'Outro nome' }, SUPER_ADMIN);
      expect(other.slugHistory.upsert).not.toHaveBeenCalled();
    });

    it('loja padrão (DEFAULT_STORE_SLUG): trocar o endereço avisa que as rotas antigas e o app deixam de achá-la', async () => {
      const saved = process.env.DEFAULT_STORE_SLUG;
      process.env.DEFAULT_STORE_SLUG = 'antigo';
      try {
        const ctx = withDetail();
        const result = await ctx.service.update(
          5,
          { slug: 'novo' },
          SUPER_ADMIN,
        );
        expect(result.warnings.join(' ')).toContain('DEFAULT_STORE_SLUG');
      } finally {
        if (saved === undefined) delete process.env.DEFAULT_STORE_SLUG;
        else process.env.DEFAULT_STORE_SLUG = saved;
      }
    });

    it('endereço que já foi de outra loja: o superpainel pode usar, com aviso', async () => {
      const ctx = withDetail();
      ctx.slugHistory.findOne.mockResolvedValue({ store_id: 9, slug: 'velho' });
      const result = await ctx.service.update(
        5,
        { slug: 'velho' },
        SUPER_ADMIN,
      );
      expect(ctx.stores.update).toHaveBeenCalled();
      expect(result.warnings.join(' ')).toContain(
        'já foi de outro estabelecimento',
      );
    });

    it('slug ou domínio de outra loja → 409 (inclusive pela constraint do banco)', async () => {
      const slug = withDetail();
      slug.stores.exists.mockResolvedValue(true);
      await expect(
        slug.service.update(5, { slug: 'ocupado' }, SUPER_ADMIN),
      ).rejects.toThrow(SLUG_TAKEN_MESSAGE);

      const domain = withDetail();
      domain.stores.update.mockRejectedValue(
        new QueryFailedError(
          'UPDATE',
          [],
          Object.assign(new Error('duplicate'), {
            code: '23505',
            constraint: 'UQ_stores_custom_domain',
          }),
        ),
      );
      await expect(
        domain.service.update(
          5,
          { custom_domain: 'pedidos.loja.com' },
          SUPER_ADMIN,
        ),
      ).rejects.toThrow(CUSTOM_DOMAIN_TAKEN_MESSAGE);
    });

    it('domínio próprio: avisa que ainda não é roteado', async () => {
      const ctx = withDetail();
      const result = await ctx.service.update(
        5,
        { custom_domain: 'pedidos.loja.com' },
        SUPER_ADMIN,
      );
      expect(result.warnings).toEqual([CUSTOM_DOMAIN_NOT_ROUTED_NOTICE]);
      expect(ctx.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            custom_domain: { from: null, to: 'pedidos.loja.com' },
          }) as unknown,
        }),
      );
    });

    it('responsável: só um ADMIN ativo desta loja', async () => {
      for (const candidate of [
        null,
        { id: 12, role: UserRole.EMPLOYEE, store_id: 5, blocked_at: null },
        { id: 12, role: UserRole.ADMIN, store_id: 6, blocked_at: null },
        { id: 12, role: UserRole.ADMIN, store_id: 5, blocked_at: NOW },
      ]) {
        const ctx = withDetail();
        ctx.users.findOne.mockResolvedValue(candidate);
        const attempt = ctx.service.update(
          5,
          { owner_user_id: 12 },
          SUPER_ADMIN,
        );
        await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
        await expect(attempt).rejects.toThrow(OWNER_NOT_ELIGIBLE_MESSAGE);
        expect(ctx.stores.update).not.toHaveBeenCalled();
      }
      const ok = withDetail();
      ok.users.findOne.mockResolvedValue({
        id: 12,
        role: UserRole.ADMIN,
        store_id: 5,
        blocked_at: null,
      });
      await ok.service.update(5, { owner_user_id: 12 }, SUPER_ADMIN);
      expect(ok.stores.update).toHaveBeenCalledWith(
        { id: 5 },
        { owner_user_id: 12 },
      );
    });

    it('nada mudou: não grava nem audita', async () => {
      const ctx = withDetail();
      const result = await ctx.service.update(
        5,
        { slug: 'antigo', name: 'Loja 5' },
        SUPER_ADMIN,
      );
      expect(ctx.stores.update).not.toHaveBeenCalled();
      expect(ctx.audit.record).not.toHaveBeenCalled();
      expect(result.warnings).toEqual([]);
    });
  });

  describe('list', () => {
    it('indicadores da página em consultas agregadas (sem N+1) e assinatura exibida', async () => {
      const ctx = setup();
      const storesQb = fakeQueryBuilder({
        getManyAndCount: [
          [
            storeRow({ id: 5, owner_user_id: 12 }),
            storeRow({ id: 6, slug: 'loja-6', name: 'Loja 6' }),
          ],
          2,
        ],
      });
      const staffQb = fakeQueryBuilder({
        getRawMany: [{ store_id: '5', count: '3' }],
      });
      const ordersQb = fakeQueryBuilder({
        getRawMany: [{ store_id: 5, orders: '4', gmv: '120.50' }],
      });
      ctx.stores.createQueryBuilder.mockReturnValue(storesQb);
      ctx.users.createQueryBuilder.mockReturnValue(staffQb);
      ctx.orders.createQueryBuilder.mockReturnValue(ordersQb);
      ctx.users.find.mockResolvedValue([
        { id: 12, name: 'Maria', email: 'maria@loja.com' },
      ]);
      const plan = { id: 2, code: 'essencial', name: 'Essencial' };
      ctx.subscriptions.find.mockResolvedValue([
        { id: 11, store_id: 5, status: SubscriptionStatus.CANCELED, plan },
        {
          id: 10,
          store_id: 5,
          status: SubscriptionStatus.ACTIVE,
          trial_ends_at: null,
          current_period_end: NOW,
          cancel_at_period_end: false,
          plan,
        },
        { id: 8, store_id: 6, status: SubscriptionStatus.CANCELED, plan },
      ]);

      const result = await ctx.service.list(
        { sort: 'name', pageSize: 500, subscription_status: 'NONE' },
        NOW,
      );

      expect(result.total).toBe(2);
      expect(result.pageSize).toBe(100);
      expect(result.items[0]).toEqual({
        id: 5,
        slug: 'antigo',
        name: 'Loja 5',
        logo: null,
        account_status: StoreAccountStatus.ACTIVE,
        is_open: true,
        created_at: NOW,
        owner: { id: 12, name: 'Maria', email: 'maria@loja.com' },
        plan: { id: 2, code: 'essencial', name: 'Essencial' },
        subscription: {
          id: 10,
          status: SubscriptionStatus.ACTIVE,
          trial_ends_at: null,
          current_period_end: NOW,
          cancel_at_period_end: false,
        },
        staff_count: 3,
        orders_30d: 4,
        gmv_30d: 120.5,
      });
      expect(result.items[1]).toMatchObject({
        id: 6,
        owner: null,
        subscription: { id: 8, status: SubscriptionStatus.CANCELED },
        staff_count: 0,
        orders_30d: 0,
        gmv_30d: 0,
      });

      // Ordenação da whitelist, página limitada e filtro de assinatura
      expect(callsOf(storesQb, 'orderBy')).toEqual([['store.name', 'ASC']]);
      expect(callsOf(storesQb, 'limit')).toEqual([[100]]);
      expect(sqlOf(storesQb)).toContain('NOT EXISTS');
      // Indicadores: uma consulta por tipo, para todas as lojas da página
      expect(paramsOf(ordersQb)).toMatchObject({
        ids: [5, 6],
        canceled: OrderStatus.CANCELED,
        paid: PaymentStatus.PAID,
      });
      expect(paramsOf(staffQb)).toMatchObject({ ids: [5, 6] });
      expect(ctx.subscriptions.find).toHaveBeenCalledTimes(1);
    });

    it('página vazia não consulta indicadores', async () => {
      const ctx = setup();
      ctx.stores.createQueryBuilder.mockReturnValue(fakeQueryBuilder());
      const result = await ctx.service.list({});
      expect(result).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
      expect(ctx.subscriptions.find).not.toHaveBeenCalled();
      expect(ctx.orders.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('assinatura exibida: a vigente; sem ela, a mais recente', () => {
      const rows = [
        { id: 4, store_id: 1, status: SubscriptionStatus.CANCELED },
        { id: 3, store_id: 1, status: SubscriptionStatus.PAST_DUE },
        { id: 2, store_id: 2, status: SubscriptionStatus.CANCELED },
        { id: 1, store_id: 2, status: SubscriptionStatus.CANCELED },
      ] as Subscription[];
      const display = displaySubscriptions(rows);
      expect(display.get(1)?.id).toBe(3);
      expect(display.get(2)?.id).toBe(2);
    });
  });

  describe('equipe da loja (leitura de dados pessoais)', () => {
    it('GET /platform/stores/:id/users entra na auditoria (platform.store.team.view) com a quantidade', async () => {
      const ctx = setup();
      const qb = fakeQueryBuilder({
        getManyAndCount: [
          [
            {
              id: 12,
              name: 'Maria',
              email: 'maria@loja.com',
              role: UserRole.ADMIN,
              store_id: 5,
              platform_role: null,
              deleted_at: null,
            },
          ],
          1,
        ],
      });
      ctx.users.createQueryBuilder.mockReturnValue(qb);
      ctx.stores.findOne.mockResolvedValue(storeRow({ id: 5 }));

      await ctx.service.team(
        5,
        { include_deleted: true },
        SUPER_ADMIN,
        REQUEST,
      );
      expect(ctx.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: SUPER_ADMIN,
          storeId: 5,
          action: 'platform.store.team.view',
          targetType: 'store',
          targetId: 5,
          request: REQUEST,
          metadata: expect.objectContaining({
            returned: 1,
            total: 1,
            include_deleted: true,
          }) as unknown,
        }),
      );
      expect(JSON.stringify(ctx.audit.record.mock.calls)).not.toContain(
        'maria@loja.com',
      );
    });
  });

  describe('convites e relatório', () => {
    it('convite com make_owner exige o perfil ADMIN; sem vaga no plano, cria com aviso', async () => {
      const ctx = setup();
      ctx.stores.exists.mockResolvedValue(true);
      await expect(
        ctx.service.createInvitation(
          5,
          { email: 'a@b.com', role: UserRole.EMPLOYEE, make_owner: true },
          SUPER_ADMIN,
        ),
      ).rejects.toThrow(OWNER_ROLE_REQUIRED_MESSAGE);
      expect(ctx.invitations.create).not.toHaveBeenCalled();

      ctx.planLimits.currentPlan.mockResolvedValue({
        name: 'Básico',
        max_staff_users: 2,
      });
      ctx.planLimits.usage.mockResolvedValue({ staff_users: 2 });
      const result = await ctx.service.createInvitation(
        5,
        { email: 'a@b.com', role: UserRole.ADMIN, make_owner: true },
        SUPER_ADMIN,
      );
      expect(ctx.invitations.create).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId: 5,
          role: UserRole.ADMIN,
          makeOwner: true,
          // Com SMTP, o link vai só para o convidado (url null, delivered true)
          deliverOnlyByEmail: true,
        }),
      );
      expect(result.url).toBe(INVITE_URL);
      expect(result.delivered).toBe(false);
      expect(result.warnings[0]).toContain('limite de 2 usuários');
    });

    it('loja inexistente → 404 nas rotas por loja', async () => {
      const ctx = setup();
      ctx.stores.exists.mockResolvedValue(false);
      await expect(ctx.service.listInvitations(9, {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
      ctx.stores.findOne.mockResolvedValue(null);
      await expect(ctx.service.detail(9)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('relatório de vendas no calendário da loja (GMV separado por dia, situação e forma de pagamento)', async () => {
      const ctx = setup();
      ctx.orders.find.mockResolvedValue([
        {
          id: 1,
          created_at: new Date('2026-10-10T15:00:00Z'),
          status: OrderStatus.DONE,
          payment_status: PaymentStatus.PAID,
          payment_method: 'PIX',
          total_price: '50.00',
        },
        {
          id: 2,
          created_at: new Date('2026-10-11T15:00:00Z'),
          status: OrderStatus.CANCELED,
          payment_status: PaymentStatus.REFUNDED,
          payment_method: 'PIX',
          total_price: '30.00',
        },
      ]);
      const report = await ctx.service.metrics(
        5,
        { from: '2026-10-10', to: '2026-10-11' },
        NOW,
      );
      expect(report.period).toEqual({
        from: '2026-10-10',
        to: '2026-10-11',
        days: 2,
        time_zone: 'America/Sao_Paulo',
      });
      expect(report.summary).toEqual({
        orders: 2,
        canceled_orders: 1,
        paid_orders: 1,
        gmv: 50,
        average_ticket: 50,
      });
      expect(report.daily).toEqual([
        { date: '2026-10-10', orders: 1, paid_orders: 1, gmv: 50 },
        { date: '2026-10-11', orders: 0, paid_orders: 0, gmv: 0 },
      ]);
      expect(report.by_payment_method).toEqual([
        { method: 'PIX', orders: 1, paid_orders: 1, gmv: 50 },
      ]);
      expect(ctx.orders.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ store_id: 5 }) as unknown,
        }),
      );

      await expect(
        ctx.service.metrics(5, { from: '2026-10-12', to: '2026-10-11' }, NOW),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
