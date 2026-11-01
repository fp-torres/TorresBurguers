import {
  BadRequestException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user';
import { PlanStatus } from '../billing/entities/plan.entity';
import { StoreAccountStatus } from '../store/entities/store.entity';
import { PlatformRole, UserRole } from '../users/entities/user.entity';
import {
  DEFAULT_STORE_INACTIVE_MESSAGE,
  DEFAULT_STORE_NOT_FOUND_MESSAGE,
  NO_DEFAULT_STORE_WARNING,
  PlatformSettingsService,
  SIGNUP_PLAN_NOT_FOUND_MESSAGE,
  SIGNUP_PLAN_REQUIRED_MESSAGE,
  SIGNUP_PLAN_UNAVAILABLE_MESSAGE,
  TEST_EMAIL_LIMIT_MESSAGE,
  TEST_EMAIL_RATE_LIMIT,
  testEmailRateLimit,
} from './platform-settings.service';

const SUPER_ADMIN: AuthUser = {
  id: 1,
  email: 'ops@comestra.com',
  role: UserRole.CLIENT,
  name: 'Ops',
  storeId: null,
  platformRole: PlatformRole.SUPER_ADMIN,
  supportSession: null,
};

const ROW = {
  id: 1,
  default_store_id: 3,
  grace_period_days: 7,
  support_session_minutes: 30,
  store_self_signup_enabled: false,
  self_signup_plan_id: null as number | null,
  updated_by_user_id: null,
  updated_at: new Date('2026-10-01T00:00:00Z'),
};

const PUBLIC_PLAN = {
  id: 2,
  code: 'essencial',
  name: 'Essencial',
  status: PlanStatus.ACTIVE,
  is_public: true,
};

function setup(
  options: {
    row?: object | null;
    store?: object | null;
    plan?: object | null;
    mailResult?: object;
  } = {},
) {
  const settings = {
    findOne: jest
      .fn()
      .mockResolvedValue(options.row === undefined ? { ...ROW } : options.row),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    insert: jest.fn().mockResolvedValue({}),
  };
  const stores = {
    findOne: jest
      .fn()
      .mockResolvedValue(
        options.store === undefined
          ? { id: 4, account_status: StoreAccountStatus.ACTIVE }
          : options.store,
      ),
  };
  const plans = {
    findOne: jest
      .fn()
      .mockResolvedValue(
        options.plan === undefined ? { ...PUBLIC_PLAN } : options.plan,
      ),
  };
  const tenants = { defaultStore: jest.fn().mockResolvedValue(null) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const mail = {
    status: jest.fn().mockReturnValue(MAIL_STATUS),
    send: jest
      .fn()
      .mockResolvedValue(
        options.mailResult ?? { delivered: false, driver: 'log' },
      ),
  };
  const service = new PlatformSettingsService(
    settings as never,
    stores as never,
    plans as never,
    tenants as never,
    audit as never,
    mail as never,
  );
  return { service, settings, stores, plans, tenants, audit, mail };
}

const MAIL_STATUS = {
  driver: 'log',
  smtp_configured: false,
  from: null,
  smtp: null,
  issues: [],
};

describe('PlatformSettingsService', () => {
  const originalSlug = process.env.DEFAULT_STORE_SLUG;
  beforeEach(() => delete process.env.DEFAULT_STORE_SLUG);
  afterAll(() => {
    if (originalSlug === undefined) delete process.env.DEFAULT_STORE_SLUG;
    else process.env.DEFAULT_STORE_SLUG = originalSlug;
  });

  it('sem a linha de configurações: padrões da migração', async () => {
    const { service } = setup({ row: null });
    expect(await service.get()).toMatchObject({
      default_store_id: null,
      grace_period_days: 7,
      support_session_minutes: 30,
      store_self_signup_enabled: false,
      self_signup_plan_id: null,
      self_signup_available: false,
      limits: {
        grace_period_days: { min: 0, max: 60 },
        support_session_minutes: { min: 5, max: 240 },
      },
      updated_by: null,
      mail: MAIL_STATUS,
    });
  });

  it('habilitar o autoatendimento exige um plano ACTIVE e público', async () => {
    await expect(
      setup().service.update({ store_self_signup_enabled: true }, SUPER_ADMIN),
    ).rejects.toThrow(SIGNUP_PLAN_REQUIRED_MESSAGE);

    for (const [plan, message] of [
      [null, SIGNUP_PLAN_NOT_FOUND_MESSAGE],
      [{ ...PUBLIC_PLAN, is_public: false }, SIGNUP_PLAN_UNAVAILABLE_MESSAGE],
      [
        { ...PUBLIC_PLAN, status: PlanStatus.INACTIVE },
        SIGNUP_PLAN_UNAVAILABLE_MESSAGE,
      ],
    ] as const) {
      const { service, settings, audit } = setup({ plan });
      const attempt = service.update(
        { store_self_signup_enabled: true, self_signup_plan_id: 2 },
        SUPER_ADMIN,
      );
      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toThrow(message);
      expect(settings.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    }
  });

  it('religar com um plano que deixou de ser público é recusado; tirar o plano com ele ligado também', async () => {
    const disabled = setup({
      row: { ...ROW, self_signup_plan_id: 2 },
      plan: { ...PUBLIC_PLAN, is_public: false },
    });
    await expect(
      disabled.service.update({ store_self_signup_enabled: true }, SUPER_ADMIN),
    ).rejects.toThrow(SIGNUP_PLAN_UNAVAILABLE_MESSAGE);

    const enabled = setup({
      row: { ...ROW, store_self_signup_enabled: true, self_signup_plan_id: 2 },
    });
    await expect(
      enabled.service.update({ self_signup_plan_id: null }, SUPER_ADMIN),
    ).rejects.toThrow(SIGNUP_PLAN_REQUIRED_MESSAGE);
  });

  it('grava só o que mudou, com quem alterou, e audita antigo → novo', async () => {
    const { service, settings, audit } = setup();
    await service.update(
      {
        store_self_signup_enabled: true,
        self_signup_plan_id: 2,
        grace_period_days: 7, // igual ao atual: não entra
        support_session_minutes: 60,
      },
      SUPER_ADMIN,
    );
    expect(settings.update).toHaveBeenCalledWith(
      { id: 1 },
      {
        store_self_signup_enabled: true,
        self_signup_plan_id: 2,
        support_session_minutes: 60,
        updated_by_user_id: 1,
      },
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: SUPER_ADMIN,
        action: 'platform.settings.update',
        targetType: 'platform_settings',
        metadata: {
          changes: {
            support_session_minutes: { from: 30, to: 60 },
            store_self_signup_enabled: { from: false, to: true },
            self_signup_plan_id: { from: null, to: 2 },
          },
        },
      }),
    );
  });

  it('nada mudou: não grava nem audita', async () => {
    const { service, settings, audit } = setup();
    const result = await service.update(
      { grace_period_days: 7, default_store_id: 3 },
      SUPER_ADMIN,
    );
    expect(settings.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([]);
  });

  it('loja padrão: existente e não desativada; sem loja padrão, aviso', async () => {
    await expect(
      setup({ store: null }).service.update(
        { default_store_id: 9 },
        SUPER_ADMIN,
      ),
    ).rejects.toThrow(DEFAULT_STORE_NOT_FOUND_MESSAGE);
    await expect(
      setup({
        store: { id: 9, account_status: StoreAccountStatus.INACTIVE },
      }).service.update({ default_store_id: 9 }, SUPER_ADMIN),
    ).rejects.toThrow(DEFAULT_STORE_INACTIVE_MESSAGE);

    const cleared = await setup().service.update(
      { default_store_id: null },
      SUPER_ADMIN,
    );
    expect(cleared.warnings).toEqual([NO_DEFAULT_STORE_WARNING]);

    process.env.DEFAULT_STORE_SLUG = 'loja-env';
    const overridden = await setup().service.update(
      { default_store_id: 4 },
      SUPER_ADMIN,
    );
    expect(overridden.warnings[0]).toContain('DEFAULT_STORE_SLUG');
  });

  it('sem a linha no banco: cria com os padrões', async () => {
    const { service, settings } = setup({ row: null });
    await service.update({ grace_period_days: 10 }, SUPER_ADMIN);
    expect(settings.insert).toHaveBeenCalledWith({
      id: 1,
      default_store_id: null,
      grace_period_days: 10,
      support_session_minutes: 30,
      store_self_signup_enabled: false,
      self_signup_plan_id: null,
      updated_by_user_id: 1,
    });
  });

  it('só superadmin altera', async () => {
    const { service, settings } = setup();
    await expect(
      service.update(
        { grace_period_days: 3 },
        {
          ...SUPER_ADMIN,
          platformRole: null,
          role: UserRole.ADMIN,
          storeId: 7,
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(settings.update).not.toHaveBeenCalled();
  });
});

describe('PlatformSettingsService.sendTestEmail', () => {
  const originalLimit = process.env.RATE_LIMIT_TEST_EMAIL;
  const originalEnabled = process.env.RATE_LIMIT_ENABLED;
  beforeEach(() => {
    delete process.env.RATE_LIMIT_TEST_EMAIL;
    delete process.env.RATE_LIMIT_ENABLED;
  });
  afterAll(() => {
    for (const [name, value] of [
      ['RATE_LIMIT_TEST_EMAIL', originalLimit],
      ['RATE_LIMIT_ENABLED', originalEnabled],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const DTO = { to: 'destino@example.com' };

  it('driver de log: envia o e-mail de teste pelo MailService, audita SUCCESS e explica que nada saiu', async () => {
    const { service, mail, audit } = setup();
    const result = await service.sendTestEmail(DTO, SUPER_ADMIN);

    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'destino@example.com',
        subject: 'E-mail de teste',
        text: expect.stringContaining('por Ops') as unknown,
      }),
    );
    expect(result).toEqual({
      to: 'destino@example.com',
      driver: 'log',
      delivered: false,
      message_id: null,
      error: null,
      message: expect.stringContaining('Driver de log ativo') as unknown,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: SUPER_ADMIN,
        action: 'platform.settings.test_email',
        targetType: 'platform_settings',
        targetId: 1,
        result: 'SUCCESS',
        metadata: {
          to: 'destino@example.com',
          driver: 'log',
          delivered: false,
        },
      }),
    );
  });

  it('SMTP aceitou: delivered com o Message-ID', async () => {
    const { service, audit } = setup({
      mailResult: { delivered: true, driver: 'smtp', messageId: '<abc@x>' },
    });
    const result = await service.sendTestEmail(DTO, SUPER_ADMIN);
    expect(result).toMatchObject({
      driver: 'smtp',
      delivered: true,
      message_id: '<abc@x>',
      error: null,
      message: expect.stringContaining('aceito pelo servidor SMTP') as unknown,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        result: 'SUCCESS',
        metadata: expect.objectContaining({ delivered: true }) as unknown,
      }),
    );
  });

  it('SMTP falhou: 200 com o motivo (sem segredos) e auditoria FAILURE', async () => {
    const reason =
      'O servidor SMTP recusou o usuário ou a senha (confira SMTP_USER e SMTP_PASSWORD) (EAUTH 535).';
    const { service, audit } = setup({
      mailResult: { delivered: false, driver: 'smtp', error: reason },
    });
    const result = await service.sendTestEmail(DTO, SUPER_ADMIN);
    expect(result).toMatchObject({
      driver: 'smtp',
      delivered: false,
      message_id: null,
      error: reason,
      message: `O e-mail de teste não foi enviado. ${reason}`,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        result: 'FAILURE',
        metadata: {
          to: 'destino@example.com',
          driver: 'smtp',
          delivered: false,
          error: reason,
        },
      }),
    );
  });

  it('só superadmin (sessão de suporte e equipe → 403, nada é enviado)', async () => {
    const { service, mail, audit } = setup();
    for (const actor of [
      { ...SUPER_ADMIN, platformRole: null, role: UserRole.ADMIN, storeId: 7 },
      {
        ...SUPER_ADMIN,
        supportSession: { id: 3, storeId: 7, operatorId: 1 },
      } as unknown as AuthUser,
    ]) {
      await expect(service.sendTestEmail(DTO, actor)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    }
    expect(mail.send).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('limite por operador (padrão 5 a cada 10 min): o excedente → 429 sem envio nem auditoria', async () => {
    expect(TEST_EMAIL_RATE_LIMIT).toEqual({ limit: 5, windowSeconds: 600 });
    const { service, mail, audit } = setup();
    for (let i = 0; i < 5; i += 1) {
      await service.sendTestEmail(DTO, SUPER_ADMIN);
    }
    const blocked = service.sendTestEmail(DTO, SUPER_ADMIN);
    await expect(blocked).rejects.toBeInstanceOf(HttpException);
    await expect(blocked).rejects.toMatchObject({
      status: 429,
      response: {
        statusCode: 429,
        message: TEST_EMAIL_LIMIT_MESSAGE,
        error: 'Too Many Requests',
      },
    });
    expect(mail.send).toHaveBeenCalledTimes(5);
    expect(audit.record).toHaveBeenCalledTimes(5);

    // Outro operador tem a própria cota
    await service.sendTestEmail(DTO, { ...SUPER_ADMIN, id: 2 });
    expect(mail.send).toHaveBeenCalledTimes(6);
  });

  it('a janela anda: envios antigos deixam de contar', async () => {
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      const { service } = setup();
      for (let i = 0; i < 5; i += 1) {
        await service.sendTestEmail(DTO, SUPER_ADMIN);
      }
      await expect(service.sendTestEmail(DTO, SUPER_ADMIN)).rejects.toThrow(
        TEST_EMAIL_LIMIT_MESSAGE,
      );
      now.mockReturnValue(1_000_000 + 600_000);
      await expect(
        service.sendTestEmail(DTO, SUPER_ADMIN),
      ).resolves.toMatchObject({ driver: 'log' });
    } finally {
      now.mockRestore();
    }
  });

  it('RATE_LIMIT_TEST_EMAIL ajusta o limite; RATE_LIMIT_ENABLED=false desliga', async () => {
    expect(testEmailRateLimit({ RATE_LIMIT_TEST_EMAIL: '2/60' })).toEqual({
      limit: 2,
      windowSeconds: 60,
    });
    for (const invalid of ['', 'abc', '0/60', '5/0', '-1/60']) {
      expect(testEmailRateLimit({ RATE_LIMIT_TEST_EMAIL: invalid })).toEqual(
        TEST_EMAIL_RATE_LIMIT,
      );
    }

    process.env.RATE_LIMIT_TEST_EMAIL = '1/60';
    const limited = setup().service;
    await limited.sendTestEmail(DTO, SUPER_ADMIN);
    await expect(limited.sendTestEmail(DTO, SUPER_ADMIN)).rejects.toThrow(
      TEST_EMAIL_LIMIT_MESSAGE,
    );

    process.env.RATE_LIMIT_ENABLED = 'false';
    const { service, mail } = setup();
    for (let i = 0; i < 3; i += 1) {
      await service.sendTestEmail(DTO, SUPER_ADMIN);
    }
    expect(mail.send).toHaveBeenCalledTimes(3);
  });
});
