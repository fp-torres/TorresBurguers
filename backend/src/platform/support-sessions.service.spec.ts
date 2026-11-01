import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import { IsNull, LessThanOrEqual, MoreThan, Not } from 'typeorm';
import type { AuthUser } from '../auth/auth-user';
import { StoreAccountStatus } from '../store/entities/store.entity';
import { PlatformRole, UserRole } from '../users/entities/user.entity';
import type { SupportSession } from './entities/support-session.entity';
import {
  SUPPORT_SESSION_INACTIVE_STORE_MESSAGE,
  SupportSessionsService,
  supportSessionMinutes,
} from './support-sessions.service';

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

const REQUEST = {
  ip: '203.0.113.9',
  headers: { 'user-agent': 'jest' },
} as unknown as Request;

function setup(
  options: {
    store?: object | null;
    operator?: object | null;
    minutes?: number | null;
  } = {},
) {
  const sessions = {
    create: jest.fn((data: Partial<SupportSession>) => ({ ...data })),
    save: jest.fn((data: Partial<SupportSession>) =>
      Promise.resolve({ ...data, id: 55, started_at: NOW }),
    ),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    findOne: jest.fn(),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
  };
  const stores = {
    findOne: jest.fn().mockResolvedValue(
      options.store === undefined
        ? {
            id: 7,
            slug: 'loja-7',
            name: 'Loja 7',
            account_status: StoreAccountStatus.ACTIVE,
          }
        : options.store,
    ),
  };
  const users = {
    findOne: jest.fn().mockResolvedValue(
      options.operator === undefined
        ? {
            id: 1,
            email: 'ops@comestra.com',
            role: UserRole.CLIENT,
            name: 'Ops',
            token_version: 4,
            platform_role: PlatformRole.SUPER_ADMIN,
            blocked_at: null,
          }
        : options.operator,
    ),
  };
  const settings = {
    findOne: jest
      .fn()
      .mockResolvedValue(
        options.minutes === null
          ? null
          : { id: 1, support_session_minutes: options.minutes ?? 45 },
      ),
  };
  const jwt = { sign: jest.fn().mockReturnValue('token-de-suporte') };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new SupportSessionsService(
    sessions as never,
    stores as never,
    users as never,
    settings as never,
    jwt as never,
    audit as never,
  );
  return { service, sessions, stores, users, settings, jwt, audit };
}

