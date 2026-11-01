import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../auth/auth-user';
import { StoreAccountStatus } from '../store/entities/store.entity';
import { PlatformRole, UserRole } from '../users/entities/user.entity';
import {
  PASSWORD_LINK_NOTICE,
  PASSWORD_LINK_SENT_NOTICE,
  PlatformUsersService,
  SELF_BLOCK_MESSAGE,
} from './platform-users.service';
import {
  callsOf,
  fakeQueryBuilder,
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

/** Conta como o banco devolve (inclusive campos internos que nunca podem sair). */
const ACCOUNT = {
  id: 12,
  name: 'Maria',
  email: 'maria@loja.com',
  phone: null,
  avatar: null,
  role: UserRole.ADMIN,
  store_id: 7,
  platform_role: null,
  blocked_at: NOW,
  blocked_reason: 'Conta comprometida',
  last_login_at: NOW,
  token_version: 9,
  password_hash: '$2b$10$segredo',
  created_at: NOW,
  updated_at: NOW,
  deleted_at: null,
};

function setup() {
  const users = {
    findOne: jest.fn().mockResolvedValue({ ...ACCOUNT }),
    createQueryBuilder: jest.fn(),
  };
  const stores = {
    findOne: jest.fn().mockResolvedValue({
      id: 7,
      slug: 'loja-7',
      name: 'Loja 7',
      account_status: StoreAccountStatus.ACTIVE,
      owner_user_id: 12,
    }),
    find: jest.fn().mockResolvedValue([
      {
        id: 7,
        slug: 'loja-7',
        name: 'Loja 7',
        account_status: StoreAccountStatus.ACTIVE,
      },
    ]),
  };
  const usersService = {
    block: jest.fn().mockResolvedValue({ ...ACCOUNT }),
    unblock: jest.fn().mockResolvedValue({
      ...ACCOUNT,
      blocked_at: null,
      blocked_reason: null,
    }),
    revokeSessions: jest.fn().mockResolvedValue(undefined),
  };
  const passwordReset = {
    createLinkForUser: jest.fn().mockResolvedValue({
      url: 'http://localhost:5173/redefinir-senha/TOKEN',
      delivered: false,
      expires_at: NOW,
    }),
  };
  const auditLogs = {
    recentAuthEvents: jest
      .fn()
      .mockResolvedValue([{ id: 1, action: 'auth.login.success' }]),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new PlatformUsersService(
    users as never,
    stores as never,
    usersService as never,
    passwordReset as never,
    auditLogs as never,
    audit as never,
  );
  return {
    service,
    users,
    stores,
    usersService,
    passwordReset,
    auditLogs,
    audit,
  };
}

describe('PlatformUsersService', () => {
  it('detalhe: lista de campos permitidos (nunca hash da senha nem versão das sessões)', async () => {
    const { service } = setup();
    const detail = await service.detail(12);
    expect(detail).toMatchObject({
      id: 12,
      role: UserRole.ADMIN,
      store: { id: 7, slug: 'loja-7', account_status: 'ACTIVE' },
      is_owner: true,
      blocked_reason: 'Conta comprometida',
      last_login_at: NOW,
      recent_auth_events: [{ action: 'auth.login.success' }],
    });
    expect(detail).not.toHaveProperty('password_hash');
    expect(detail).not.toHaveProperty('token_version');
    expect(JSON.stringify(detail)).not.toContain('segredo');
  });

  it('bloqueio: motivo repassado ao UsersService; a própria conta nunca', async () => {
    const { service, usersService } = setup();
    await service.block(12, 'Conta comprometida', SUPER_ADMIN, REQUEST);
    expect(usersService.block).toHaveBeenCalledWith(
      12,
      'Conta comprometida',
      SUPER_ADMIN,
      REQUEST,
    );

    usersService.block.mockClear();
    const self = service.block(1, 'Teste', SUPER_ADMIN);
    await expect(self).rejects.toBeInstanceOf(BadRequestException);
    await expect(self).rejects.toThrow(SELF_BLOCK_MESSAGE);
    expect(usersService.block).not.toHaveBeenCalled();
  });

  it('desbloqueio, encerramento de sessões e link de redefinição (exibido uma vez)', async () => {
    const { service, usersService, passwordReset } = setup();
    expect(
      (await service.unblock(12, SUPER_ADMIN, REQUEST)).blocked_at,
    ).toBeNull();
    const revoked = await service.revokeSessions(12, SUPER_ADMIN, REQUEST);
    expect(usersService.revokeSessions).toHaveBeenCalledWith(
      12,
      SUPER_ADMIN,
      REQUEST,
    );
    expect(revoked.message).toContain('sessões');

    const link = await service.passwordResetLink(12, SUPER_ADMIN, REQUEST);
    expect(passwordReset.createLinkForUser).toHaveBeenCalledWith(
      12,
      SUPER_ADMIN,
      REQUEST,
    );
    expect(link).toEqual({
      url: 'http://localhost:5173/redefinir-senha/TOKEN',
      delivered: false,
      expires_at: NOW,
      message: PASSWORD_LINK_NOTICE,
    });

    // Com SMTP, o link foi para o e-mail do titular: o operador não recebe a URL
    passwordReset.createLinkForUser.mockResolvedValueOnce({
      url: null,
      delivered: true,
      email_masked: 'ma***@email.com',
      expires_at: NOW,
    });
    const sent = await service.passwordResetLink(12, SUPER_ADMIN, REQUEST);
    expect(sent).toEqual({
      url: null,
      delivered: true,
      expires_at: NOW,
      message: PASSWORD_LINK_SENT_NOTICE('ma***@email.com'),
    });
    expect(sent.message).toContain('ma***@email.com');
  });

  it('ações exigem superadmin fora de sessão de suporte', async () => {
    const { service, usersService, passwordReset } = setup();
    const support: AuthUser = {
      ...SUPER_ADMIN,
      role: UserRole.ADMIN,
      storeId: 7,
      platformRole: null,
      supportSession: { id: 2, storeId: 7, expiresAt: NOW },
    };
    for (const attempt of [
      service.block(12, 'x', support),
      service.unblock(12, support),
      service.revokeSessions(12, support),
      service.passwordResetLink(12, support),
    ]) {
      await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(usersService.block).not.toHaveBeenCalled();
    expect(passwordReset.createLinkForUser).not.toHaveBeenCalled();
  });

  it('lista: filtros validados, lixeira opcional e ordenação da whitelist', async () => {
    const { service, users, stores } = setup();
    const qb = fakeQueryBuilder({ getManyAndCount: [[{ ...ACCOUNT }], 1] });
    users.createQueryBuilder.mockReturnValue(qb);

    const result = await service.list({
      search: '(21) 9999',
      platform_role: 'NONE',
      blocked: true,
      include_deleted: true,
      sort: 'last_login_at',
      store_id: 7,
    });

    expect(callsOf(qb, 'withDeleted')).toHaveLength(1);
    const sql = sqlOf(qb);
    expect(sql).toContain('u.platform_role IS NULL');
    expect(sql).toContain('u.blocked_at IS NOT NULL');
    expect(sql).toContain('u.store_id = :storeId');
    expect(callsOf(qb, 'orderBy')).toEqual([
      ['u.last_login_at', 'DESC', 'NULLS LAST'],
    ]);
    expect(stores.find).toHaveBeenCalledTimes(1);
    expect(result.items[0]).toMatchObject({
      id: 12,
      store: { id: 7, slug: 'loja-7' },
    });
    expect(result.items[0]).not.toHaveProperty('password_hash');
  });

  it('leituras de dados pessoais ficam na auditoria: lista (filtros e quantidade) e detalhe (alvo)', async () => {
    const { service, users, audit } = setup();
    const qb = fakeQueryBuilder({ getManyAndCount: [[{ ...ACCOUNT }], 41] });
    users.createQueryBuilder.mockReturnValue(qb);

    await service.list(
      { search: 'maria@', include_deleted: true, pageSize: 100 },
      SUPER_ADMIN,
      REQUEST,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: SUPER_ADMIN,
        action: 'platform.users.list',
        targetType: 'user',
        request: REQUEST,
        metadata: expect.objectContaining({
          filters: expect.objectContaining({
            search: 'maria@',
            include_deleted: true,
          }) as unknown,
          page: 1,
          page_size: 100,
          returned: 1,
          total: 41,
        }) as unknown,
      }),
    );

    await service.detail(12, SUPER_ADMIN, REQUEST);
    expect(audit.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actor: SUPER_ADMIN,
        action: 'platform.users.view',
        targetType: 'user',
        targetId: 12,
        storeId: 7,
        request: REQUEST,
      }),
    );
    // Nada de dados da conta lida na trilha (só o alvo)
    expect(JSON.stringify(audit.record.mock.calls.at(-1))).not.toContain(
      ACCOUNT.email,
    );
  });
});
