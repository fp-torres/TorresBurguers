import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import type { Request } from 'express';
import { FindOperator, Repository } from 'typeorm';
import type { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth-user';
import { PasswordResetToken } from '../auth/entities/password-reset-token.entity';
import { SessionTokenService } from '../auth/session-token.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { User, UserRole } from '../users/entities/user.entity';
import type { UsersService } from '../users/users.service';
import { CURRENT_PASSWORD_WRONG_MESSAGE } from '../users/users.service';
import { AccountEmailTokensService } from './account-email-tokens.service';
import type { AccountNoticesService } from './account-notices.service';
import {
  AccountSecurityService,
  EMAIL_ALREADY_VERIFIED_MESSAGE,
  EMAIL_CHANGE_LINK_INVALID_MESSAGE,
  EMAIL_CHANGE_SAME_MESSAGE,
  EMAIL_CHANGE_TAKEN_MESSAGE,
  EMAIL_VERIFICATION_LINK_INVALID_MESSAGE,
  NEW_PASSWORD_SAME_MESSAGE,
  emailChangeRequestedMessage,
} from './account-security.service';
import {
  AccountEmailToken,
  AccountEmailTokenPurpose,
} from './entities/account-email-token.entity';

type Where = Record<string, unknown>;
const SECRET = 'segredo-de-teste';
const PASSWORD = 'SenhaAtual#2026';
const { VERIFY, CHANGE, REVERT } = AccountEmailTokenPurpose;

function check(value: unknown, condition: unknown): boolean {
  if (condition instanceof FindOperator) {
    const op = condition as FindOperator<unknown>;
    switch (op.type) {
      case 'isNull':
        return value === null || value === undefined;
      case 'in':
        return (op.value as unknown[]).includes(value);
      case 'not':
        return value !== op.value;
      case 'moreThan':
        return (
          value instanceof Date &&
          value.getTime() > (op.value as Date).getTime()
        );
      case 'raw': {
        // emailEquals(): LOWER(email) = :normalizedEmail
        const params = op.objectLiteralParameters as {
          normalizedEmail: string;
        };
        return String(value).toLowerCase() === params.normalizedEmail;
      }
      default:
        throw new Error(`Operador não suportado no teste: ${op.type}`);
    }
  }
  return value === condition;
}
const matches = (row: object, where: Where) =>
  Object.entries(where).every(([key, condition]) =>
    check((row as Where)[key], condition),
  );

function makeUser(id: number, extra: Partial<User> = {}): User {
  return Object.assign(new User(), {
    id,
    name: `Pessoa ${id}`,
    email: `pessoa${id}@email.com`,
    role: UserRole.CLIENT,
    store_id: null,
    platform_role: null,
    blocked_at: null,
    deleted_at: null,
    email_verified_at: null,
    token_version: 0,
    ...extra,
  });
}

const actorOf = (user: User): AuthUser => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  storeId: user.store_id,
  platformRole: null,
  supportSession: null,
});

const fromIp = (ip: string) =>
  ({ ip, headers: { 'user-agent': 'jest' } }) as unknown as Request;

