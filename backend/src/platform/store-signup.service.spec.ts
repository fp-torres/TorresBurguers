import {
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import { PlanStatus } from '../billing/entities/plan.entity';
import { SubscriptionStatus } from '../billing/entities/subscription.entity';
import { ACCOUNT_EXISTS_MESSAGE } from '../invitations/invitations.service';
import { StoreAccountStatus } from '../store/entities/store.entity';
import { StoreSlugHistory } from '../store/entities/store-slug-history.entity';
import { UserRole } from '../users/entities/user.entity';
import {
  SLUG_RESERVED_MESSAGE,
  SLUG_TAKEN_MESSAGE,
} from './store-identity-rules';
import {
  SIGNUP_UNAVAILABLE_MESSAGE,
  StoreSignupService,
} from './store-signup.service';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const REQUEST = { ip: '198.51.100.7', headers: {} } as unknown as Request;
const PASSWORD = 'SenhaForte1';

const DTO = {
  store: { name: 'Pizzaria São João', slug: 'pizzaria-sao-joao' },
  owner: {
    name: 'João',
    email: 'Joao@Pizzaria.com',
    password: PASSWORD,
    phone: '21999990000',
  },
  accept_terms: true,
};

function setup(
  options: { settings?: object | null; plan?: object | null } = {},
) {
  const storeTx = {
    create: jest.fn((data: object) => ({ ...data })),
    save: jest.fn((data: object) =>
      Promise.resolve({ ...data, id: 77, created_at: NOW, updated_at: NOW }),
    ),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const userTx = { marker: 'repositório de usuários da transação' };
  const manager = {
    getRepository: jest.fn((entity: { name: string }) =>
      entity.name === 'User' ? userTx : storeTx,
    ),
  };
  // Endereços que já foram de outra loja (trocados pelo superpainel)
  const slugHistory = { exists: jest.fn().mockResolvedValue(false) };
  const stores = {
    exists: jest.fn().mockResolvedValue(false),
    manager: {
      getRepository: jest.fn((entity: unknown) =>
        entity === StoreSlugHistory ? slugHistory : undefined,
      ),
      transaction: jest.fn((work: (m: typeof manager) => Promise<unknown>) =>
        work(manager),
      ),
    },
  };
  const settings = {
    findOne: jest
      .fn()
      .mockResolvedValue(
        options.settings === undefined
          ? { id: 1, store_self_signup_enabled: true, self_signup_plan_id: 2 }
          : options.settings,
      ),
  };
  const plans = {
    findOne: jest.fn().mockResolvedValue(
      options.plan === undefined
        ? {
            id: 2,
            code: 'essencial',
            name: 'Essencial',
            status: PlanStatus.ACTIVE,
            is_public: true,
          }
        : options.plan,
    ),
  };
  const usersService = {
    emailInUse: jest.fn().mockResolvedValue(false),
    insertUser: jest.fn().mockResolvedValue({
      id: 40,
      name: 'João',
      email: 'joao@pizzaria.com',
      phone: '21999990000',
      role: UserRole.ADMIN,
      store_id: 77,
      platform_role: null,
      token_version: 0,
      password_hash: '$2b$10$hash-que-nunca-sai',
      created_at: NOW,
      updated_at: NOW,
    }),
    recordLogin: jest.fn().mockResolvedValue(undefined),
    startVerification: jest.fn(),
  };
  const subscriptionsService = {
    createForStore: jest.fn().mockResolvedValue({
      id: 300,
      plan_id: 2,
      status: SubscriptionStatus.TRIALING,
      billing_provider: 'MANUAL',
    }),
  };
  const sessionTokens = { issue: jest.fn().mockReturnValue('token-da-sessao') };
  const rateLimit = { consume: jest.fn() };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new StoreSignupService(
    stores as never,
    settings as never,
    plans as never,
    usersService as never,
    subscriptionsService as never,
    sessionTokens as never,
    rateLimit as never,
    audit as never,
  );
  return {
    service,
    slugHistory,
    storeTx,
    userTx,
    manager,
    stores,
    settings,
    plans,
    usersService,
    subscriptionsService,
    sessionTokens,
    rateLimit,
    audit,
  };
}

describe('StoreSignupService', () => {
  it('cria loja, conta do dono (ADMIN) e assinatura numa transação e já devolve a sessão', async () => {
    const ctx = setup();
    const result = await ctx.service.signup(DTO, REQUEST);

    expect(ctx.rateLimit.consume).toHaveBeenCalledWith(
      'STORE_SIGNUP',
      '198.51.100.7',
    );
    expect(ctx.storeTx.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Pizzaria São João',
        slug: 'pizzaria-sao-joao',
        account_status: StoreAccountStatus.ACTIVE,
        is_open: false,
        delivery_enabled: false,
        takeout_enabled: true,
      }),
    );
    expect(ctx.usersService.insertUser).toHaveBeenCalledWith(
      ctx.userTx,
      {
        name: 'João',
        email: 'joao@pizzaria.com',
        password: PASSWORD,
        phone: '21999990000',
      },
      { role: UserRole.ADMIN, storeId: 77 },
      ACCOUNT_EXISTS_MESSAGE,
    );
    expect(ctx.storeTx.update).toHaveBeenCalledWith(
      { id: 77 },
      { owner_user_id: 40 },
    );
    expect(ctx.subscriptionsService.createForStore).toHaveBeenCalledWith(
      77,
      2,
      expect.objectContaining({
        manager: ctx.manager,
        provider: 'MANUAL',
        actor: expect.objectContaining({
          id: 40,
          role: UserRole.ADMIN,
          storeId: 77,
          platformRole: null,
        }) as unknown,
      }),
    );
    expect(ctx.stores.manager.transaction).toHaveBeenCalledTimes(1);

    expect(ctx.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform.store.self_signup',
        storeId: 77,
        scope: 'STORE',
        metadata: expect.objectContaining({
          slug: 'pizzaria-sao-joao',
          plan_code: 'essencial',
          subscription_id: 300,
          owner_user_id: 40,
          terms_accepted: true,
        }) as unknown,
      }),
    );
    expect(ctx.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'subscription.create' }),
    );
    expect(ctx.usersService.recordLogin).toHaveBeenCalledWith(40);
    // Verificação do e-mail do responsável em segundo plano (como no cadastro de cliente)
    expect(ctx.usersService.startVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 40,
        email: 'joao@pizzaria.com',
        store_id: 77,
      }),
    );

    // Mesmo formato do login: { access_token, user: SessionUser }
    expect(result).toEqual({
      access_token: 'token-da-sessao',
      user: {
        id: 40,
        name: 'João',
        email: 'joao@pizzaria.com',
        phone: '21999990000',
        avatar: null,
        role: UserRole.ADMIN,
        store_id: 77,
        platform_role: null,
        store: {
          id: 77,
          slug: 'pizzaria-sao-joao',
          name: 'Pizzaria São João',
          logo: null,
          primary_color: null,
          account_status: StoreAccountStatus.ACTIVE,
        },
        created_at: NOW,
        updated_at: NOW,
      },
    });
    // Senha e hash nunca saem (nem na resposta nem na auditoria)
    const everything = JSON.stringify([result, ctx.audit.record.mock.calls]);
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain('hash-que-nunca-sai');
  });

  it('autoatendimento desligado, sem plano, plano privado ou inativo → 404', async () => {
    for (const options of [
      { settings: null },
      {
        settings: {
          id: 1,
          store_self_signup_enabled: false,
          self_signup_plan_id: 2,
        },
      },
      {
        settings: {
          id: 1,
          store_self_signup_enabled: true,
          self_signup_plan_id: null,
        },
      },
      { plan: null },
      { plan: { id: 2, status: PlanStatus.ACTIVE, is_public: false } },
      { plan: { id: 2, status: PlanStatus.INACTIVE, is_public: true } },
    ]) {
      const ctx = setup(options);
      const attempt = ctx.service.signup(DTO, REQUEST);
      await expect(attempt).rejects.toBeInstanceOf(NotFoundException);
      await expect(attempt).rejects.toThrow(SIGNUP_UNAVAILABLE_MESSAGE);
      expect(ctx.rateLimit.consume).toHaveBeenCalled();
      expect(ctx.stores.manager.transaction).not.toHaveBeenCalled();
    }
  });

  it('endereço ou e-mail já usados → 409 antes de gravar', async () => {
    const slug = setup();
    slug.stores.exists.mockResolvedValue(true);
    await expect(slug.service.signup(DTO, REQUEST)).rejects.toThrow(
      SLUG_TAKEN_MESSAGE,
    );

    const email = setup();
    email.usersService.emailInUse.mockResolvedValue(true);
    const attempt = email.service.signup(DTO, REQUEST);
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toThrow(ACCOUNT_EXISTS_MESSAGE);
    expect(email.usersService.emailInUse).toHaveBeenCalledWith(
      'joao@pizzaria.com',
    );

    for (const ctx of [slug, email]) {
      expect(ctx.stores.manager.transaction).not.toHaveBeenCalled();
    }
  });

  it('endereço da loja padrão (DEFAULT_STORE_SLUG) fica reservado, mesmo sem loja com ele (rotas antigas e app)', async () => {
    const saved = process.env.DEFAULT_STORE_SLUG;
    process.env.DEFAULT_STORE_SLUG = ` ${DTO.store.slug.toUpperCase()} `;
    try {
      const ctx = setup();
      await expect(ctx.service.signup(DTO, REQUEST)).rejects.toThrow(
        new ConflictException(SLUG_RESERVED_MESSAGE),
      );
      expect(ctx.stores.manager.transaction).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env.DEFAULT_STORE_SLUG;
      else process.env.DEFAULT_STORE_SLUG = saved;
    }
  });

  it('endereço que já foi de outra loja (trocado pelo superpainel) → 409 como endereço em uso', async () => {
    const ctx = setup();
    ctx.slugHistory.exists.mockResolvedValue(true);
    await expect(ctx.service.signup(DTO, REQUEST)).rejects.toThrow(
      new ConflictException(SLUG_TAKEN_MESSAGE),
    );
    expect(ctx.slugHistory.exists).toHaveBeenCalledWith({
      where: { slug: DTO.store.slug },
    });
    expect(ctx.stores.manager.transaction).not.toHaveBeenCalled();
  });

  it('limite de tentativas por IP (429) antes de qualquer consulta', async () => {
    const ctx = setup();
    ctx.rateLimit.consume.mockImplementation(() => {
      throw new HttpException(
        'Muitas tentativas',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    });
    await expect(ctx.service.signup(DTO, REQUEST)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(ctx.settings.findOne).not.toHaveBeenCalled();
  });

  it('falha no meio (ex.: e-mail criado ao mesmo tempo) desfaz tudo: nada é auditado nem logado', async () => {
    const ctx = setup();
    ctx.usersService.insertUser.mockRejectedValue(
      new ConflictException(ACCOUNT_EXISTS_MESSAGE),
    );
    await expect(ctx.service.signup(DTO, REQUEST)).rejects.toThrow(
      ACCOUNT_EXISTS_MESSAGE,
    );
    expect(ctx.subscriptionsService.createForStore).not.toHaveBeenCalled();
    expect(ctx.audit.record).not.toHaveBeenCalled();
    expect(ctx.usersService.recordLogin).not.toHaveBeenCalled();
    expect(ctx.usersService.startVerification).not.toHaveBeenCalled();
    expect(ctx.sessionTokens.issue).not.toHaveBeenCalled();
  });
});
