import {
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import type { Request } from 'express';
import { FindOperator, IsNull, Repository } from 'typeorm';
import { AccountEmailToken } from '../account/entities/account-email-token.entity';
import type { AuditService } from '../audit/audit.service';
import { sha256Hex } from '../common/crypto/secret-box';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import type { MailMessage, MailService } from '../notifications/mail.service';
import { PlatformRole, User, UserRole } from '../users/entities/user.entity';
import type { AuthUser } from './auth-user';
import { PasswordResetToken } from './entities/password-reset-token.entity';
import {
  FORGOT_PASSWORD_RECIPIENT_DAILY_LIMIT,
  PasswordResetService,
  PLATFORM_ACCOUNT_RESET_MESSAGE,
  RESET_LINK_INVALID_MESSAGE,
} from './password-reset.service';

type Where = Record<string, unknown>;

/** where do TypeORM em memória (null/undefined no where é erro, como no banco real). */
function check(value: unknown, condition: unknown): boolean {
  if (condition instanceof FindOperator) {
    const op = condition as FindOperator<unknown>;
    switch (op.type) {
      case 'isNull':
        return value === null || value === undefined;
      case 'not':
        return op.child ? !check(value, op.child) : value !== op.value;
      case 'moreThan':
        return (
          value instanceof Date &&
          value.getTime() > (op.value as Date).getTime()
        );
      default:
        throw new Error(`Operador não suportado no teste: ${op.type}`);
    }
  }
  if (condition === undefined || condition === null) {
    throw new Error('null/undefined no where (o TypeORM real recusaria)');
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
    token_version: 0,
    password_hash: 'hash-antigo',
    ...extra,
  });
}

const fromIp = (ip: string) =>
  ({ ip, headers: { 'user-agent': 'jest' } }) as unknown as Request;

const superAdmin: AuthUser = {
  id: 90,
  email: 'ops@comestra.com.br',
  name: 'Ops',
  role: UserRole.CLIENT,
  storeId: null,
  platformRole: PlatformRole.SUPER_ADMIN,
  supportSession: null,
};

interface FakeQueryBuilder {
  where: jest.Mock;
  orderBy: jest.Mock;
  getMany: jest.Mock;
}

function setup(users: User[]) {
  const tokenRows: PasswordResetToken[] = [];
  const usersRepo = {
    findOne: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(
        users.find((user) => !user.deleted_at && matches(user, where)) ?? null,
      ),
    ),
    update: jest.fn((where: Where, partial: Where) => {
      const hit = users.filter((user) => matches(user, where));
      for (const user of hit) {
        for (const [key, value] of Object.entries(partial)) {
          if (typeof value === 'function') {
            if (key === 'token_version') user.token_version += 1;
            // COALESCE("email_verified_at", now()): mantém a primeira confirmação
            if (key === 'email_verified_at') {
              user.email_verified_at ??= new Date();
            }
          } else {
            (user as unknown as Where)[key] = value;
          }
        }
      }
      return Promise.resolve({ affected: hit.length });
    }),
    createQueryBuilder: jest.fn((): FakeQueryBuilder => {
      const params: Where = {};
      const qb: FakeQueryBuilder = {
        where: jest.fn((_sql: string, values: Where) => {
          Object.assign(params, values);
          return qb;
        }),
        orderBy: jest.fn(() => qb),
        getMany: jest.fn(() =>
          Promise.resolve(
            users.filter(
              (user) =>
                !user.deleted_at && user.email.toLowerCase() === params.email,
            ),
          ),
        ),
      };
      return qb;
    }),
  };
  const tokensBase = {
    findOne: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(tokenRows.find((row) => matches(row, where)) ?? null),
    ),
    update: jest.fn((where: Where, partial: Where) => {
      const hit = tokenRows.filter((row) => matches(row, where));
      hit.forEach((row) => Object.assign(row, partial));
      return Promise.resolve({ affected: hit.length });
    }),
    create: jest.fn((data: Partial<PasswordResetToken>) =>
      Object.assign(new PasswordResetToken(), data),
    ),
    save: jest.fn((row: PasswordResetToken) => {
      Object.assign(row, { id: tokenRows.length + 1, created_at: new Date() });
      tokenRows.push(row);
      return Promise.resolve(row);
    }),
    count: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(tokenRows.filter((row) => matches(row, where)).length),
    ),
  };
  // Pedidos de troca de e-mail (account_email_tokens): só o cancelamento é usado aqui
  const emailTokens = {
    update: jest.fn().mockResolvedValue({ affected: 0 }),
  };
  // A transação usa os mesmos repositórios falsos
  const tokensRepo = Object.assign(tokensBase, {
    manager: {
      transaction: jest.fn(
        (
          work: (manager: {
            getRepository: (e: unknown) => unknown;
          }) => unknown,
        ) =>
          work({
            getRepository: (entity: unknown) =>
              entity === PasswordResetToken
                ? tokensBase
                : entity === AccountEmailToken
                  ? emailTokens
                  : usersRepo,
          }),
      ),
    },
  });
  const mail = {
    send: jest.fn().mockResolvedValue({ delivered: false, driver: 'log' }),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const rateLimit = new RateLimitService();
  const service = new PasswordResetService(
    tokensRepo as unknown as Repository<PasswordResetToken>,
    usersRepo as unknown as Repository<User>,
    mail as unknown as MailService,
    audit as unknown as AuditService,
    rateLimit,
  );
  return {
    service,
    tokenRows,
    tokensRepo,
    usersRepo,
    mail,
    audit,
    rateLimit,
    emailTokens,
  };
}

