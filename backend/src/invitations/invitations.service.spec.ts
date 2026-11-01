import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { FindOperator, Repository } from 'typeorm';
import type { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth-user';
import { SessionTokenService } from '../auth/session-token.service';
import type { PlanLimitsService } from '../billing/plan-limits.service';
import { sha256Hex } from '../common/crypto/secret-box';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import type { MailMessage, MailService } from '../notifications/mail.service';
import { Store, StoreAccountStatus } from '../store/entities/store.entity';
import { PlatformRole, User, UserRole } from '../users/entities/user.entity';
import type { UsersService } from '../users/users.service';
import { Invitation } from './entities/invitation.entity';
import {
  ACCOUNT_EXISTS_MESSAGE,
  INVITATION_INVALID_MESSAGE,
  INVITATION_MAIL_SKIPPED_MESSAGE,
  INVITATION_NOT_SENT_MESSAGE,
  INVITATION_NOT_FOUND_MESSAGE,
  INVITATION_RECIPIENT_DAILY_LIMIT,
  INVITATION_RECIPIENT_LIMIT_MESSAGE,
  INVITATION_RECIPIENT_MAIL_DAILY_LIMIT,
  INVITATION_STORE_DAILY_LIMIT,
  INVITATION_STORE_LIMIT_MESSAGE,
  InvitationsService,
  invitationSentNotice,
  OWNER_INVITATION_PROTECTED_MESSAGE,
} from './invitations.service';

const SECRET = 'segredo-de-teste';
const STORE_A = 1;
const STORE_B = 2;
const DAY = 24 * 60 * 60_000;

type Where = Record<string, unknown>;

/** where do TypeORM em memória (null/undefined no where é erro, como no banco real). */
function check(value: unknown, condition: unknown): boolean {
  if (condition instanceof FindOperator) {
    const op = condition as FindOperator<unknown>;
    const time = (v: unknown) => new Date(v as Date).getTime();
    switch (op.type) {
      case 'isNull':
        return value === null || value === undefined;
      case 'not':
        return op.child ? !check(value, op.child) : value !== op.value;
      case 'moreThan':
        return value instanceof Date && time(value) > time(op.value);
      case 'lessThanOrEqual':
        return value instanceof Date && time(value) <= time(op.value);
      case 'in':
        return (op.value as unknown[]).includes(value);
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

const adminA: AuthUser = {
  id: 10,
  email: 'admin-a@email.com',
  name: 'Admin A',
  role: UserRole.ADMIN,
  storeId: STORE_A,
  platformRole: null,
  supportSession: null,
};
const superAdmin: AuthUser = {
  id: 90,
  email: 'ops@comestra.com.br',
  name: 'Ops',
  role: UserRole.CLIENT,
  storeId: null,
  platformRole: PlatformRole.SUPER_ADMIN,
  supportSession: null,
};

function setup() {
  const rows: Invitation[] = [];
  const storeRows: Store[] = [
    Object.assign(new Store(), {
      id: STORE_A,
      slug: 'loja-a',
      name: 'Loja A',
      logo: 'a.webp',
      primary_color: '#000000',
      account_status: StoreAccountStatus.ACTIVE,
      owner_user_id: null,
    }),
    Object.assign(new Store(), {
      id: STORE_B,
      slug: 'loja-b',
      name: 'Loja B',
      logo: null,
      primary_color: null,
      account_status: StoreAccountStatus.ACTIVE,
      owner_user_id: null,
    }),
  ];

  const storesRepo = {
    findOne: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(storeRows.find((store) => matches(store, where)) ?? null),
    ),
    update: jest.fn((where: Where, partial: Where) => {
      const hit = storeRows.filter((store) => matches(store, where));
      hit.forEach((store) => Object.assign(store, partial));
      return Promise.resolve({ affected: hit.length });
    }),
  };
  // Contas de quem convida (o aceite confere se quem convidou ainda pode convidar)
  const accounts: User[] = [
    Object.assign(new User(), {
      id: adminA.id,
      role: UserRole.ADMIN,
      store_id: STORE_A,
      platform_role: null,
      deleted_at: null,
      blocked_at: null,
    }),
    Object.assign(new User(), {
      id: superAdmin.id,
      role: UserRole.CLIENT,
      store_id: null,
      platform_role: PlatformRole.SUPER_ADMIN,
      deleted_at: null,
      blocked_at: null,
    }),
  ];
  const usersTxRepo = {
    marker: 'repositório da transação',
    findOne: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(accounts.find((row) => matches(row, where)) ?? null),
    ),
    find: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(accounts.filter((row) => matches(row, where))),
    ),
  };

  const invitationsBase = {
    findOne: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(rows.find((row) => matches(row, where)) ?? null),
    ),
    find: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(rows.filter((row) => matches(row, where))),
    ),
    count: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(rows.filter((row) => matches(row, where)).length),
    ),
    findAndCount: jest.fn(
      ({ where, skip, take }: { where: Where; skip: number; take: number }) => {
        const hit = rows
          .filter((row) => matches(row, where))
          .sort((a, b) => b.id - a.id);
        return Promise.resolve([hit.slice(skip, skip + take), hit.length]);
      },
    ),
    update: jest.fn((where: Where, partial: Where) => {
      const hit = rows.filter((row) => matches(row, where));
      hit.forEach((row) => Object.assign(row, partial));
      return Promise.resolve({ affected: hit.length });
    }),
    create: jest.fn((data: Partial<Invitation>) =>
      Object.assign(new Invitation(), data),
    ),
    save: jest.fn((row: Invitation) => {
      Object.assign(row, { id: rows.length + 1, created_at: new Date() });
      rows.push(row);
      return Promise.resolve(row);
    }),
  };
  // A transação usa os mesmos repositórios falsos
  const invitationsRepo = Object.assign(invitationsBase, {
    manager: {
      getRepository: (entity: unknown) =>
        entity === User ? usersTxRepo : undefined,
      transaction: jest.fn(
        (
          work: (manager: {
            getRepository: (e: unknown) => unknown;
          }) => unknown,
        ) =>
          work({
            getRepository: (entity: unknown) =>
              entity === Invitation
                ? invitationsBase
                : entity === Store
                  ? storesRepo
                  : usersTxRepo,
          }),
      ),
    },
  });

  let nextUserId = 500;
  const users = {
    emailInUse: jest.fn().mockResolvedValue(false),
    insertUser: jest.fn(
      (
        _repo: unknown,
        account: { name: string; email: string },
        membership: { role: UserRole; storeId: number },
      ) =>
        Promise.resolve(
          Object.assign(new User(), {
            id: nextUserId++,
            name: account.name,
            email: account.email,
            phone: null,
            avatar: null,
            role: membership.role,
            store_id: membership.storeId,
            platform_role: null,
            token_version: 0,
            created_at: new Date(),
            updated_at: new Date(),
          }),
        ),
    ),
  };
  const planLimits = {
    assertWithinLimit: jest.fn().mockResolvedValue(undefined),
    lockAndAssert: jest.fn().mockResolvedValue(undefined),
  };
  const mail = {
    send: jest.fn().mockResolvedValue({ delivered: false, driver: 'log' }),
    configured: false,
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const jwt = new JwtService({ secret: SECRET });

  const service = new InvitationsService(
    invitationsRepo as unknown as Repository<Invitation>,
    storesRepo as unknown as Repository<Store>,
    users as unknown as UsersService,
    planLimits as unknown as PlanLimitsService,
    new SessionTokenService(jwt),
    mail as unknown as MailService,
    audit as unknown as AuditService,
    new RateLimitService(),
  );
  return {
    service,
    rows,
    accounts,
    storeRows,
    invitationsRepo,
    storesRepo,
    usersTxRepo,
    users,
    planLimits,
    mail,
    audit,
    jwt,
  };
}