async function setup(users: User[]) {
  const hashes = new Map<number, string>();
  for (const user of users) hashes.set(user.id, await bcrypt.hash(PASSWORD, 4));

  const usersRepo = {
    findOne: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(
        users.find((user) => !user.deleted_at && matches(user, where)) ?? null,
      ),
    ),
    exists: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(users.some((user) => matches(user, where))),
    ),
    update: jest.fn((where: Where, partial: Where) => {
      const hit = users.filter((user) => matches(user, where));
      for (const user of hit) {
        for (const [key, value] of Object.entries(partial)) {
          if (key === 'token_version') user.token_version += 1;
          else if (key === 'password_hash') hashes.set(user.id, String(value));
          else (user as unknown as Where)[key] = value;
        }
      }
      return Promise.resolve({ affected: hit.length });
    }),
  };

  const tokenRows: AccountEmailToken[] = [];
  const deleteQuery = {
    delete: () => deleteQuery,
    from: () => deleteQuery,
    where: () => deleteQuery,
    andWhere: () => deleteQuery,
    execute: () => Promise.resolve({ affected: 0 }),
  };
  const tokensRepo = {
    create: (data: Partial<AccountEmailToken>) =>
      Object.assign(new AccountEmailToken(), data),
    save: (row: AccountEmailToken) => {
      Object.assign(row, { id: tokenRows.length + 1, created_at: new Date() });
      tokenRows.push(row);
      return Promise.resolve(row);
    },
    update: (where: Where, partial: Where) => {
      const hit = tokenRows.filter((row) => matches(row, where));
      hit.forEach((row) => Object.assign(row, partial));
      return Promise.resolve({ affected: hit.length });
    },
    findOne: ({ where }: { where: Where }) =>
      Promise.resolve(tokenRows.find((row) => matches(row, where)) ?? null),
    exists: ({ where }: { where: Where }) =>
      Promise.resolve(tokenRows.some((row) => matches(row, where))),
    createQueryBuilder: () => deleteQuery,
    manager: {} as Record<string, unknown>,
  };
  const resetLinks = { update: jest.fn().mockResolvedValue({ affected: 0 }) };
  // A transação usa os mesmos repositórios falsos
  const manager: Record<string, unknown> = {};
  manager.getRepository = (entity: unknown): unknown =>
    entity === AccountEmailToken
      ? tokensRepo
      : entity === PasswordResetToken
        ? resetLinks
        : usersRepo;
  manager.transaction = jest.fn((work: (m: unknown) => unknown) =>
    work(manager),
  );
  tokensRepo.manager = manager;
  Object.assign(usersRepo, { manager });

  const tokens = new AccountEmailTokensService(
    tokensRepo as unknown as Repository<AccountEmailToken>,
  );
  const rateLimit = new RateLimitService();
  const usersService = {
    findAccount: jest.fn((id: number) => {
      const user = users.find((u) => u.id === id && !u.deleted_at);
      if (!user) throw new NotFoundException('Usuário não encontrado');
      return Promise.resolve(user);
    }),
    passwordMatches: jest.fn((id: number, password: string) =>
      bcrypt.compare(password, hashes.get(id) ?? ''),
    ),
    reserveCredentialsAttempt: jest.fn((id: number, request?: Request) => {
      const a = rateLimit.take('CREDENTIALS_CHANGE', `user:${id}`);
      const b = rateLimit.take(
        'CREDENTIALS_CHANGE',
        `ip:${request?.ip ?? 'desconhecido'}`,
      );
      return () => {
        a();
        b();
      };
    }),
    emailInUse: jest.fn(async (email: string, ignoreId?: number) => {
      const taken = users.some(
        (u) =>
          u.email.toLowerCase() === email.toLowerCase() && u.id !== ignoreId,
      );
      return taken || tokens.isReserved(email, ignoreId);
    }),
    presentSession: jest.fn((user: User) =>
      Promise.resolve({ id: user.id, email: user.email, name: user.name }),
    ),
  };
  const notices = {
    verification: jest.fn().mockResolvedValue(true),
    changeConfirm: jest.fn().mockResolvedValue(true),
    changeInUse: jest.fn().mockResolvedValue(true),
    emailChanged: jest.fn().mockResolvedValue(true),
    changeReverted: jest.fn().mockResolvedValue(true),
    passwordChanged: jest.fn().mockResolvedValue(true),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const jwt = new JwtService({ secret: SECRET });
  const service = new AccountSecurityService(
    usersRepo as unknown as Repository<User>,
    usersService as unknown as UsersService,
    tokens,
    notices as unknown as AccountNoticesService,
    new SessionTokenService(jwt),
    audit as unknown as AuditService,
    rateLimit,
  );

  /** Planta um código conhecido no link em aberto mais recente (como o E2E faz no banco). */
  async function linkFor(userId: number, purpose: AccountEmailTokenPurpose) {
    const row = [...tokenRows]
      .reverse()
      .find(
        (r) =>
          r.user_id === userId &&
          r.purpose === purpose &&
          !r.used_at &&
          !r.revoked_at,
      );
    if (!row) throw new Error(`sem link ${purpose} da conta ${userId}`);
    const issued = await tokens.issue({
      userId,
      purpose: REVERT,
      email: 'descartavel@x.com',
      previousEmail: 'x@x.com',
    });
    // Reaproveita um código válido no lugar do hash da linha alvo
    row.token_hash = issued.record.token_hash;
    tokenRows.splice(tokenRows.indexOf(issued.record), 1);
    return issued.token;
  }

  return {
    service,
    users,
    hashes,
    tokenRows,
    tokens,
    usersService,
    notices,
    audit,
    rateLimit,
    resetLinks,
    jwt,
    linkFor,
  };
}