/** Token do link que foi "enviado" por e-mail. */
function mailedToken(mail: { send: jest.Mock }, call = 0): string {
  const [message] = mail.send.mock.calls[call] as [MailMessage];
  const token = /redefinir-senha\/([A-Za-z0-9_-]+)/.exec(message.text)?.[1];
  if (!token) throw new Error('link não encontrado no e-mail');
  return token;
}

describe('PasswordResetService', () => {
  const originalEnv = { ...process.env };

  beforeAll(() => {
    // Avisos esperados do limite de tentativas
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.RATE_LIMIT_ENABLED = 'true';
    process.env.APP_WEB_URL = 'https://app.comestra.com.br/';
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('RATE_LIMIT_') && key !== 'RATE_LIMIT_ENABLED') {
        delete process.env[key];
      }
    }
  });

  afterAll(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  describe('esqueci a senha', () => {
    it('envia o link (APP_WEB_URL/redefinir-senha/<token>), guarda só o hash e vale 60 minutos', async () => {
      const { service, tokenRows, mail, audit } = setup([makeUser(1)]);
      const before = Date.now();

      await expect(service.sendResetLink('pessoa1@email.com')).resolves.toBe(
        true,
      );

      const token = mailedToken(mail);
      const [message] = mail.send.mock.calls[0] as [MailMessage];
      expect(message.to).toBe('pessoa1@email.com');
      expect(message.text).toContain(
        `https://app.comestra.com.br/redefinir-senha/${token}`,
      );

      expect(tokenRows).toHaveLength(1);
      const [row] = tokenRows;
      expect(row.token_hash).toBe(sha256Hex(token));
      expect(JSON.stringify(row)).not.toContain(token);
      expect(row.used_at).toBeNull();
      expect(row.created_by_user_id).toBeNull();
      const ttl = row.expires_at.getTime() - before;
      expect(ttl).toBeGreaterThan(59 * 60_000);
      expect(ttl).toBeLessThanOrEqual(60 * 60_000 + 1_000);

      expect(JSON.stringify(audit.record.mock.calls)).not.toContain(token);
    });

    it('um link novo invalida os anteriores da conta', async () => {
      const { service, tokenRows, mail } = setup([makeUser(1)]);
      await service.sendResetLink('pessoa1@email.com');
      await service.sendResetLink('pessoa1@email.com');

      expect(tokenRows).toHaveLength(2);
      expect(tokenRows[0].expires_at.getTime()).toBeLessThanOrEqual(Date.now());
      await expect(
        service.inspect(mailedToken(mail, 0)),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.inspect(mailedToken(mail, 1)),
      ).resolves.toHaveProperty('email_masked');
    });

    it('conta inexistente, excluída ou bloqueada: nada é enviado (e quem pediu não sabe)', async () => {
      const { service, tokenRows, mail, audit } = setup([
        makeUser(1, { deleted_at: new Date() }),
        makeUser(2, { blocked_at: new Date() }),
      ]);
      for (const email of [
        'ninguem@email.com',
        'pessoa1@email.com',
        'pessoa2@email.com',
      ]) {
        await expect(service.sendResetLink(email)).resolves.toBe(false);
      }
      expect(tokenRows).toHaveLength(0);
      expect(mail.send).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.password_reset.request',
          result: 'DENIED',
          metadata: { reason: 'blocked' },
        }),
      );
    });

    it('limites silenciosos por destinatário: 3 links em 24 h (no banco) e 5 pedidos em 15 min (antes da consulta)', async () => {
      const { service, mail, usersRepo, audit } = setup([makeUser(1)]);
      for (let i = 0; i < FORGOT_PASSWORD_RECIPIENT_DAILY_LIMIT; i++) {
        await expect(service.sendResetLink('pessoa1@email.com')).resolves.toBe(
          true,
        );
      }
      // A conta já recebeu 3 links nas últimas 24 h: nada é enviado (de qualquer IP), com auditoria
      for (let i = 0; i < 2; i++) {
        await expect(service.sendResetLink('pessoa1@email.com')).resolves.toBe(
          false,
        );
      }
      expect(mail.send).toHaveBeenCalledTimes(3);
      expect(audit.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'auth.password_reset.request',
          targetId: 1,
          result: 'DENIED',
          metadata: {
            reason: 'recipient_limit',
            limit: FORGOT_PASSWORD_RECIPIENT_DAILY_LIMIT,
          },
        }),
      );
      // 6º pedido em 15 min: o limite curto por e-mail recusa antes de consultar o banco
      usersRepo.createQueryBuilder.mockClear();
      await expect(service.sendResetLink('pessoa1@email.com')).resolves.toBe(
        false,
      );
      expect(usersRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('o limite por destinatário conta só os links pedidos por e-mail nas últimas 24 h', async () => {
      const { service, mail, tokenRows } = setup([makeUser(1)]);
      for (let i = 0; i < 3; i++) {
        await service.sendResetLink('pessoa1@email.com');
      }
      // Dois foram pedidos há mais de 24 h; o link gerado pelo superpainel não conta
      tokenRows[0].created_at = new Date(Date.now() - 25 * 60 * 60_000);
      tokenRows[1].created_at = new Date(Date.now() - 25 * 60 * 60_000);
      await service.createLinkForUser(1, superAdmin);
      await expect(service.sendResetLink('pessoa1@email.com')).resolves.toBe(
        true,
      );
      expect(mail.send).toHaveBeenCalledTimes(4);
    });

    it('requestReset: limite por IP (429) e o envio segue em segundo plano', () => {
      const { service } = setup([makeUser(1)]);
      const send = jest.spyOn(service, 'sendResetLink').mockResolvedValue(true);
      const req = fromIp('10.1.1.1');

      for (let i = 0; i < 5; i++) {
        expect(
          service.requestReset(' Pessoa1@Email.com ', req),
        ).toBeUndefined();
      }
      expect(send).toHaveBeenCalledWith('pessoa1@email.com', req);

      let status = 0;
      try {
        service.requestReset('pessoa1@email.com', req);
      } catch (error) {
        status = (error as HttpException).getStatus();
      }
      expect(status).toBe(429);
      expect(send).toHaveBeenCalledTimes(5);
    });
  });

  describe('conferir e usar o link', () => {
    it('GET: { email_masked, expires_at }; formato inválido nem consulta o banco', async () => {
      const { service, mail, tokensRepo } = setup([makeUser(1)]);
      await service.sendResetLink('pessoa1@email.com');

      const preview = await service.inspect(mailedToken(mail));
      expect(preview.email_masked).toBe('pe***@email.com');
      expect(preview.expires_at).toBeInstanceOf(Date);

      tokensRepo.findOne.mockClear();
      await expect(service.inspect('curto')).rejects.toThrow(
        new NotFoundException(RESET_LINK_INVALID_MESSAGE),
      );
      expect(tokensRepo.findOne).not.toHaveBeenCalled();
    });

    it('POST: grava a senha nova, encerra as sessões e o link vira uso único', async () => {
      const user = makeUser(1, { token_version: 4, store_id: null });
      const { service, mail, tokenRows, audit, emailTokens } = setup([user]);
      await service.sendResetLink('pessoa1@email.com');
      const token = mailedToken(mail);

      await service.reset(token, 'NovaSenha#2026', fromIp('10.2.2.2'));

      expect(user.token_version).toBe(5);
      await expect(
        bcrypt.compare('NovaSenha#2026', user.password_hash),
      ).resolves.toBe(true);
      expect(tokenRows[0].used_at).toBeInstanceOf(Date);
      // O link veio pela caixa da conta: o e-mail fica confirmado
      expect(user.email_verified_at).toBeInstanceOf(Date);
      // E o pedido de troca de e-mail em aberto é cancelado
      const [revokeWhere, revokeSet] = emailTokens.update.mock.calls[0] as [
        Where,
        Where,
      ];
      expect(revokeWhere).toMatchObject({ user_id: 1 });
      expect(String((revokeWhere.purpose as FindOperator<unknown>).value)).toBe(
        'CHANGE',
      );
      expect(revokeSet.revoked_at).toBeInstanceOf(Date);
      expect(audit.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'auth.password_reset.complete',
          targetId: 1,
          metadata: { via: 'email', email_verified: true },
        }),
      );
      const audited = JSON.stringify(audit.record.mock.calls);
      expect(audited).not.toContain('NovaSenha#2026');
      expect(audited).not.toContain(token);

      // Segundo uso do mesmo link → 404
      await expect(
        service.reset(token, 'OutraSenha#2026', fromIp('10.2.2.2')),
      ).rejects.toThrow(new NotFoundException(RESET_LINK_INVALID_MESSAGE));
      expect(user.token_version).toBe(5);
    });

    it('link gerado pelo superpainel (pode ter sido repassado) não confirma o e-mail', async () => {
      const user = makeUser(1);
      const { service, audit } = setup([user]);
      const link = await service.createLinkForUser(1, superAdmin);
      const token = String(link.url).split('/').pop() as string;

      await service.reset(token, 'NovaSenha#2026');

      expect(user.email_verified_at ?? null).toBeNull();
      expect(audit.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'auth.password_reset.complete',
          metadata: { via: 'platform_link', email_verified: false },
        }),
      );
    });

    it('link vencido → 404 e a senha não muda', async () => {
      const user = makeUser(1);
      const { service, mail, tokenRows } = setup([user]);
      await service.sendResetLink('pessoa1@email.com');
      tokenRows[0].expires_at = new Date(Date.now() - 1_000);

      await expect(
        service.reset(mailedToken(mail), 'NovaSenha#2026'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(user.password_hash).toBe('hash-antigo');
    });

    it('20 links inválidos do mesmo IP → 429 (até para um link válido)', async () => {
      const { service, mail } = setup([makeUser(1)]);
      await service.sendResetLink('pessoa1@email.com');
      const req = fromIp('10.3.3.3');
      const garbage = 'x'.repeat(43);

      for (let i = 0; i < 20; i++) {
        await expect(service.inspect(garbage, req)).rejects.toBeInstanceOf(
          NotFoundException,
        );
      }
      const limited = await service
        .reset(mailedToken(mail), 'NovaSenha#2026', req)
        .catch((error: unknown) => error);
      expect((limited as HttpException).getStatus()).toBe(429);
    });
  });

  describe('superpainel: link gerado pelo operador', () => {
    it('sem SMTP (driver de log): superadmin recebe { url, expires_at, delivered: false }, com o operador registrado', async () => {
      const { service, tokenRows, mail, audit } = setup([
        makeUser(1, { role: UserRole.KITCHEN, store_id: 3 }),
      ]);

      const link = await service.createLinkForUser(1, superAdmin);
      expect(link.delivered).toBe(false);
      const token = /redefinir-senha\/([A-Za-z0-9_-]+)$/.exec(
        link.url ?? '',
      )?.[1];
      expect(link.url).toBe(
        `https://app.comestra.com.br/redefinir-senha/${token}`,
      );
      expect(tokenRows[0]).toMatchObject({
        user_id: 1,
        created_by_user_id: 90,
        token_hash: sha256Hex(token ?? ''),
      });
      expect(mail.send).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'user.password_reset_link',
          storeId: 3,
          targetId: 1,
        }),
      );
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain(
        token ?? '???',
      );
    });

    it('com SMTP: o link vai para o e-mail do titular e NÃO aparece para o operador', async () => {
      const { service, tokenRows, mail, audit } = setup([
        makeUser(1, { role: UserRole.ADMIN, store_id: 3 }),
      ]);
      Object.assign(mail, { configured: true });
      mail.send.mockResolvedValueOnce({ delivered: true, driver: 'smtp' });

      const link = await service.createLinkForUser(1, superAdmin);
      expect(link).toEqual({
        url: null,
        delivered: true,
        email_masked: 'pe***@email.com',
        expires_at: tokenRows[0].expires_at,
      });
      expect(mail.send).toHaveBeenCalledTimes(1);
      const [message] = mail.send.mock.calls[0] as [MailMessage];
      expect(message.to).toBe('pessoa1@email.com');
      const token = mailedToken(mail);
      expect(tokenRows[0].token_hash).toBe(sha256Hex(token));
      // O link do e-mail funciona; o operador não o recebeu em lugar nenhum
      await expect(service.inspect(token)).resolves.toHaveProperty(
        'email_masked',
      );
      expect(JSON.stringify(link)).not.toContain(token);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'user.password_reset_link',
          metadata: expect.objectContaining({ delivered: true }) as unknown,
        }),
      );
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain(token);
    });

    it('com SMTP e falha no envio: o link é anulado e o operador recebe 503 (sem a URL)', async () => {
      const { service, tokenRows, mail, audit } = setup([makeUser(1)]);
      Object.assign(mail, { configured: true });
      mail.send.mockResolvedValueOnce({
        delivered: false,
        driver: 'smtp',
        error: 'connection refused',
      });

      const failed = await service
        .createLinkForUser(1, superAdmin)
        .catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(ServiceUnavailableException);
      expect(
        JSON.stringify((failed as HttpException).getResponse()),
      ).not.toMatch(/redefinir-senha/);
      const token = mailedToken(mail);
      await expect(service.inspect(token)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(tokenRows[0].expires_at.getTime()).toBeLessThanOrEqual(Date.now());
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'user.password_reset_link',
          result: 'FAILURE',
        }),
      );
    });

    it('contas da plataforma (superadmin) não recebem link pelo superpainel → 403, nada é gerado', async () => {
      const { service, tokenRows, mail } = setup([
        makeUser(1),
        makeUser(91, { platform_role: PlatformRole.SUPER_ADMIN }),
      ]);
      const refused = await service
        .createLinkForUser(91, superAdmin)
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(ForbiddenException);
      expect((refused as HttpException).message).toBe(
        PLATFORM_ACCOUNT_RESET_MESSAGE,
      );
      expect(tokenRows).toHaveLength(0);
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('quem não é superadmin (ou está numa sessão de suporte) → 403; conta inexistente → 404', async () => {
      const { service } = setup([makeUser(1)]);
      await expect(
        service.createLinkForUser(1, { ...superAdmin, platformRole: null }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.createLinkForUser(1, {
          ...superAdmin,
          supportSession: { id: 1, storeId: 3, expiresAt: new Date() },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.createLinkForUser(404, superAdmin),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('a invalidação dos anteriores usa o critério da conta (pendentes e no prazo)', async () => {
      const { service, tokensRepo } = setup([makeUser(1)]);
      await service.createLinkForUser(1, superAdmin);
      const [criteria] = tokensRepo.update.mock.calls[0];
      expect(criteria).toMatchObject({ user_id: 1, used_at: IsNull() });
      expect(criteria.expires_at).toBeInstanceOf(FindOperator);
    });
  });
});