const tokenOf = (url: string | null) => {
  if (!url) throw new Error('convite sem link');
  const token = /\/convite\/([A-Za-z0-9_-]+)$/.exec(url)?.[1];
  if (!token) throw new Error(`link inesperado: ${url}`);
  return token;
};

const account = { name: 'Nova Pessoa', password: 'SenhaForte@123' };

describe('InvitationsService', () => {
  const originalEnv = { ...process.env };

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.RATE_LIMIT_ENABLED = 'true';
    process.env.APP_WEB_URL = 'https://app.comestra.com.br';
    delete process.env.RATE_LIMIT_TOKEN_REDEEM;
  });

  afterAll(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  describe('create', () => {
    it('guarda só o hash, vale 7 dias, envia o link e devolve { invitation, url } (sem o hash)', async () => {
      const { service, rows, mail, audit } = setup();
      const before = Date.now();

      const created = await service.create({
        storeId: STORE_A,
        email: ' Pessoa@Email.com ',
        role: UserRole.KITCHEN,
        invitedBy: adminA,
      });

      const token = tokenOf(created.url);
      expect(created.url).toBe(`https://app.comestra.com.br/convite/${token}`);
      expect(rows[0]).toMatchObject({
        store_id: STORE_A,
        email: 'pessoa@email.com',
        role: UserRole.KITCHEN,
        make_owner: false,
        token_hash: sha256Hex(token),
        invited_by_user_id: adminA.id,
      });
      const ttl = rows[0].expires_at.getTime() - before;
      expect(ttl).toBeGreaterThan(7 * DAY - 5_000);
      expect(ttl).toBeLessThanOrEqual(7 * DAY + 1_000);

      expect(created.invitation).toMatchObject({
        id: 1,
        status: 'PENDING',
        email: 'pessoa@email.com',
      });
      expect(created.invitation).not.toHaveProperty('token_hash');

      const [message] = mail.send.mock.calls[0] as [MailMessage];
      expect(message.to).toBe('pessoa@email.com');
      expect(message.text).toContain(created.url);
      expect(message.subject).toContain('Loja A');
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain(token);
    });

    it('e-mail que já tem conta → 409, nada é criado e a tentativa fica na auditoria', async () => {
      const { service, users, rows, mail, audit } = setup();
      users.emailInUse.mockResolvedValueOnce(true);
      await expect(
        service.create({
          storeId: STORE_A,
          email: 'existe@email.com',
          role: UserRole.EMPLOYEE,
          invitedBy: adminA,
        }),
      ).rejects.toThrow(new ConflictException(ACCOUNT_EXISTS_MESSAGE));
      expect(rows).toHaveLength(0);
      expect(mail.send).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: adminA,
          storeId: STORE_A,
          action: 'invitation.create',
          result: 'FAILURE',
          metadata: expect.objectContaining({
            email: 'existe@email.com',
            reason: 'email_in_use',
          }) as unknown,
        }),
      );
    });

    it('convite pendente igual (mesma loja e e-mail) é revogado; o de outra loja não', async () => {
      const { service, rows } = setup();
      const input = {
        email: 'pessoa@email.com',
        role: UserRole.EMPLOYEE,
        invitedBy: adminA,
      };
      await service.create({ ...input, storeId: STORE_B });
      await service.create({ ...input, storeId: STORE_A });
      await service.create({ ...input, storeId: STORE_A });

      expect(rows.map((row) => [row.store_id, !!row.revoked_at])).toEqual([
        [STORE_B, false],
        [STORE_A, true],
        [STORE_A, false],
      ]);
    });

    it('reenvio substitui o convite pendente e a revogação do anterior entra na auditoria (superseded)', async () => {
      const { service, rows, audit } = setup();
      const input = {
        storeId: STORE_A,
        email: 'pessoa@email.com',
        role: UserRole.EMPLOYEE,
        invitedBy: adminA,
      };
      const first = await service.create(input);
      const second = await service.create({ ...input, role: UserRole.KITCHEN });

      expect(rows[0].revoked_at).toBeInstanceOf(Date);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: adminA,
          storeId: STORE_A,
          action: 'invitation.revoke',
          targetId: first.invitation.id,
          metadata: expect.objectContaining({
            reason: 'superseded',
            replaced_by: second.invitation.id,
            make_owner: false,
          }) as unknown,
        }),
      );
    });

    it('limite diário por destinatário é por LOJA: outra loja não fica bloqueada pelos convites de uma loja hostil', async () => {
      const { service, rows, mail } = setup();
      const email = 'alvo@empresa.com';
      for (let i = 0; i < INVITATION_RECIPIENT_DAILY_LIMIT; i++) {
        await service.create({
          storeId: STORE_B,
          email,
          role: UserRole.KITCHEN,
          invitedBy: adminA,
        });
      }
      // A loja que esgotou o próprio limite para o e-mail → 429
      await expect(
        service.create({
          storeId: STORE_B,
          email,
          role: UserRole.KITCHEN,
          invitedBy: adminA,
        }),
      ).rejects.toMatchObject({ status: 429 });

      // O empregador de verdade (outra loja) convida normalmente, com e-mail
      mail.send.mockClear();
      const created = await service.create({
        storeId: STORE_A,
        email,
        role: UserRole.ADMIN,
        invitedBy: adminA,
      });
      expect(created).toMatchObject({ invitation: { status: 'PENDING' } });
      expect(created.url).toEqual(expect.stringContaining('/convite/'));
      expect(created.message).toBeUndefined();
      expect(mail.send).toHaveBeenCalledTimes(1);
      expect(rows).toHaveLength(INVITATION_RECIPIENT_DAILY_LIMIT + 1);
    });

    it('teto de e-mails por destinatário somando as lojas: o convite é criado SEM e-mail e o link volta para a loja repassar', async () => {
      const { service, rows, mail, audit } = setup();
      const email = 'alvo@empresa.com';
      // Convites de várias outras lojas nas últimas 24 h
      for (let i = 0; i < INVITATION_RECIPIENT_MAIL_DAILY_LIMIT; i++) {
        rows.push(
          Object.assign(new Invitation(), {
            id: rows.length + 1,
            store_id: 100 + i,
            email,
            role: UserRole.KITCHEN,
            make_owner: false,
            expires_at: new Date(Date.now() + DAY),
            accepted_at: null,
            revoked_at: null,
            invited_by_user_id: 500 + i,
            created_at: new Date(),
          }),
        );
      }
      mail.send.mockClear();
      const created = await service.create({
        storeId: STORE_A,
        email,
        role: UserRole.KITCHEN,
        invitedBy: adminA,
      });
      expect(created).toMatchObject({
        invitation: { status: 'PENDING' },
        delivered: false,
        message: INVITATION_MAIL_SKIPPED_MESSAGE,
      });
      expect(created.url).toEqual(expect.stringContaining('/convite/'));
      expect(mail.send).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'invitation.create',
          metadata: expect.objectContaining({
            email,
            mail_skipped: 'recipient_mail_limit',
          }) as unknown,
        }),
      );

      // O superpainel não entra no teto: o e-mail vai
      await service.create({
        storeId: STORE_B,
        email,
        role: UserRole.KITCHEN,
        invitedBy: superAdmin,
      });
      expect(mail.send).toHaveBeenCalledTimes(1);
    });

    it('limite diário por destinatário na mesma loja: o próximo convite → 429, sem e-mail; o superpainel não entra no limite', async () => {
      const { service, rows, mail, audit } = setup();
      const email = 'alvo@empresa.com';
      for (let i = 0; i < INVITATION_RECIPIENT_DAILY_LIMIT; i++) {
        await service.create({
          storeId: STORE_A,
          email,
          role: UserRole.KITCHEN,
          invitedBy: adminA,
        });
      }
      const sent = mail.send.mock.calls.length;
      await expect(
        service.create({
          storeId: STORE_A,
          email: ' Alvo@Empresa.com ',
          role: UserRole.KITCHEN,
          invitedBy: adminA,
        }),
      ).rejects.toMatchObject({
        status: 429,
        response: expect.objectContaining({
          statusCode: 429,
          message: INVITATION_RECIPIENT_LIMIT_MESSAGE,
        }) as unknown,
      });
      expect(mail.send.mock.calls.length).toBe(sent);
      expect(rows).toHaveLength(INVITATION_RECIPIENT_DAILY_LIMIT);
      expect(audit.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'invitation.create',
          result: 'FAILURE',
          metadata: expect.objectContaining({
            email,
            reason: 'recipient_daily_limit',
          }) as unknown,
        }),
      );

      // Convites com mais de 24 h não contam; o superpainel não é limitado
      await expect(
        service.create({
          storeId: STORE_A,
          email,
          role: UserRole.KITCHEN,
          invitedBy: superAdmin,
        }),
      ).resolves.toMatchObject({ invitation: { status: 'PENDING' } });
      rows.forEach((row) => {
        row.created_at = new Date(Date.now() - DAY - 1_000);
      });
      await expect(
        service.create({
          storeId: STORE_A,
          email,
          role: UserRole.KITCHEN,
          invitedBy: adminA,
        }),
      ).resolves.toMatchObject({ invitation: { status: 'PENDING' } });
    });

    it('limite diário por loja → 429 com a mensagem da loja', async () => {
      const { service, rows } = setup();
      for (let i = 0; i < INVITATION_STORE_DAILY_LIMIT; i++) {
        rows.push(
          Object.assign(new Invitation(), {
            id: rows.length + 1,
            store_id: STORE_A,
            email: `p${i}@email.com`,
            role: UserRole.KITCHEN,
            make_owner: false,
            expires_at: new Date(Date.now() + DAY),
            accepted_at: null,
            revoked_at: new Date(),
            invited_by_user_id: adminA.id,
            created_at: new Date(),
          }),
        );
      }
      await expect(
        service.create({
          storeId: STORE_A,
          email: 'novo@email.com',
          role: UserRole.KITCHEN,
          invitedBy: adminA,
        }),
      ).rejects.toMatchObject({
        status: 429,
        response: expect.objectContaining({
          message: INVITATION_STORE_LIMIT_MESSAGE,
        }) as unknown,
      });
      // Outra loja não é afetada
      await expect(
        service.create({
          storeId: STORE_B,
          email: 'novo@email.com',
          role: UserRole.KITCHEN,
          invitedBy: adminA,
        }),
      ).resolves.toBeDefined();
    });

    it('troca do responsável (make_owner) pendente: a loja não a substitui (409) e nada é revogado; o superpainel substitui', async () => {
      const { service, rows, mail } = setup();
      const owner = await service.create({
        storeId: STORE_A,
        email: 'novo.dono@x.com',
        role: UserRole.ADMIN,
        makeOwner: true,
        invitedBy: superAdmin,
      });
      const sent = mail.send.mock.calls.length;
      await expect(
        service.create({
          storeId: STORE_A,
          email: 'novo.dono@x.com',
          role: UserRole.KITCHEN,
          invitedBy: adminA,
        }),
      ).rejects.toThrow(
        new ConflictException(OWNER_INVITATION_PROTECTED_MESSAGE),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].revoked_at).toBeNull();
      expect(mail.send.mock.calls.length).toBe(sent);

      // Vencido, ele deixa de proteger (a loja pode convidar o e-mail de novo)
      rows[0].expires_at = new Date(Date.now() - 1_000);
      await expect(
        service.create({
          storeId: STORE_A,
          email: 'novo.dono@x.com',
          role: UserRole.KITCHEN,
          invitedBy: adminA,
        }),
      ).resolves.toMatchObject({ invitation: { make_owner: false } });
      expect(rows[0].revoked_at).toBeInstanceOf(Date);

      // O superpainel substitui o próprio convite
      const again = await service.create({
        storeId: STORE_A,
        email: 'outro.dono@x.com',
        role: UserRole.ADMIN,
        makeOwner: true,
        invitedBy: superAdmin,
      });
      await expect(
        service.create({
          storeId: STORE_A,
          email: 'outro.dono@x.com',
          role: UserRole.ADMIN,
          makeOwner: true,
          invitedBy: superAdmin,
        }),
      ).resolves.toMatchObject({ invitation: { make_owner: true } });
      expect(
        rows.find((row) => row.id === again.invitation.id)?.revoked_at,
      ).toBeInstanceOf(Date);
      expect(owner.invitation.make_owner).toBe(true);
    });

    it('perfil de cliente → 400; loja inexistente → 404; loja desativada → 400', async () => {
      const { service, storeRows } = setup();
      await expect(
        service.create({
          storeId: STORE_A,
          email: 'x@email.com',
          role: UserRole.CLIENT,
          invitedBy: adminA,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.create({
          storeId: 999,
          email: 'x@email.com',
          role: UserRole.KITCHEN,
          invitedBy: superAdmin,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      storeRows[0].account_status = StoreAccountStatus.INACTIVE;
      await expect(
        service.create({
          storeId: STORE_A,
          email: 'x@email.com',
          role: UserRole.KITCHEN,
          invitedBy: superAdmin,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('convite do superpainel (deliverOnlyByEmail)', () => {
    it('sem SMTP: o link volta para o operador (delivered false), como antes', async () => {
      const { service } = setup();
      const created = await service.create({
        storeId: STORE_A,
        email: 'sem.smtp@email.com',
        role: UserRole.EMPLOYEE,
        invitedBy: superAdmin,
        deliverOnlyByEmail: true,
      });
      expect(created.delivered).toBe(false);
      expect(tokenOf(created.url)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(created.message).toBeUndefined();
    });

    it('com SMTP e envio aceito: url null, delivered true e o e-mail mascarado (o link só vai ao convidado)', async () => {
      const { service, mail, rows, audit } = setup();
      mail.configured = true;
      mail.send.mockResolvedValue({ delivered: true, driver: 'smtp' });
      const created = await service.create({
        storeId: STORE_A,
        email: 'convidado@email.com',
        role: UserRole.EMPLOYEE,
        invitedBy: superAdmin,
        deliverOnlyByEmail: true,
      });
      expect(created).toMatchObject({
        url: null,
        delivered: true,
        message: invitationSentNotice('convidado@email.com'),
      });
      expect(created.message).toContain('co***@email.com');
      expect(JSON.stringify(created)).not.toContain('/convite/');
      expect(rows[0].revoked_at).toBeNull();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'invitation.create',
          metadata: expect.objectContaining({ delivered: true }) as unknown,
        }),
      );
    });

    it('com SMTP e falha no envio: 503 e o convite é cancelado (falha fechada, auditado)', async () => {
      const { service, mail, rows, audit } = setup();
      mail.configured = true;
      mail.send.mockResolvedValue({
        delivered: false,
        driver: 'smtp',
        error: 'falhou',
      });
      await expect(
        service.create({
          storeId: STORE_A,
          email: 'falha@email.com',
          role: UserRole.EMPLOYEE,
          invitedBy: superAdmin,
          deliverOnlyByEmail: true,
        }),
      ).rejects.toThrow(INVITATION_NOT_SENT_MESSAGE);
      expect(rows[0].revoked_at).toBeInstanceOf(Date);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'invitation.revoke',
          result: 'FAILURE',
          metadata: expect.objectContaining({
            reason: 'mail_not_delivered',
          }) as unknown,
        }),
      );
    });

    it('pela loja (sem deliverOnlyByEmail) nada muda com SMTP: url sempre presente', async () => {
      const { service, mail } = setup();
      mail.configured = true;
      mail.send.mockResolvedValue({ delivered: true, driver: 'smtp' });
      const created = await service.create({
        storeId: STORE_A,
        email: 'loja@email.com',
        role: UserRole.EMPLOYEE,
        invitedBy: adminA,
      });
      expect(created.delivered).toBe(true);
      expect(tokenOf(created.url)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
  });

  describe('listByStore e revoke (escopo da loja)', () => {
    async function seed() {
      const ctx = setup();
      for (const [storeId, email] of [
        [STORE_A, 'a1@email.com'],
        [STORE_A, 'a2@email.com'],
        [STORE_B, 'b1@email.com'],
      ] as const) {
        await ctx.service.create({
          storeId,
          email,
          role: UserRole.COURIER,
          invitedBy: storeId === STORE_A ? adminA : superAdmin,
        });
      }
      return ctx;
    }

    it('lista e cancelamento da loja não expõem o id da conta da plataforma que convidou (o superpainel vê)', async () => {
      const ctx = setup();
      const byPlatform = await ctx.service.create({
        storeId: STORE_A,
        email: 'p@email.com',
        role: UserRole.COURIER,
        invitedBy: superAdmin,
      });
      await ctx.service.create({
        storeId: STORE_A,
        email: 'q@email.com',
        role: UserRole.COURIER,
        invitedBy: adminA,
      });
      const store = await ctx.service.listByStore(
        STORE_A,
        {},
        { hidePlatformInviters: true },
      );
      expect(
        store.items.map((item) => [item.email, item.invited_by_user_id]),
      ).toEqual([
        ['q@email.com', adminA.id],
        ['p@email.com', null],
      ]);
      const platform = await ctx.service.listByStore(STORE_A, {});
      expect(platform.items.map((item) => item.invited_by_user_id)).toEqual([
        adminA.id,
        superAdmin.id,
      ]);
      const revoked = await ctx.service.revoke(
        byPlatform.invitation.id,
        STORE_A,
        adminA,
      );
      expect(revoked).toMatchObject({
        status: 'REVOKED',
        invited_by_user_id: null,
      });
    });

    it('lista só os convites da loja, paginado e sem o hash do token', async () => {
      const { service, rows } = await seed();
      rows[0].expires_at = new Date(Date.now() - 1_000); // a1 venceu

      const page = await service.listByStore(STORE_A, { page: 1, pageSize: 1 });
      expect(page).toMatchObject({ total: 2, page: 1, pageSize: 1 });
      expect(page.items.map((item) => item.email)).toEqual(['a2@email.com']);
      expect(JSON.stringify(page)).not.toContain('token_hash');

      const pending = await service.listByStore(STORE_A, { status: 'PENDING' });
      expect(pending.items.map((item) => item.email)).toEqual(['a2@email.com']);
      const expired = await service.listByStore(STORE_A, { status: 'EXPIRED' });
      expect(expired.items.map((item) => item.status)).toEqual(['EXPIRED']);
    });

    it('convite de outra loja → 404 com a mesma mensagem de inexistente', async () => {
      const { service, rows } = await seed();
      const fromB = rows.find((row) => row.store_id === STORE_B) as Invitation;

      for (const id of [fromB.id, 999]) {
        await expect(service.revoke(id, STORE_A, adminA)).rejects.toThrow(
          new NotFoundException(INVITATION_NOT_FOUND_MESSAGE),
        );
      }
      expect(fromB.revoked_at).toBeNull();
    });

    it('cancelar: grava revoked_at pelo critério composto e audita; repetir é idempotente', async () => {
      const { service, rows, invitationsRepo, audit } = await seed();
      const target = rows[0];

      const view = await service.revoke(target.id, STORE_A, adminA);
      expect(view.status).toBe('REVOKED');
      const [criteria] = invitationsRepo.update.mock.calls.at(-1) ?? [{}];
      expect(criteria).toMatchObject({ id: target.id, store_id: STORE_A });
      expect(audit.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'invitation.revoke',
          storeId: STORE_A,
          targetId: target.id,
        }),
      );

      const calls = invitationsRepo.update.mock.calls.length;
      await expect(
        service.revoke(target.id, STORE_A, adminA),
      ).resolves.toMatchObject({ status: 'REVOKED' });
      expect(invitationsRepo.update.mock.calls.length).toBe(calls);
    });

    it('convite já aceito não é cancelado (409)', async () => {
      const { service, rows } = await seed();
      rows[0].accepted_at = new Date();
      await expect(
        service.revoke(rows[0].id, STORE_A, adminA),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('troca do responsável (make_owner) pendente: a loja não cancela (403); o superpainel cancela', async () => {
      const { service, rows, audit } = setup();
      const created = await service.create({
        storeId: STORE_A,
        email: 'novo.dono@x.com',
        role: UserRole.ADMIN,
        makeOwner: true,
        invitedBy: superAdmin,
      });
      const audits = audit.record.mock.calls.length;
      await expect(
        service.revoke(created.invitation.id, STORE_A, adminA),
      ).rejects.toThrow(
        new ForbiddenException(OWNER_INVITATION_PROTECTED_MESSAGE),
      );
      expect(rows[0].revoked_at).toBeNull();
      expect(audit.record.mock.calls.length).toBe(audits);

      await expect(
        service.revokeAsPlatform(created.invitation.id, superAdmin),
      ).resolves.toMatchObject({ status: 'REVOKED' });
      // Já cancelado: a loja vê o mesmo resultado (idempotente), sem erro
      await expect(
        service.revoke(created.invitation.id, STORE_A, adminA),
      ).resolves.toMatchObject({ status: 'REVOKED' });
    });

    it('superpainel cancela convite de qualquer loja; quem não é superadmin → 403', async () => {
      const { service, rows } = await seed();
      const fromB = rows.find((row) => row.store_id === STORE_B) as Invitation;
      await expect(
        service.revokeAsPlatform(fromB.id, adminA),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.revokeAsPlatform(fromB.id, superAdmin),
      ).resolves.toMatchObject({ status: 'REVOKED' });
    });
  });

  describe('link público: conferir e aceitar', () => {
    async function invite(makeOwner = false, role = UserRole.KITCHEN) {
      const ctx = setup();
      const created = await ctx.service.create({
        storeId: STORE_A,
        email: 'convidada@email.com',
        role,
        makeOwner,
        invitedBy: superAdmin,
      });
      return { ...ctx, token: tokenOf(created.url) };
    }

    it('GET: { store: { name, slug, logo }, email_masked, role, expires_at }', async () => {
      const { service, token } = await invite();
      await expect(service.inspect(token)).resolves.toEqual({
        store: { name: 'Loja A', slug: 'loja-a', logo: 'a.webp' },
        email_masked: 'co***@email.com',
        role: UserRole.KITCHEN,
        expires_at: expect.any(Date) as unknown,
      });
    });

    it('convite cancelado, vencido, aceito, de loja desativada ou link inválido → 404 igual', async () => {
      const notFound = new NotFoundException(INVITATION_INVALID_MESSAGE);
      const revoked = await invite();
      revoked.rows[0].revoked_at = new Date();
      await expect(revoked.service.inspect(revoked.token)).rejects.toThrow(
        notFound,
      );

      const expired = await invite();
      expired.rows[0].expires_at = new Date(Date.now() - 1);
      await expect(expired.service.inspect(expired.token)).rejects.toThrow(
        notFound,
      );

      const inactive = await invite();
      inactive.storeRows[0].account_status = StoreAccountStatus.INACTIVE;
      await expect(inactive.service.inspect(inactive.token)).rejects.toThrow(
        notFound,
      );

      await expect(revoked.service.inspect('nao-e-um-token')).rejects.toThrow(
        notFound,
      );
    });

    it('aceitar cria a EQUIPE na loja do convite, com o perfil do convite, e já devolve a sessão', async () => {
      const {
        service,
        token,
        rows,
        users,
        usersTxRepo,
        planLimits,
        jwt,
        audit,
      } = await invite(false, UserRole.COURIER);

      const result = await service.accept(token, {
        ...account,
        phone: '21999990000',
      });

      expect(planLimits.assertWithinLimit).toHaveBeenCalledWith(
        STORE_A,
        'staff_users',
      );
      expect(users.insertUser).toHaveBeenCalledWith(
        usersTxRepo,
        {
          name: 'Nova Pessoa',
          email: 'convidada@email.com',
          password: 'SenhaForte@123',
          phone: '21999990000',
        },
        { role: UserRole.COURIER, storeId: STORE_A },
        ACCOUNT_EXISTS_MESSAGE,
      );
      expect(rows[0].accepted_at).toBeInstanceOf(Date);
      expect(rows[0].accepted_user_id).toBe(result.user.id);

      expect(result.user).toMatchObject({
        role: UserRole.COURIER,
        store_id: STORE_A,
        store: { id: STORE_A, slug: 'loja-a' },
      });
      expect(
        jwt.verify<{ sub: number; tv: number }>(result.access_token),
      ).toMatchObject({ sub: result.user.id, tv: 0 });
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain(
        'SenhaForte@123',
      );

      // Uso único
      await expect(service.accept(token, account)).rejects.toThrow(
        new NotFoundException(INVITATION_INVALID_MESSAGE),
      );
      expect(users.insertUser).toHaveBeenCalledTimes(1);
    });

    it('make_owner: o convidado vira o responsável da loja', async () => {
      const { service, token, storeRows, storesRepo } = await invite(true);
      const { user } = await service.accept(token, account);
      expect(storesRepo.update).toHaveBeenCalledWith(
        { id: STORE_A },
        { owner_user_id: user.id },
      );
      expect(storeRows[0].owner_user_id).toBe(user.id);
    });

    it('e-mail que ganhou conta depois do convite → 409 e o convite continua pendente', async () => {
      const { service, token, rows, users } = await invite();
      users.emailInUse.mockResolvedValueOnce(true);
      await expect(service.accept(token, account)).rejects.toThrow(
        new ConflictException(ACCOUNT_EXISTS_MESSAGE),
      );
      expect(rows[0].accepted_at).toBeNull();
      expect(users.insertUser).not.toHaveBeenCalled();
    });

    it('limite de equipe rígido: conferido de novo DENTRO da transação do aceite, com trava (aceites simultâneos)', async () => {
      const ctx = setup();
      const created = await ctx.service.create({
        storeId: STORE_A,
        email: 'novo@email.com',
        role: UserRole.KITCHEN,
        invitedBy: adminA,
      });
      // Outro aceite ocupou a última vaga enquanto este esperava a trava
      ctx.planLimits.lockAndAssert.mockRejectedValueOnce(
        new ForbiddenException('Limite do plano atingido.'),
      );
      await expect(
        ctx.service.accept(tokenOf(created.url), account),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(ctx.planLimits.lockAndAssert).toHaveBeenCalledWith(
        expect.anything(),
        STORE_A,
        'staff_users',
      );
      expect(ctx.users.insertUser).not.toHaveBeenCalled();
      expect(ctx.rows[0].accepted_at).toBeNull();
    });

    it('limite de equipe do plano → 403 e nada é criado', async () => {
      const { service, token, rows, users, planLimits } = await invite();
      planLimits.assertWithinLimit.mockRejectedValueOnce(
        new ForbiddenException('Limite do plano atingido'),
      );
      await expect(service.accept(token, account)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(users.insertUser).not.toHaveBeenCalled();
      expect(rows[0].accepted_at).toBeNull();
    });

    it('quem convidou perdeu o direito (rebaixado, lixeira, bloqueado, outra loja ou excluído de vez) → convite inválido (404)', async () => {
      const notFound = new NotFoundException(INVITATION_INVALID_MESSAGE);
      const changes: Array<(inviter: User, invitation: Invitation) => void> = [
        (inviter) => (inviter.role = UserRole.EMPLOYEE),
        (inviter) => (inviter.deleted_at = new Date()),
        (inviter) => (inviter.blocked_at = new Date()),
        (inviter) => (inviter.store_id = STORE_B),
        // Exclusão definitiva: o FK zera invited_by_user_id
        (_inviter, invitation) => (invitation.invited_by_user_id = null),
      ];
      for (const change of changes) {
        const ctx = setup();
        const created = await ctx.service.create({
          storeId: STORE_A,
          email: 'reserva@email.com',
          role: UserRole.ADMIN,
          invitedBy: adminA,
        });
        const token = tokenOf(created.url);
        const inviter = ctx.accounts.find((u) => u.id === adminA.id) as User;
        change(inviter, ctx.rows[0]);
        await expect(ctx.service.inspect(token)).rejects.toThrow(notFound);
        await expect(ctx.service.accept(token, account)).rejects.toThrow(
          notFound,
        );
        expect(ctx.users.insertUser).not.toHaveBeenCalled();
        expect(ctx.rows[0].accepted_at).toBeNull();
      }
    });

    it('rebaixado DEPOIS de abrir o link: a transação do aceite confere de novo (com trava) e recusa', async () => {
      const ctx = setup();
      const created = await ctx.service.create({
        storeId: STORE_A,
        email: 'reserva@email.com',
        role: UserRole.ADMIN,
        invitedBy: adminA,
      });
      const inviter = ctx.accounts.find((u) => u.id === adminA.id) as User;
      // Primeira leitura (fora da transação) ainda vê ADMIN; a da transação já vê o rebaixamento
      ctx.usersTxRepo.findOne.mockImplementationOnce(() =>
        Promise.resolve(Object.assign(new User(), inviter)),
      );
      ctx.usersTxRepo.findOne.mockImplementationOnce(() =>
        Promise.resolve(
          Object.assign(new User(), inviter, { role: UserRole.EMPLOYEE }),
        ),
      );
      await expect(
        ctx.service.accept(tokenOf(created.url), account),
      ).rejects.toThrow(new NotFoundException(INVITATION_INVALID_MESSAGE));
      expect(ctx.users.insertUser).not.toHaveBeenCalled();
      const locked = ctx.usersTxRepo.findOne.mock.calls[1] as [
        { lock?: { mode: string }; withDeleted?: boolean },
      ];
      expect(locked[0]).toMatchObject({
        withDeleted: true,
        lock: { mode: 'pessimistic_read' },
      });
    });

    it('convite de um ADMIN ativo da loja ou do superadmin ativo continua valendo; superadmin bloqueado não', async () => {
      const fromAdmin = setup();
      const byAdmin = await fromAdmin.service.create({
        storeId: STORE_A,
        email: 'equipe@email.com',
        role: UserRole.COURIER,
        invitedBy: adminA,
      });
      await expect(
        fromAdmin.service.accept(tokenOf(byAdmin.url), account),
      ).resolves.toHaveProperty('access_token');

      const { service, token, accounts } = await invite();
      (accounts.find((u) => u.id === superAdmin.id) as User).blocked_at =
        new Date();
      await expect(service.inspect(token)).rejects.toThrow(
        new NotFoundException(INVITATION_INVALID_MESSAGE),
      );
    });

    it('rajada simultânea de links inválidos: só o limite TOKEN_REDEEM chega ao banco', async () => {
      process.env.RATE_LIMIT_TOKEN_REDEEM = '5/900';
      const { service, invitationsRepo } = setup();
      const req = { ip: '10.8.8.8', headers: {} } as never;
      const results = await Promise.allSettled(
        Array.from({ length: 40 }, () => service.inspect('y'.repeat(43), req)),
      );
      const statuses = results.map((r) =>
        r.status === 'rejected' ? (r.reason as HttpException).getStatus() : 200,
      );
      expect(statuses.filter((s) => s === 404)).toHaveLength(5);
      expect(statuses.filter((s) => s === 429)).toHaveLength(35);
      expect(invitationsRepo.findOne).toHaveBeenCalledTimes(5);
    });

    it('links inválidos do mesmo IP acima do limite TOKEN_REDEEM → 429 até para um convite válido', async () => {
      process.env.RATE_LIMIT_TOKEN_REDEEM = '3/900';
      const { service, token } = await invite();
      const req = { ip: '10.9.9.9', headers: {} } as never;
      for (let i = 0; i < 3; i++) {
        await expect(
          service.inspect('x'.repeat(43), req),
        ).rejects.toBeInstanceOf(NotFoundException);
      }
      const limited = await service
        .accept(token, account, req)
        .catch((error: unknown) => error);
      expect((limited as HttpException).getStatus()).toBe(429);
    });
  });
});