describe('AccountSecurityService', () => {
  const originalEnv = { ...process.env };

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.RATE_LIMIT_ENABLED = 'true';
    process.env.APP_WEB_URL = 'https://app.comestra.com.br';
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('RATE_LIMIT_') && key !== 'RATE_LIMIT_ENABLED') {
        delete process.env[key];
      }
    }
    delete process.env.ACCOUNT_SECURITY_MODE;
  });

  afterAll(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  describe('view', () => {
    it('e-mail, confirmação, troca pendente e o modo (compat; strict ainda não existe nesta versão)', async () => {
      const ctx = await setup([makeUser(1)]);
      const me = actorOf(ctx.users[0]);
      await expect(ctx.service.view(me)).resolves.toEqual({
        email: 'pessoa1@email.com',
        email_verified: false,
        email_verified_at: null,
        email_change: null,
        account_security_mode: 'compat',
      });
      await ctx.service.requestEmailChange(me, {
        email: 'novo@email.com',
        current_password: PASSWORD,
      });
      process.env.ACCOUNT_SECURITY_MODE = 'strict';
      const view = await ctx.service.view(me);
      expect(view.email_change).toMatchObject({ email: 'novo@email.com' });
      expect(view.account_security_mode).toBe('compat');
    });
  });

  describe('changePassword', () => {
    it('senha certa: hash novo, sessões encerradas, links pendentes vencidos, troca de e-mail cancelada, aviso e sessão nova', async () => {
      const ctx = await setup([makeUser(1, { token_version: 3 })]);
      const me = actorOf(ctx.users[0]);
      await ctx.service.requestEmailChange(me, {
        email: 'novo@email.com',
        current_password: PASSWORD,
      });

      const result = await ctx.service.changePassword(me, {
        current_password: PASSWORD,
        password: 'NovaSenha#2026',
      });

      expect(ctx.users[0].token_version).toBe(4);
      await expect(
        bcrypt.compare('NovaSenha#2026', ctx.hashes.get(1)!),
      ).resolves.toBe(true);
      expect(ctx.resetLinks.update).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: 1 }),
        { expires_at: expect.any(Date) as unknown },
      );
      expect(
        ctx.tokenRows.find((r) => r.purpose === CHANGE)?.revoked_at,
      ).toBeInstanceOf(Date);
      expect(ctx.notices.passwordChanged).toHaveBeenCalledTimes(1);
      expect(ctx.notices.passwordChanged).toHaveBeenCalledWith(
        ctx.users[0],
        'pessoa1@email.com',
        { changedAt: expect.any(Date) as unknown },
      );
      expect(ctx.audit.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'account.credentials.change',
          metadata: { fields: ['password'], via: 'account_password' },
        }),
      );
      // Mesmo formato do login, com a versão nova das sessões no token
      expect(Object.keys(result).sort()).toEqual(['access_token', 'user']);
      const claims = ctx.jwt.verify<{ sub: number; tv: number }>(
        result.access_token,
      );
      expect(claims).toMatchObject({ sub: 1, tv: 4 });
      expect(JSON.stringify(ctx.audit.record.mock.calls)).not.toContain(
        'NovaSenha#2026',
      );
    });

    it('senha atual errada → 400 e conta no CREDENTIALS_CHANGE (10 → 429); acertos devolvem a vaga', async () => {
      const ctx = await setup([makeUser(1)]);
      const me = actorOf(ctx.users[0]);
      const req = fromIp('10.9.9.9');
      // Sucessos e o 400 de "mesma senha" não contam como falha
      for (let i = 0; i < 12; i++) {
        await expect(
          ctx.service.changePassword(
            me,
            { current_password: PASSWORD, password: PASSWORD },
            req,
          ),
        ).rejects.toThrow(new BadRequestException(NEW_PASSWORD_SAME_MESSAGE));
      }
      for (let i = 0; i < 10; i++) {
        await expect(
          ctx.service.changePassword(
            me,
            { current_password: 'Errada#2026x', password: 'NovaSenha#2026' },
            req,
          ),
        ).rejects.toThrow(
          new BadRequestException(CURRENT_PASSWORD_WRONG_MESSAGE),
        );
      }
      let status = 0;
      try {
        await ctx.service.changePassword(
          me,
          { current_password: PASSWORD, password: 'NovaSenha#2026' },
          req,
        );
      } catch (error) {
        status = (error as HttpException).getStatus();
      }
      expect(status).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(ctx.users[0].token_version).toBe(0);
      expect(ctx.notices.passwordChanged).not.toHaveBeenCalled();
    });
  });

  describe('requestEmailChange', () => {
    it('e-mail livre, em uso ou reservado: mesma resposta e mesma linha pendente; só o e-mail que sai muda', async () => {
      const ctx = await setup([
        makeUser(1),
        makeUser(2, { email: 'em.uso@email.com' }),
        makeUser(3),
      ]);
      // Endereço antigo reservado pela conta 3 ("Não fui eu" no prazo)
      await ctx.tokens.issue({
        userId: 3,
        purpose: REVERT,
        email: 'reservado@email.com',
        previousEmail: 'pessoa3@email.com',
      });
      const me = actorOf(ctx.users[0]);
      const results: Array<Record<string, unknown>> = [];
      for (const email of [
        'livre@email.com',
        'EM.USO@email.com',
        'reservado@email.com',
      ]) {
        const result = await ctx.service.requestEmailChange(me, {
          email,
          current_password: PASSWORD,
        });
        const normalized = email.toLowerCase();
        expect(result.message).toBe(emailChangeRequestedMessage(normalized));
        expect(Object.keys(result.email_change).sort()).toEqual([
          'email',
          'expires_at',
          'requested_at',
        ]);
        const open = ctx.tokenRows.filter(
          (r) => r.user_id === 1 && r.purpose === CHANGE && !r.revoked_at,
        );
        expect(open).toHaveLength(1);
        expect(open[0]).toMatchObject({
          email: normalized,
          previous_email: 'pessoa1@email.com',
        });
        results.push(result);
      }
      expect(ctx.notices.changeConfirm).toHaveBeenCalledTimes(1);
      expect(ctx.notices.changeConfirm).toHaveBeenCalledWith(
        ctx.users[0],
        'livre@email.com',
        expect.any(String),
      );
      expect(ctx.notices.changeInUse).toHaveBeenCalledTimes(1);
      expect(ctx.notices.changeInUse).toHaveBeenCalledWith('em.uso@email.com');
      const audits = ctx.audit.record.mock.calls.map(
        ([entry]: [{ result: string; metadata: Where }]) => [
          entry.result,
          entry.metadata.reason ?? null,
        ],
      );
      expect(audits).toEqual([
        ['SUCCESS', null],
        ['FAILURE', 'email_in_use'],
        ['FAILURE', 'email_reserved'],
      ]);
      // O e-mail da conta não mudou
      expect(ctx.users[0].email).toBe('pessoa1@email.com');
    });

    it('senha atual errada → 400; o mesmo e-mail → 400; ACCOUNT_EMAIL (5 por hora) → 429', async () => {
      const ctx = await setup([makeUser(1)]);
      const me = actorOf(ctx.users[0]);
      await expect(
        ctx.service.requestEmailChange(me, {
          email: 'novo@email.com',
          current_password: 'Errada#2026x',
        }),
      ).rejects.toThrow(CURRENT_PASSWORD_WRONG_MESSAGE);
      await expect(
        ctx.service.requestEmailChange(me, {
          email: ' Pessoa1@Email.com ',
          current_password: PASSWORD,
        }),
      ).rejects.toThrow(new BadRequestException(EMAIL_CHANGE_SAME_MESSAGE));
      for (let i = 0; i < 5; i++) {
        await ctx.service.requestEmailChange(me, {
          email: `novo${i}@email.com`,
          current_password: PASSWORD,
        });
      }
      await expect(
        ctx.service.requestEmailChange(me, {
          email: 'mais-um@email.com',
          current_password: PASSWORD,
        }),
      ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    });
  });

  describe('confirmEmailChange', () => {
    it('aplica a troca: e-mail novo confirmado, sessões encerradas, REVERT do antigo e aviso com o "Não fui eu"', async () => {
      const ctx = await setup([makeUser(1)]);
      const me = actorOf(ctx.users[0]);
      await ctx.service.requestEmailChange(me, {
        email: 'novo@email.com',
        current_password: PASSWORD,
      });
      await ctx.tokens.issue({
        userId: 1,
        purpose: VERIFY,
        email: 'pessoa1@email.com',
      });
      const token = await ctx.linkFor(1, CHANGE);

      await expect(
        ctx.service.inspectEmailChange(token),
      ).resolves.toMatchObject({
        current_email_masked: 'pe***@email.com',
        new_email_masked: 'no***@email.com',
      });
      await expect(ctx.service.confirmEmailChange(token)).resolves.toEqual({
        message: 'E-mail alterado. Entre com o novo e-mail.',
        email: 'novo@email.com',
      });

      const user = ctx.users[0];
      expect(user.email).toBe('novo@email.com');
      expect(user.email_verified_at).toBeInstanceOf(Date);
      expect(user.token_version).toBe(1);
      expect(
        ctx.tokenRows.find((r) => r.purpose === CHANGE)?.used_at,
      ).toBeInstanceOf(Date);
      expect(
        ctx.tokenRows.find((r) => r.purpose === VERIFY)?.revoked_at,
      ).toBeInstanceOf(Date);
      expect(ctx.resetLinks.update).toHaveBeenCalled();
      const revert = ctx.tokenRows.find(
        (r) => r.purpose === REVERT && !r.used_at && !r.revoked_at,
      );
      expect(revert).toMatchObject({
        email: 'pessoa1@email.com',
        previous_email: 'novo@email.com',
      });
      expect(ctx.notices.emailChanged).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1 }),
        expect.objectContaining({
          oldEmail: 'pessoa1@email.com',
          newEmail: 'novo@email.com',
          revertToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown,
        }),
      );
      expect(ctx.audit.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'auth.email_change.confirm',
          metadata: { from: 'pessoa1@email.com', to: 'novo@email.com' },
        }),
      );
      // Uso único (dois confirms: o segundo encontra o link já usado)
      await expect(ctx.service.confirmEmailChange(token)).rejects.toThrow(
        new NotFoundException(EMAIL_CHANGE_LINK_INVALID_MESSAGE),
      );
    });

    it('404 se o e-mail da conta mudou depois do pedido, se a conta foi bloqueada ou se o pedido foi cancelado', async () => {
      const ctx = await setup([makeUser(1), makeUser(2), makeUser(3)]);
      for (const user of ctx.users) {
        await ctx.service.requestEmailChange(actorOf(user), {
          email: `novo${user.id}@email.com`,
          current_password: PASSWORD,
        });
      }
      const [t1, t2, t3] = [
        await ctx.linkFor(1, CHANGE),
        await ctx.linkFor(2, CHANGE),
        await ctx.linkFor(3, CHANGE),
      ];
      ctx.users[0].email = 'outro@email.com';
      ctx.users[1].blocked_at = new Date();
      await ctx.service.cancelEmailChange(actorOf(ctx.users[2]));
      for (const token of [t1, t2, t3]) {
        await expect(
          ctx.service.confirmEmailChange(token),
        ).rejects.toBeInstanceOf(NotFoundException);
      }
      expect(ctx.notices.emailChanged).not.toHaveBeenCalled();
    });

    it('e-mail novo tomado por outra conta (ou reservado) → 409 e nada muda', async () => {
      const ctx = await setup([makeUser(1), makeUser(2)]);
      await ctx.service.requestEmailChange(actorOf(ctx.users[0]), {
        email: 'disputado@email.com',
        current_password: PASSWORD,
      });
      const token = await ctx.linkFor(1, CHANGE);
      ctx.users[1].email = 'disputado@email.com';
      await expect(ctx.service.confirmEmailChange(token)).rejects.toThrow(
        new ConflictException(EMAIL_CHANGE_TAKEN_MESSAGE),
      );
      expect(ctx.users[0].email).toBe('pessoa1@email.com');
      expect(
        ctx.tokenRows.find((r) => r.purpose === CHANGE)?.used_at,
      ).toBeNull();
    });
  });

  describe('revertEmailChange ("Não fui eu")', () => {
    it('vale depois da cadeia A→B→C: devolve A, grava a senha nova, cancela os outros links e não desbloqueia', async () => {
      const ctx = await setup([makeUser(1)]);
      const user = ctx.users[0];
      for (const next of ['b@email.com', 'c@email.com']) {
        await ctx.service.requestEmailChange(actorOf(user), {
          email: next,
          current_password: PASSWORD,
        });
        await ctx.service.confirmEmailChange(await ctx.linkFor(1, CHANGE));
      }
      expect(user.email).toBe('c@email.com');
      const reverts = ctx.tokenRows.filter(
        (r) => r.purpose === REVERT && !r.used_at && !r.revoked_at,
      );
      expect(reverts.map((r) => r.email)).toEqual([
        'pessoa1@email.com',
        'b@email.com',
      ]);
      user.blocked_at = new Date();
      const versionBefore = user.token_version;

      // Código do REVERT do endereço A (o mais antigo)
      const revertA = reverts[0];
      const issued = await ctx.tokens.issue({
        userId: 9,
        purpose: VERIFY,
        email: 'x@x.com',
      });
      revertA.token_hash = issued.record.token_hash;

      await expect(
        ctx.service.inspectRevert(issued.token),
      ).resolves.toMatchObject({
        restored_email_masked: 'pe***@email.com',
        replaced_email_masked: 'c***@email.com',
      });
      await expect(
        ctx.service.revertEmailChange(issued.token, 'Recuperada#2026'),
      ).resolves.toEqual({
        message:
          'Troca de e-mail desfeita. Entre com pe***@email.com e a nova senha.',
        email_masked: 'pe***@email.com',
      });

      expect(user.email).toBe('pessoa1@email.com');
      expect(user.email_verified_at).toBeInstanceOf(Date);
      expect(user.blocked_at).toBeInstanceOf(Date);
      expect(user.token_version).toBe(versionBefore + 1);
      await expect(
        bcrypt.compare('Recuperada#2026', ctx.hashes.get(1)!),
      ).resolves.toBe(true);
      expect(
        ctx.tokenRows.filter(
          (r) => r.user_id === 1 && !r.used_at && !r.revoked_at,
        ),
      ).toEqual([]);
      expect(ctx.notices.changeReverted).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1 }),
        'c@email.com',
        'pessoa1@email.com',
      );
      expect(ctx.audit.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'auth.email_change.revert',
          metadata: { restored: 'pessoa1@email.com', replaced: 'c@email.com' },
        }),
      );
    });

    it('link inválido → 404 (nada muda); 20 falhas do mesmo IP → 429', async () => {
      const ctx = await setup([makeUser(1)]);
      const req = fromIp('10.7.7.7');
      for (let i = 0; i < 20; i++) {
        await expect(
          ctx.service.revertEmailChange('y'.repeat(43), 'Recuperada#2026', req),
        ).rejects.toBeInstanceOf(NotFoundException);
      }
      await expect(
        ctx.service.inspectRevert('y'.repeat(43), req),
      ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    });
  });

  describe('verificação', () => {
    it('reenvio 202 (ACCOUNT_EMAIL), confirmação e "já confirmado" 200', async () => {
      const ctx = await setup([makeUser(1)]);
      const me = actorOf(ctx.users[0]);
      await expect(ctx.service.requestVerification(me)).resolves.toEqual({
        status: HttpStatus.ACCEPTED,
        body: {
          message: 'Enviamos um link de confirmação para pe***@email.com.',
        },
      });
      expect(ctx.notices.verification).toHaveBeenCalledWith(
        ctx.users[0],
        'pessoa1@email.com',
        expect.any(String),
      );
      const token = await ctx.linkFor(1, VERIFY);
      await expect(
        ctx.service.inspectVerification(token),
      ).resolves.toMatchObject({
        email_masked: 'pe***@email.com',
      });
      await expect(ctx.service.confirmVerification(token)).resolves.toEqual({
        message: 'E-mail confirmado.',
        email_masked: 'pe***@email.com',
      });
      expect(ctx.users[0].email_verified_at).toBeInstanceOf(Date);
      await expect(ctx.service.requestVerification(me)).resolves.toEqual({
        status: HttpStatus.OK,
        body: { message: EMAIL_ALREADY_VERIFIED_MESSAGE, email_verified: true },
      });
    });

    it('link enviado antes de uma troca de e-mail → 404 (o endereço não é mais o da conta)', async () => {
      const ctx = await setup([makeUser(1)]);
      await ctx.service.requestVerification(actorOf(ctx.users[0]));
      const token = await ctx.linkFor(1, VERIFY);
      ctx.users[0].email = 'trocado@email.com';
      await expect(ctx.service.confirmVerification(token)).rejects.toThrow(
        new NotFoundException(EMAIL_VERIFICATION_LINK_INVALID_MESSAGE),
      );
      expect(ctx.users[0].email_verified_at).toBeNull();
    });
  });
});