describe('SupportSessionsService', () => {
  it('abre a sessão: token do PRÓPRIO superadmin com tv atual, sid e validade da sessão', async () => {
    const { service, sessions, jwt, audit } = setup();
    const result = await service.start(
      7,
      '  Chamado 42: conferir a entrega  ',
      SUPER_ADMIN,
      REQUEST,
      NOW,
    );

    const expiresAt = new Date(NOW.getTime() + 45 * 60_000);
    expect(sessions.create).toHaveBeenCalledWith({
      platform_user_id: 1,
      store_id: 7,
      reason: 'Chamado 42: conferir a entrega',
      expires_at: expiresAt,
      ended_at: null,
      ip: '203.0.113.9',
    });
    expect(jwt.sign).toHaveBeenCalledWith(
      {
        sub: 1,
        email: 'ops@comestra.com',
        role: UserRole.CLIENT,
        name: 'Ops',
        tv: 4,
        sid: 55,
      },
      { expiresIn: 45 * 60 },
    );
    expect(result).toMatchObject({
      access_token: 'token-de-suporte',
      expires_at: expiresAt,
      session: {
        id: 55,
        store_id: 7,
        store: { id: 7, slug: 'loja-7', name: 'Loja 7' },
        platform_user: { id: 1, name: 'Ops', email: 'ops@comestra.com' },
        status: 'ACTIVE',
        active: true,
      },
    });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: SUPER_ADMIN,
        storeId: 7,
        action: 'platform.support_session.start',
        targetType: 'support_session',
        targetId: 55,
        metadata: expect.objectContaining({
          reason: 'Chamado 42: conferir a entrega',
          minutes: 45,
        }) as unknown,
      }),
    );
    // O token nunca vai para a auditoria
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(
      'token-de-suporte',
    );
  });

  it('duração: padrão de 30 minutos sem configuração; sempre entre 5 e 240', async () => {
    const { service, jwt } = setup({ minutes: null });
    await service.start(7, 'Motivo com mais de 10', SUPER_ADMIN, REQUEST, NOW);
    expect(jwt.sign).toHaveBeenCalledWith(expect.anything(), {
      expiresIn: 30 * 60,
    });
    expect(supportSessionMinutes(1000)).toBe(240);
    expect(supportSessionMinutes(1)).toBe(5);
    expect(supportSessionMinutes('abc')).toBe(30);
  });

  it('recusa loja inexistente (404) ou desativada (400)', async () => {
    await expect(
      setup({ store: null }).service.start(9, 'Motivo válido!!', SUPER_ADMIN),
    ).rejects.toBeInstanceOf(NotFoundException);
    const inactive = setup({
      store: {
        id: 7,
        slug: 'x',
        name: 'X',
        account_status: StoreAccountStatus.INACTIVE,
      },
    });
    const attempt = inactive.service.start(7, 'Motivo válido!!', SUPER_ADMIN);
    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    await expect(attempt).rejects.toThrow(
      SUPPORT_SESSION_INACTIVE_STORE_MESSAGE,
    );
    expect(inactive.sessions.save).not.toHaveBeenCalled();
  });

  it('só superadmin fora de sessão de suporte, e a conta precisa continuar superadmin no banco', async () => {
    const supportActor: AuthUser = {
      ...SUPER_ADMIN,
      supportSession: { id: 3, storeId: 7, expiresAt: NOW },
    };
    for (const actor of [
      supportActor,
      { ...SUPER_ADMIN, platformRole: null },
    ]) {
      const { service, jwt } = setup();
      await expect(
        service.start(7, 'Motivo válido!!', actor),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(jwt.sign).not.toHaveBeenCalled();
    }
    for (const operator of [
      null,
      { id: 1, platform_role: null, blocked_at: null },
      { id: 1, platform_role: PlatformRole.SUPER_ADMIN, blocked_at: NOW },
    ]) {
      const { service, jwt } = setup({ operator });
      await expect(
        service.start(7, 'Motivo válido!!', SUPER_ADMIN),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(jwt.sign).not.toHaveBeenCalled();
    }
  });

  it('encerra a sessão aberta (auditado) e é idempotente', async () => {
    const { service, sessions, audit } = setup();
    sessions.findOne.mockResolvedValue({
      id: 55,
      store_id: 7,
      platform_user_id: 1,
      reason: 'Motivo',
      started_at: new Date(NOW.getTime() - 20 * 60_000),
      expires_at: new Date(NOW.getTime() + 10 * 60_000),
      ended_at: null,
      store: { id: 7, slug: 'loja-7', name: 'Loja 7' },
      platform_user: { id: 1, name: 'Ops', email: 'ops@comestra.com' },
    });
    const ended = await service.end(55, SUPER_ADMIN, REQUEST, NOW);
    expect(sessions.update).toHaveBeenCalledWith(
      { id: 55, ended_at: IsNull() },
      { ended_at: NOW },
    );
    expect(ended).toMatchObject({ status: 'ENDED', active: false });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform.support_session.end',
        storeId: 7,
        targetId: 55,
        metadata: expect.objectContaining({
          duration_minutes: 20,
          expired_before_end: false,
        }) as unknown,
      }),
    );

    sessions.update.mockClear();
    audit.record.mockClear();
    sessions.findOne.mockResolvedValue({
      id: 55,
      store_id: 7,
      expires_at: NOW,
      ended_at: NOW,
    });
    await service.end(55, SUPER_ADMIN, REQUEST, NOW);
    expect(sessions.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();

    sessions.findOne.mockResolvedValue(null);
    await expect(service.end(99, SUPER_ADMIN)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('lista com filtros de loja e situação (ativas ou não)', async () => {
    const { service, sessions } = setup();
    await service.list(
      { store_id: 7, active: true, page: 2, pageSize: 10 },
      NOW,
    );
    expect(sessions.findAndCount).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { store_id: 7, ended_at: IsNull(), expires_at: MoreThan(NOW) },
        skip: 10,
        take: 10,
        withDeleted: true,
      }),
    );
    await service.list({ active: false }, NOW);
    expect(sessions.findAndCount).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: [
          { ended_at: Not(IsNull()) },
          { ended_at: IsNull(), expires_at: LessThanOrEqual(NOW) },
        ],
      }),
    );
  });

  it('nunca aceita uma sessão de suporte para abrir outra', async () => {
    const { service } = setup();
    await expect(
      service.start(7, 'Motivo válido!!', {
        ...SUPER_ADMIN,
        platformRole: PlatformRole.SUPER_ADMIN,
        supportSession: { id: 1, storeId: 7, expiresAt: NOW },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.end(1, {
        ...SUPER_ADMIN,
        role: UserRole.ADMIN,
        platformRole: null,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
