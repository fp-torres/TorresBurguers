import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  FindOperator,
  IsNull,
  Not,
  QueryFailedError,
  Repository,
} from 'typeorm';
import type { AccountEmailTokensService } from '../account/account-email-tokens.service';
import type { AccountNoticesService } from '../account/account-notices.service';
import type { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth-user';
import { PasswordResetToken } from '../auth/entities/password-reset-token.entity';
import type { PlanLimitsService } from '../billing/plan-limits.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { Invitation } from '../invitations/entities/invitation.entity';
import { Store, StoreAccountStatus } from '../store/entities/store.entity';
import { AVATAR_ICON_URLS, AVATAR_NOT_ALLOWED_MESSAGE } from './avatar';
import { PlatformRole, User, UserRole } from './entities/user.entity';
import { LAST_ADMIN_MESSAGE } from './users.policy';
import {
  CURRENT_PASSWORD_REQUIRED_MESSAGE,
  CURRENT_PASSWORD_WRONG_MESSAGE,
  EMAIL_TAKEN,
  OWNER_CREDENTIALS_MESSAGE,
  OWNER_INVITATION_EMAIL_MESSAGE,
  OWNER_DELETE_MESSAGE,
  USER_NOT_FOUND,
  UsersService,
} from './users.service';

const STORE_A = 1;
const STORE_B = 2;

type Where = Record<string, unknown>;

/**
 * Avalia um where do TypeORM em memória. Como no banco real (invalidWhereValuesBehavior: throw),
 * null/undefined no where é erro: o teste falha se o serviço esquecer o filtro da loja.
 */
function check(value: unknown, condition: unknown): boolean {
  if (condition instanceof FindOperator) {
    const op = condition as FindOperator<unknown>;
    switch (op.type) {
      case 'isNull':
        return value === null || value === undefined;
      case 'not':
        return op.child ? !check(value, op.child) : value !== op.value;
      case 'raw': {
        const params = op.objectLiteralParameters as {
          normalizedEmail: string;
        };
        return (
          typeof value === 'string' &&
          value.toLowerCase() === params.normalizedEmail
        );
      }
      default:
        throw new Error(`Operador não suportado no teste: ${op.type}`);
    }
  }
  if (condition === undefined || condition === null) {
    throw new Error('null/undefined no where (o TypeORM real recusaria)');
  }
  return value === condition;
}

const matches = (row: User, where: Where) =>
  Object.entries(where).every(([key, condition]) =>
    check((row as unknown as Where)[key], condition),
  );

function makeUser(
  id: number,
  role: UserRole,
  storeId: number | null,
  extra: Partial<User> = {},
): User {
  return Object.assign(new User(), {
    id,
    role,
    store_id: storeId,
    platform_role: null,
    blocked_at: null,
    blocked_reason: null,
    deleted_at: null,
    token_version: 0,
    name: `Usuário ${id}`,
    email: `u${id}@email.com`,
    phone: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...extra,
  });
}

/** SELECT ... FOR UPDATE dos ADMINs da loja (createQueryBuilder). */
interface LockQuery {
  select: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  orderBy: jest.Mock;
  setLock: jest.Mock;
  getMany: jest.Mock;
}

/** Repositório falso: lê e escreve na lista em memória, sempre pelo where recebido. */
function setup(accounts: User[]) {
  const rows = accounts;
  let nextId = 1000;
  const visible = (withDeleted?: boolean) =>
    rows.filter((row) => withDeleted || !row.deleted_at);

  const applyChanges = (row: User, partial: Where) => {
    for (const [key, value] of Object.entries(partial)) {
      if (typeof value === 'function') {
        // Expressões SQL: só o incremento da versão das sessões muda o valor
        if (key === 'token_version') row.token_version += 1;
      } else {
        (row as unknown as Where)[key] = value;
      }
    }
  };

  const lockParams: Where = {};
  const lockQuery: LockQuery = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn((_sql: string, params: Where) => {
      Object.assign(lockParams, params);
      return lockQuery;
    }),
    andWhere: jest.fn((_sql: string, params?: Where) => {
      Object.assign(lockParams, params ?? {});
      return lockQuery;
    }),
    orderBy: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getMany: jest.fn(() =>
      Promise.resolve(
        rows
          .filter(
            (row) =>
              row.store_id === lockParams.storeId &&
              row.role === lockParams.role &&
              !row.deleted_at &&
              !row.blocked_at,
          )
          .map((row) => ({ id: row.id })),
      ),
    ),
  };

  const base = {
    findOne: jest.fn(
      ({ where, withDeleted }: { where: Where; withDeleted?: boolean }) =>
        Promise.resolve(
          visible(withDeleted).find((row) => matches(row, where)) ?? null,
        ),
    ),
    findOneBy: jest.fn((where: Where) =>
      Promise.resolve(visible().find((row) => matches(row, where)) ?? null),
    ),
    find: jest.fn(
      ({ where, withDeleted }: { where: Where; withDeleted?: boolean }) =>
        Promise.resolve(
          visible(withDeleted).filter((row) => matches(row, where)),
        ),
    ),
    exists: jest.fn(
      ({ where, withDeleted }: { where: Where; withDeleted?: boolean }) =>
        Promise.resolve(
          visible(withDeleted).some((row) => matches(row, where)),
        ),
    ),
    update: jest.fn((where: Where, partial: Where) => {
      const hit = rows.filter((row) => matches(row, where));
      hit.forEach((row) => applyChanges(row, partial));
      return Promise.resolve({ affected: hit.length });
    }),
    delete: jest.fn((where: Where) => {
      const hit = rows.filter((row) => matches(row, where));
      hit.forEach((row) => rows.splice(rows.indexOf(row), 1));
      return Promise.resolve({ affected: hit.length });
    }),
    restore: jest.fn((where: Where) => {
      const hit = rows.filter((row) => row.deleted_at && matches(row, where));
      hit.forEach((row) => (row.deleted_at = null as unknown as Date));
      return Promise.resolve({ affected: hit.length });
    }),
    create: jest.fn((data: Partial<User>) => Object.assign(new User(), data)),
    save: jest.fn((entity: User) => {
      Object.assign(entity, {
        id: entity.id ?? nextId++,
        token_version: entity.token_version ?? 0,
        deleted_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
      rows.push(entity);
      return Promise.resolve(entity);
    }),
    createQueryBuilder: jest.fn(() => lockQuery),
  };
  // Links de redefinição de senha (password_reset_tokens): só o "vencer os pendentes" é usado aqui
  const resetLinks = {
    update: jest.fn().mockResolvedValue({ affected: 0 }),
  };
  // A transação usa o mesmo repositório falso (a trava dos ADMINs vem do lockQuery)
  const repositoryFor = (entity: unknown) =>
    entity === PasswordResetToken ? resetLinks : base;
  const txManager = { getRepository: jest.fn(repositoryFor) };
  const repo = Object.assign(base, {
    manager: {
      transaction: jest.fn((work: (manager: typeof txManager) => unknown) =>
        work(txManager),
      ),
      getRepository: jest.fn(repositoryFor),
    },
  });

  const storeRows: Partial<Store>[] = [
    {
      id: STORE_A,
      slug: 'loja-a',
      name: 'Loja A',
      logo: null,
      primary_color: '#112233',
      account_status: StoreAccountStatus.ACTIVE,
      mp_access_token_encrypted: 'v1:segredo',
    },
    {
      id: STORE_B,
      slug: 'loja-b',
      name: 'Loja B',
      logo: 'b.webp',
      primary_color: null,
      account_status: StoreAccountStatus.ACTIVE,
    },
  ];
  const stores = {
    findOne: jest.fn(({ where }: { where: { id: number } }) =>
      Promise.resolve(storeRows.find((store) => store.id === where.id) ?? null),
    ),
  };
  const planLimits = {
    assertWithinLimit: jest.fn().mockResolvedValue(undefined),
    lockAndAssert: jest.fn().mockResolvedValue(undefined),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  // Verificação de e-mail (account/): links e avisos falsos, conferidos pelos testes da troca
  let tokenSeq = 0;
  const emailTokens = {
    issue: jest.fn((input: { purpose: string }) =>
      Promise.resolve({
        token: `TOKEN_${input.purpose}_${++tokenSeq}`,
        record: { id: tokenSeq },
      }),
    ),
    revokeOpen: jest.fn().mockResolvedValue(0),
    isReserved: jest.fn().mockResolvedValue(false),
  };
  const notices = {
    verification: jest.fn().mockResolvedValue(false),
    emailChanged: jest.fn().mockResolvedValue(false),
    passwordChanged: jest.fn().mockResolvedValue(false),
  };

  // Convites (cancelados quando quem convidou perde o direito de convidar)
  const invitationRows: Invitation[] = [];
  const invitations = {
    find: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(
        invitationRows.filter((row) =>
          matchesInvitation(row as unknown as Where, where),
        ),
      ),
    ),
    exists: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(
        invitationRows.some((row) =>
          matchesInvitation(row as unknown as Where, where),
        ),
      ),
    ),
    update: jest.fn((where: Where, partial: Where) => {
      const hit = invitationRows.filter((row) =>
        matchesInvitation(row as unknown as Where, where),
      );
      hit.forEach((row) => Object.assign(row, partial));
      return Promise.resolve({ affected: hit.length });
    }),
  };
  const rateLimit = new RateLimitService();

  const service = new UsersService(
    repo as unknown as Repository<User>,
    stores as unknown as Repository<Store>,
    planLimits as unknown as PlanLimitsService,
    audit as unknown as AuditService,
    invitations as unknown as Repository<Invitation>,
    rateLimit,
    emailTokens as unknown as AccountEmailTokensService,
    notices as unknown as AccountNoticesService,
  );
  return {
    service,
    emailTokens,
    notices,
    txManager,
    repo,
    rows,
    lockQuery,
    lockParams,
    stores,
    storeRows,
    planLimits,
    audit,
    invitationRows,
    invitations,
    rateLimit,
    resetLinks,
  };
}

/** where dos convites em memória (inclui In e MoreThan). */
function matchesInvitation(row: Where, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key];
    if (condition instanceof FindOperator) {
      const op = condition as FindOperator<unknown>;
      if (op.type === 'in') {
        return (op.value as unknown[]).includes(value);
      }
      if (op.type === 'moreThan') {
        return (
          value instanceof Date &&
          value.getTime() > new Date(op.value as Date).getTime()
        );
      }
      if (op.type === 'isNull') return value === null || value === undefined;
      throw new Error(`Operador não suportado no teste: ${op.type}`);
    }
    return value === condition;
  });
}

/** Operador autenticado (req.user) das operações auditadas. */
function actor(user: User, extra: Partial<AuthUser> = {}): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    storeId: user.store_id,
    platformRole: user.platform_role,
    supportSession: null,
    ...extra,
  };
}

/** ADMIN da loja que não está na lista (só identifica quem age na auditoria). */
const operatorOf = (storeId: number) =>
  actor(makeUser(500 + storeId, UserRole.ADMIN, storeId));

const notFound = new NotFoundException(USER_NOT_FOUND);
const lastAdmin = new BadRequestException(LAST_ADMIN_MESSAGE);

/** Duas lojas, cada uma com a sua equipe, mais clientes globais e o superadmin. */
function twoStores() {
  return [
    makeUser(1, UserRole.ADMIN, STORE_A),
    makeUser(2, UserRole.KITCHEN, STORE_A),
    makeUser(3, UserRole.COURIER, STORE_A, { deleted_at: new Date() }),
    makeUser(11, UserRole.ADMIN, STORE_B),
    makeUser(12, UserRole.ADMIN, STORE_B),
    makeUser(13, UserRole.EMPLOYEE, STORE_B),
    makeUser(20, UserRole.CLIENT, null),
    makeUser(90, UserRole.CLIENT, null, {
      platform_role: PlatformRole.SUPER_ADMIN,
    }),
  ];
}

describe('UsersService: equipe escopada pela loja', () => {
  it('lista só a equipe ativa da loja (nunca clientes, outra loja, superadmin ou lixeira)', async () => {
    const { service, repo } = setup(twoStores());

    const team = await service.findTeam(STORE_A);
    expect(team.map((user) => user.id)).toEqual([1, 2]);
    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          store_id: STORE_A,
          role: Not(UserRole.CLIENT),
          platform_role: IsNull(),
        },
      }),
    );

    const trash = await service.findTrash(STORE_A);
    expect(trash.map((user) => user.id)).toEqual([3]);
    expect((await service.findTrash(STORE_B)).map((u) => u.id)).toEqual([]);
  });

  it('ADMIN da loja B → 404 (mesma mensagem) para equipe da loja A, cliente, superadmin e id inexistente', async () => {
    const { service } = setup(twoStores());
    for (const id of [1, 2, 20, 90, 4242]) {
      await expect(service.findTeamMember(id, STORE_B)).rejects.toThrow(
        notFound,
      );
    }
    await expect(service.findTeamMember(13, STORE_B)).resolves.toMatchObject({
      id: 13,
    });
  });

  it('sem loja validada nenhuma consulta acontece (falha fechada)', async () => {
    const { service, repo } = setup(twoStores());
    await expect(
      service.findTeam(undefined as unknown as number),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.findTeamMember(1, 0)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(repo.find).not.toHaveBeenCalled();
    expect(repo.findOne).not.toHaveBeenCalled();
  });

  it('ADMIN da loja B não edita, não exclui, não restaura nem apaga a equipe da loja A', async () => {
    const accounts = twoStores();
    const { service, repo } = setup(accounts);
    const adminB = actor(accounts[3]);

    await expect(
      service.updateTeamMember(2, STORE_B, { name: 'Invadido' }, adminB),
    ).rejects.toThrow(notFound);
    await expect(service.removeTeamMember(2, STORE_B, adminB)).rejects.toThrow(
      notFound,
    );
    await expect(service.restore(3, STORE_B, adminB)).rejects.toThrow(notFound);
    await expect(service.purge(3, STORE_B, adminB)).rejects.toThrow(notFound);
    await expect(
      service.updateTeamMember(20, STORE_B, { name: 'Cliente' }, adminB),
    ).rejects.toThrow(notFound);

    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.delete).not.toHaveBeenCalled();
    expect(repo.restore).not.toHaveBeenCalled();
    expect(accounts.find((u) => u.id === 2)?.name).toBe('Usuário 2');
  });

  describe('updateTeamMember', () => {
    it('troca de perfil entre perfis da equipe encerra as sessões do membro e é auditada', async () => {
      const accounts = twoStores();
      const { service, repo, audit } = setup(accounts);

      const updated = await service.updateTeamMember(
        2,
        STORE_A,
        { role: UserRole.COURIER },
        actor(accounts[0]),
      );

      expect(updated.role).toBe(UserRole.COURIER);
      expect(updated.token_version).toBe(1);
      const [criteria] = repo.update.mock.calls[0];
      expect(criteria).toEqual({
        id: 2,
        store_id: STORE_A,
        deleted_at: IsNull(),
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'store.staff.update',
          storeId: STORE_A,
          targetId: 2,
          metadata: expect.objectContaining({
            role_from: UserRole.KITCHEN,
            role_to: UserRole.COURIER,
            sessions_revoked: true,
          }) as unknown,
        }),
      );
    });

    it('nunca vira cliente (400) e nada é gravado', async () => {
      const accounts = twoStores();
      const { service, repo } = setup(accounts);
      await expect(
        service.updateTeamMember(
          2,
          STORE_A,
          { role: UserRole.CLIENT },
          actor(accounts[0]),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('troca de senha ou de e-mail pelo ADMIN encerra as sessões do membro; nome não', async () => {
      const accounts = twoStores();
      const { service, rows } = setup(accounts);
      const admin = actor(accounts[0]);

      await service.updateTeamMember(2, STORE_A, { name: 'Novo' }, admin);
      expect(rows.find((u) => u.id === 2)?.token_version).toBe(0);

      await service.updateTeamMember(
        2,
        STORE_A,
        { password: 'NovaSenha#2026' },
        admin,
      );
      const member = rows.find((u) => u.id === 2) as User & {
        password_hash: string;
      };
      expect(member.token_version).toBe(1);
      await expect(
        bcrypt.compare('NovaSenha#2026', member.password_hash),
      ).resolves.toBe(true);

      await service.updateTeamMember(
        2,
        STORE_A,
        { email: 'NOVO@Email.com ' },
        admin,
      );
      expect(member.email).toBe('novo@email.com');
      expect(member.token_version).toBe(2);
    });

    it('e-mail de outra conta (inclusive de outra caixa ou na lixeira) → 409', async () => {
      const accounts = twoStores();
      const { service } = setup(accounts);
      for (const email of ['u20@email.com', 'U3@EMAIL.COM']) {
        await expect(
          service.updateTeamMember(2, STORE_A, { email }, actor(accounts[0])),
        ).rejects.toBeInstanceOf(ConflictException);
      }
    });
  });

  describe('último ADMIN por loja', () => {
    it('rebaixar ou excluir o único ADMIN ativo da loja → 400, mesmo com ADMINs em outra loja', async () => {
      const accounts = [
        ...twoStores(),
        // ADMIN bloqueado não conta como administrador ativo
        makeUser(4, UserRole.ADMIN, STORE_A, { blocked_at: new Date() }),
      ];
      const { service, repo, lockQuery, lockParams } = setup(accounts);
      // Ex.: corrida entre dois ADMINs; o operador em si não muda a regra do serviço
      const operator = operatorOf(STORE_A);
      const target = 1;

      await expect(
        service.updateTeamMember(
          target,
          STORE_A,
          { role: UserRole.EMPLOYEE },
          operator,
        ),
      ).rejects.toThrow(lastAdmin);
      await expect(
        service.removeTeamMember(target, STORE_A, operator),
      ).rejects.toThrow(lastAdmin);

      // Só os ADMINs da loja do alvo são travados, sempre na mesma ordem
      expect(lockParams).toMatchObject({
        storeId: STORE_A,
        role: UserRole.ADMIN,
      });
      expect(lockQuery.orderBy).toHaveBeenCalledWith('u.id', 'ASC');
      expect(lockQuery.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('com outro ADMIN ativo na loja, rebaixar e excluir seguem dentro da transação', async () => {
      const accounts = twoStores();
      const { service, repo, rows } = setup(accounts);
      const operator = operatorOf(STORE_B);

      await service.updateTeamMember(
        12,
        STORE_B,
        { role: UserRole.EMPLOYEE },
        operator,
      );
      expect(repo.manager.transaction).toHaveBeenCalledTimes(1);
      expect(rows.find((u) => u.id === 12)?.role).toBe(UserRole.EMPLOYEE);

      // Agora o 11 é o único ADMIN da loja B
      await expect(
        service.removeTeamMember(11, STORE_B, operator),
      ).rejects.toThrow(lastAdmin);
    });

    it('contas que não são ADMIN ativo não abrem transação', async () => {
      const accounts = twoStores();
      const { service, repo } = setup(accounts);
      await service.removeTeamMember(2, STORE_A, actor(accounts[0]));
      expect(repo.manager.transaction).not.toHaveBeenCalled();
    });
  });

  describe('lixeira, restauração e exclusão definitiva', () => {
    it('lixeira: critério composto (id + loja), deleted_at e sessões encerradas numa escrita só', async () => {
      const accounts = twoStores();
      const { service, repo, rows, audit } = setup(accounts);

      await expect(
        service.removeTeamMember(2, STORE_A, actor(accounts[0])),
      ).resolves.toEqual({ message: 'Usuário removido.' });

      const [criteria, values] = repo.update.mock.calls[0];
      expect(criteria).toEqual({
        id: 2,
        store_id: STORE_A,
        deleted_at: IsNull(),
      });
      expect(values.deleted_at).toBeInstanceOf(Date);
      expect(typeof values.token_version).toBe('function');
      expect(rows.find((u) => u.id === 2)?.token_version).toBe(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'store.staff.delete',
          storeId: STORE_A,
        }),
      );
    });

    it('restaurar respeita o limite de equipe do plano (rígido, na transação) e só restaura na própria loja', async () => {
      const accounts = twoStores();
      const { service, repo, planLimits, txManager } = setup(accounts);

      const restored = await service.restore(3, STORE_A, actor(accounts[0]));
      expect(restored.deleted_at).toBeNull();
      // Trava por loja + nova contagem na MESMA transação da restauração (restaurações simultâneas
      // não passam do max_staff_users)
      expect(planLimits.lockAndAssert).toHaveBeenCalledWith(
        txManager,
        STORE_A,
        'staff_users',
      );
      expect(repo.manager.transaction).toHaveBeenCalledTimes(1);
      expect(repo.restore).toHaveBeenCalledWith({ id: 3, store_id: STORE_A });
      expect(planLimits.lockAndAssert.mock.invocationCallOrder[0]).toBeLessThan(
        repo.restore.mock.invocationCallOrder[0],
      );
    });

    it('restaurar acima do limite do plano → 403 e a conta continua na lixeira', async () => {
      const accounts = twoStores();
      const { service, planLimits, rows } = setup(accounts);
      planLimits.lockAndAssert.mockRejectedValueOnce(
        new ForbiddenException('Limite do plano atingido'),
      );
      await expect(
        service.restore(3, STORE_A, actor(accounts[0])),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(rows.find((u) => u.id === 3)?.deleted_at).toBeTruthy();
    });

    it('exclusão definitiva só de quem está na lixeira (400) e pelo critério composto', async () => {
      const accounts = twoStores();
      const { service, repo, rows } = setup(accounts);

      await expect(
        service.purge(2, STORE_A, actor(accounts[0])),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        service.purge(3, STORE_A, actor(accounts[0])),
      ).resolves.toEqual({ message: 'Usuário excluído definitivamente.' });
      expect(repo.delete).toHaveBeenCalledWith({
        id: 3,
        store_id: STORE_A,
        deleted_at: Not(IsNull()),
      });
      expect(rows.some((u) => u.id === 3)).toBe(false);
    });

    it('conta com pedidos → 409 com o motivo', async () => {
      const accounts = twoStores();
      const { service, repo } = setup(accounts);
      repo.delete.mockRejectedValueOnce(
        new QueryFailedError(
          'DELETE',
          [],
          Object.assign(new Error('fk'), { code: '23503' }),
        ),
      );
      await expect(
        service.purge(3, STORE_A, actor(accounts[0])),
      ).rejects.toThrow(
        new ConflictException(
          'Não é possível excluir definitivamente: o usuário possui pedidos vinculados.',
        ),
      );
    });
  });

  describe('cadastro', () => {
    it('equipe criada pelo ADMIN fica na loja informada, respeita o plano e é auditada', async () => {
      const accounts = twoStores();
      const { service, planLimits, audit } = setup(accounts);

      const user = (await service.createStaff(
        {
          name: 'Nova Cozinha',
          email: ' Cozinha@Email.com',
          password: 'SenhaForte@123',
        },
        UserRole.KITCHEN,
        STORE_A,
        actor(accounts[0]),
      )) as User & { password_hash: string };

      expect(user).toMatchObject({
        role: UserRole.KITCHEN,
        store_id: STORE_A,
        platform_role: null,
        email: 'cozinha@email.com',
      });
      await expect(
        bcrypt.compare('SenhaForte@123', user.password_hash),
      ).resolves.toBe(true);
      expect(planLimits.assertWithinLimit).toHaveBeenCalledWith(
        STORE_A,
        'staff_users',
      );
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain(
        'SenhaForte@123',
      );
    });

    it('limite de equipe rígido: trava e nova contagem na transação do INSERT (cadastros simultâneos)', async () => {
      const accounts = twoStores();
      const { service, planLimits, repo, txManager, rows } = setup(accounts);
      // A conferência antecipada passa; a da transação (outra gravação acabou de ocupar a vaga) recusa
      planLimits.lockAndAssert.mockRejectedValueOnce(
        new ForbiddenException('Limite do plano atingido'),
      );
      const before = rows.length;
      await expect(
        service.createStaff(
          { name: 'Y', email: 'y@email.com', password: 'SenhaForte@123' },
          UserRole.EMPLOYEE,
          STORE_A,
          actor(accounts[0]),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(planLimits.lockAndAssert).toHaveBeenCalledWith(
        txManager,
        STORE_A,
        'staff_users',
      );
      expect(repo.save).not.toHaveBeenCalled();
      expect(rows).toHaveLength(before);

      await service.createStaff(
        { name: 'Z', email: 'z@email.com', password: 'SenhaForte@123' },
        UserRole.EMPLOYEE,
        STORE_A,
        actor(accounts[0]),
      );
      expect(planLimits.lockAndAssert.mock.invocationCallOrder[1]).toBeLessThan(
        repo.save.mock.invocationCallOrder[0],
      );
    });

    it('limite de equipe do plano atingido → nada é criado', async () => {
      const accounts = twoStores();
      const { service, planLimits, repo } = setup(accounts);
      planLimits.assertWithinLimit.mockRejectedValueOnce(
        new ForbiddenException('Limite do plano atingido'),
      );
      await expect(
        service.createStaff(
          { name: 'X', email: 'x@email.com', password: 'SenhaForte@123' },
          UserRole.COURIER,
          STORE_A,
          actor(accounts[0]),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('perfil CLIENT como equipe → 400', async () => {
      const accounts = twoStores();
      const { service, repo } = setup(accounts);
      await expect(
        service.createStaff(
          { name: 'X', email: 'x@email.com', password: 'SenhaForte@123' },
          UserRole.CLIENT,
          STORE_A,
          actor(accounts[0]),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('cadastro público: cliente global (sem loja, sem papel na plataforma); e-mail usado (inclusive na lixeira) → 409', async () => {
      const { service } = setup(twoStores());
      await expect(
        service.createClient({
          name: 'Cliente',
          email: 'novo@email.com',
          password: 'SenhaForte@123',
        }),
      ).resolves.toMatchObject({
        role: UserRole.CLIENT,
        store_id: null,
        platform_role: null,
      });
      await expect(
        service.createClient({
          name: 'Repetido',
          email: 'U3@email.com',
          password: 'SenhaForte@123',
        }),
      ).rejects.toThrow(new ConflictException('E-mail já cadastrado'));
    });
  });

  describe('própria conta', () => {
    it('trocar o e-mail ou a senha encerra as sessões; nome ou o mesmo e-mail em outra caixa não', async () => {
      const accounts = twoStores();
      const { service, rows } = setup(accounts);
      const me = actor(accounts[6]);

      let result = await service.updateSelf(me, { name: 'Só o nome' });
      expect(result.sessionsRevoked).toBe(false);

      result = await service.updateSelf(me, { email: 'U20@EMAIL.COM' });
      expect(result.sessionsRevoked).toBe(false);

      result = await service.updateSelf(me, { email: 'outro@email.com' });
      expect(result.sessionsRevoked).toBe(true);
      expect(result.user.email).toBe('outro@email.com');
      expect(rows.find((u) => u.id === 20)?.token_version).toBe(1);

      result = await service.updateSelf(me, { password: 'NovaSenha#2026' });
      expect(result.sessionsRevoked).toBe(true);
      expect(result.user.token_version).toBe(2);
    });

    it('a edição da própria conta usa o critério da conta (cliente: store_id IS NULL) e nunca muda o perfil', async () => {
      const accounts = twoStores();
      const { service, repo, rows } = setup(accounts);
      await service.updateSelf(actor(accounts[6]), {
        name: 'Cliente',
        role: UserRole.ADMIN,
      });
      const [criteria, values] = repo.update.mock.calls[0];
      expect(criteria).toEqual({ id: 20, store_id: IsNull() });
      expect(values).not.toHaveProperty('role');
      expect(rows.find((u) => u.id === 20)?.role).toBe(UserRole.CLIENT);
    });

    it('excluir a própria conta: lixeira + sessões encerradas', async () => {
      const accounts = twoStores();
      const { service, rows } = setup(accounts);
      await service.removeSelf(actor(accounts[6]));
      const me = rows.find((u) => u.id === 20);
      expect(me?.deleted_at).toBeInstanceOf(Date);
      expect(me?.token_version).toBe(1);
    });
  });

  describe('superpainel: bloqueio e sessões', () => {
    it('somente o superadmin bloqueia; nunca a si mesmo', async () => {
      const accounts = twoStores();
      const { service, repo } = setup(accounts);
      const superAdmin = actor(accounts[7]);

      await expect(
        service.block(20, 'fraude', actor(accounts[0])),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.block(superAdmin.id, 'teste', superAdmin),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Sessão de suporte não é o superpainel
      await expect(
        service.block(20, 'x', {
          ...superAdmin,
          supportSession: { id: 1, storeId: STORE_A, expiresAt: new Date() },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('bloquear grava o motivo, encerra as sessões e audita; desbloquear também encerra', async () => {
      const accounts = twoStores();
      const { service, rows, audit } = setup(accounts);
      const superAdmin = actor(accounts[7]);

      const blocked = await service.block(
        2,
        '  conta comprometida ',
        superAdmin,
      );
      expect(blocked.blocked_at).toBeInstanceOf(Date);
      expect(blocked.blocked_reason).toBe('conta comprometida');
      expect(rows.find((u) => u.id === 2)?.token_version).toBe(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'user.block',
          storeId: STORE_A,
          targetId: 2,
          metadata: expect.objectContaining({
            reason: 'conta comprometida',
          }) as unknown,
        }),
      );

      const unblocked = await service.unblock(2, superAdmin);
      expect(unblocked.blocked_at).toBeNull();
      expect(unblocked.blocked_reason).toBeNull();
      expect(unblocked.token_version).toBe(2);
    });

    it('encerrar sessões: a própria conta ou o superadmin', async () => {
      const accounts = twoStores();
      const { service, rows, audit } = setup(accounts);

      await service.revokeSessions(20, actor(accounts[6]));
      expect(rows.find((u) => u.id === 20)?.token_version).toBe(1);
      expect(audit.record).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'auth.logout_all' }),
      );

      await expect(
        service.revokeSessions(2, actor(accounts[6])),
      ).rejects.toBeInstanceOf(ForbiddenException);

      await service.revokeSessions(2, actor(accounts[7]));
      expect(rows.find((u) => u.id === 2)?.token_version).toBe(1);
      expect(audit.record).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'user.revoke_sessions' }),
      );
    });
  });

  describe('apresentação', () => {
    it('equipe com o resumo da loja (lido uma vez) e deleted_at, sem campos internos', async () => {
      const accounts = twoStores();
      const { service, stores } = setup(accounts);
      accounts[0].token_version = 7;
      (accounts[0] as User & { password_hash: string }).password_hash = 'x';

      const team = await service.presentTeam(
        await service.findTeam(STORE_A),
        STORE_A,
      );
      expect(stores.findOne).toHaveBeenCalledTimes(1);
      expect(team[0]).toMatchObject({
        id: 1,
        store_id: STORE_A,
        deleted_at: null,
        store: {
          id: STORE_A,
          slug: 'loja-a',
          name: 'Loja A',
          logo: null,
          primary_color: '#112233',
          account_status: StoreAccountStatus.ACTIVE,
        },
      });
      const json = JSON.stringify(team);
      for (const secret of [
        'password_hash',
        'token_version',
        'blocked_reason',
        'mp_access_token_encrypted',
        'segredo',
      ]) {
        expect(json).not.toContain(secret);
      }
    });
  });
});

describe('UsersService: endurecimento da identidade', () => {
  const originalEnv = { ...process.env };
  let uploads: string;

  beforeAll(() => {
    uploads = mkdtempSync(join(tmpdir(), 'users-service-uploads-'));
  });

  beforeEach(() => {
    process.env = { ...originalEnv, UPLOADS_DIR: uploads };
    process.env.RATE_LIMIT_ENABLED = 'true';
    delete process.env.RATE_LIMIT_CREDENTIALS_CHANGE;
    delete process.env.RATE_LIMIT_TEAM_WRITE;
  });

  afterAll(() => {
    process.env = originalEnv;
    rmSync(uploads, { recursive: true, force: true });
  });

  /** Loja A com o responsável (1) e um segundo ADMIN (4) que age sobre ele. */
  function withOwner() {
    const accounts = [
      ...twoStores(),
      makeUser(4, UserRole.ADMIN, STORE_A, { email: 'coadmin@email.com' }),
    ];
    const ctx = setup(accounts);
    ctx.storeRows[0].owner_user_id = 1;
    return { ...ctx, accounts, coAdmin: actor(accounts[8]) };
  }

  describe('responsável pela loja (owner_user_id)', () => {
    it('outro ADMIN não troca e-mail, senha nem perfil do responsável (403) e nada é gravado', async () => {
      const { service, rows, coAdmin } = withOwner();
      for (const dto of [
        { email: 'tomada@email.com' },
        { password: 'Tomada#2026x' },
        { role: UserRole.COURIER },
        { name: 'Ok', email: 'tomada@email.com' },
      ]) {
        await expect(
          service.updateTeamMember(1, STORE_A, dto, coAdmin),
        ).rejects.toThrow(new ForbiddenException(OWNER_CREDENTIALS_MESSAGE));
      }
      const owner = rows.find((u) => u.id === 1) as User;
      expect(owner).toMatchObject({
        email: 'u1@email.com',
        role: UserRole.ADMIN,
        token_version: 0,
      });
      expect(owner.name).toBe('Usuário 1');
    });

    it('nome e telefone do responsável continuam editáveis (o mesmo e-mail reenviado não conta como troca)', async () => {
      const { service, rows, coAdmin } = withOwner();
      await service.updateTeamMember(
        1,
        STORE_A,
        { name: 'Dono', email: 'U1@email.com', phone: '21999990000' },
        coAdmin,
      );
      expect(rows.find((u) => u.id === 1)).toMatchObject({
        name: 'Dono',
        phone: '21999990000',
        token_version: 0,
      });
    });

    it('responsável não vai para a lixeira nem é excluído de vez pela equipe (403); os demais ADMINs sim', async () => {
      const { service, rows, coAdmin, accounts } = withOwner();
      await expect(
        service.removeTeamMember(1, STORE_A, coAdmin),
      ).rejects.toThrow(new ForbiddenException(OWNER_DELETE_MESSAGE));
      expect(rows.find((u) => u.id === 1)?.deleted_at).toBeNull();

      // Responsável que já estava na lixeira (dado antigo): exclusão definitiva também recusada
      (rows.find((u) => u.id === 1) as User).deleted_at = new Date();
      await expect(service.purge(1, STORE_A, coAdmin)).rejects.toThrow(
        new ForbiddenException(OWNER_DELETE_MESSAGE),
      );
      expect(rows.some((u) => u.id === 1)).toBe(true);
      (rows.find((u) => u.id === 1) as User).deleted_at = null as never;

      // O co-ADMIN (que não é o responsável) pode ser rebaixado pelo responsável
      await service.updateTeamMember(
        4,
        STORE_A,
        { role: UserRole.EMPLOYEE },
        actor(accounts[0]),
      );
      expect(rows.find((u) => u.id === 4)?.role).toBe(UserRole.EMPLOYEE);
    });
  });

  describe('e-mail com convite de troca do responsável (make_owner) pendente na loja', () => {
    const ownerInvitation = (overrides: Partial<Invitation> = {}) =>
      Object.assign(new Invitation(), {
        id: 70,
        store_id: STORE_A,
        email: 'novo-dono@email.com',
        role: UserRole.ADMIN,
        make_owner: true,
        invited_by_user_id: 90,
        accepted_at: null,
        revoked_at: null,
        expires_at: new Date(Date.now() + 86_400_000),
        ...overrides,
      });
    const conflict = new ConflictException(OWNER_INVITATION_EMAIL_MESSAGE);

    it('o ADMIN não reserva o e-mail do convidado: criar equipe, trocar o e-mail de um membro ou o próprio → 409 e nada é gravado', async () => {
      const { service, invitationRows, rows, accounts, coAdmin, audit, repo } =
        withOwner();
      invitationRows.push(ownerInvitation());
      const before = rows.length;

      await expect(
        service.createStaff(
          {
            name: 'Reserva',
            email: ' Novo-Dono@Email.com ',
            password: 'SenhaForte@123',
          },
          UserRole.KITCHEN,
          STORE_A,
          coAdmin,
        ),
      ).rejects.toThrow(conflict);
      expect(rows).toHaveLength(before);
      expect(repo.save).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'store.staff.create',
          result: 'FAILURE',
          metadata: expect.objectContaining({
            reason: 'owner_invitation_pending',
          }) as unknown,
        }),
      );

      await expect(
        service.updateTeamMember(
          2,
          STORE_A,
          { email: 'novo-dono@email.com' },
          coAdmin,
        ),
      ).rejects.toThrow(conflict);
      expect(rows.find((u) => u.id === 2)?.email).not.toBe(
        'novo-dono@email.com',
      );

      await expect(
        service.updateSelf(coAdmin, { email: 'novo-dono@email.com' }),
      ).rejects.toThrow(conflict);
      expect(accounts[8].email).toBe('coadmin@email.com');
    });

    it('convite vencido, aceito, cancelado, comum ou de outra loja não reserva o e-mail', async () => {
      for (const overrides of [
        { expires_at: new Date(Date.now() - 1_000) },
        { accepted_at: new Date() },
        { revoked_at: new Date() },
        { make_owner: false },
        { store_id: STORE_B },
      ]) {
        const { service, invitationRows, coAdmin } = withOwner();
        invitationRows.push(ownerInvitation(overrides));
        await expect(
          service.createStaff(
            {
              name: 'Livre',
              email: 'novo-dono@email.com',
              password: 'SenhaForte@123',
            },
            UserRole.KITCHEN,
            STORE_A,
            coAdmin,
          ),
        ).resolves.toMatchObject({ email: 'novo-dono@email.com' });
      }
    });
  });

  describe('convites de quem perde o direito de convidar', () => {
    const pendingFrom = (
      id: number,
      inviterId: number,
      overrides: Partial<Invitation> = {},
    ) =>
      Object.assign(new Invitation(), {
        id,
        store_id: STORE_A,
        email: `convite${id}@email.com`,
        role: UserRole.ADMIN,
        invited_by_user_id: inviterId,
        accepted_at: null,
        revoked_at: null,
        expires_at: new Date(Date.now() + 86_400_000),
        ...overrides,
      });

    it('ADMIN rebaixado: os convites pendentes dele são cancelados e auditados (os de outros não)', async () => {
      const { service, invitationRows, audit, accounts } = withOwner();
      invitationRows.push(
        pendingFrom(1, 4),
        pendingFrom(2, 4, { accepted_at: new Date() }),
        pendingFrom(3, 1),
      );
      await service.updateTeamMember(
        4,
        STORE_A,
        { role: UserRole.EMPLOYEE },
        actor(accounts[0]),
      );
      expect(invitationRows.map((i) => [i.id, !!i.revoked_at])).toEqual([
        [1, true],
        [2, false],
        [3, false],
      ]);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'invitation.revoke',
          targetId: 1,
          storeId: STORE_A,
          metadata: expect.objectContaining({
            reason: 'inviter_demoted',
            inviter_user_id: 4,
          }) as unknown,
        }),
      );
    });

    it('lixeira e bloqueio pela plataforma também cancelam os convites pendentes da conta', async () => {
      const trashed = withOwner();
      trashed.invitationRows.push(pendingFrom(1, 4));
      await trashed.service.removeTeamMember(
        4,
        STORE_A,
        actor(trashed.accounts[0]),
      );
      expect(trashed.invitationRows[0].revoked_at).toBeInstanceOf(Date);

      const blocked = withOwner();
      blocked.invitationRows.push(pendingFrom(1, 4));
      await blocked.service.block(4, 'Fraude', actor(blocked.accounts[7]));
      expect(blocked.invitationRows[0].revoked_at).toBeInstanceOf(Date);
      expect(blocked.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'invitation.revoke',
          metadata: expect.objectContaining({
            reason: 'inviter_blocked',
          }) as unknown,
        }),
      );
    });
  });

  describe('troca das próprias credenciais', () => {
    async function withPassword(platform = false) {
      const accounts = twoStores();
      const me = accounts[platform ? 7 : 6];
      me.password_hash = await bcrypt.hash('SenhaAtual#1', 4);
      const ctx = setup(accounts);
      return { ...ctx, me, session: actor(me) };
    }

    it('senha atual enviada: errada → 400 e nada muda; certa → troca', async () => {
      const { service, rows, session, me } = await withPassword();
      await expect(
        service.updateSelf(session, {
          password: 'NovaSenha#2026',
          current_password: 'Errada#000',
        }),
      ).rejects.toThrow(
        new BadRequestException(CURRENT_PASSWORD_WRONG_MESSAGE),
      );
      expect(rows.find((u) => u.id === me.id)?.token_version).toBe(0);

      const ok = await service.updateSelf(session, {
        email: 'novo@email.com',
        current_password: 'SenhaAtual#1',
      });
      expect(ok.sessionsRevoked).toBe(true);
      expect(ok.user.email).toBe('novo@email.com');
    });

    it('conta da plataforma: sem a senha atual → 400; cliente sem ela continua aceito (app mobile)', async () => {
      const platform = await withPassword(true);
      await expect(
        platform.service.updateSelf(platform.session, {
          password: 'NovaSenha#2026',
        }),
      ).rejects.toThrow(
        new BadRequestException(CURRENT_PASSWORD_REQUIRED_MESSAGE),
      );
      await expect(
        platform.service.updateSelf(platform.session, { name: 'Só o nome' }),
      ).resolves.toHaveProperty('sessionsRevoked', false);

      const client = await withPassword();
      await expect(
        client.service.updateSelf(client.session, {
          password: 'NovaSenha#2026',
        }),
      ).resolves.toHaveProperty('sessionsRevoked', true);
    });

    it('falhas (senha atual errada ou e-mail já usado) contam no limite CREDENTIALS_CHANGE; o 409 é auditado', async () => {
      process.env.RATE_LIMIT_CREDENTIALS_CHANGE = '3/900';
      const { service, session, audit } = await withPassword();
      await expect(
        service.updateSelf(session, { email: 'u1@email.com' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'account.credentials.change',
          result: 'FAILURE',
          metadata: { reason: 'email_in_use', email: 'u1@email.com' },
        }),
      );
      for (let i = 0; i < 2; i++) {
        await expect(
          service.updateSelf(session, {
            password: 'NovaSenha#2026',
            current_password: 'Errada#000',
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      const limited = await service
        .updateSelf(session, {
          password: 'NovaSenha#2026',
          current_password: 'SenhaAtual#1',
        })
        .catch((error: unknown) => error);
      expect((limited as { getStatus?: () => number }).getStatus?.()).toBe(429);
      // Edições sem troca de credenciais seguem livres
      await expect(
        service.updateSelf(session, { name: 'Ainda posso' }),
      ).resolves.toBeDefined();
    });

    it('trocas bem-sucedidas não contam como falha', async () => {
      process.env.RATE_LIMIT_CREDENTIALS_CHANGE = '2/900';
      const { service, session } = await withPassword();
      for (let i = 0; i < 5; i++) {
        await expect(
          service.updateSelf(session, { password: `NovaSenha#20${i}x` }),
        ).resolves.toHaveProperty('sessionsRevoked', true);
      }
    });
  });

  describe('foto de perfil', () => {
    it('texto livre (URL externa, arquivo de outra loja ou conta) → 400; ícone pronto, valor atual e foto enviada → ok', async () => {
      const accounts = twoStores();
      accounts[6].avatar = 'https://antiga.example/foto.png';
      const { service, rows } = setup(accounts);
      const me = actor(accounts[6]);
      for (const avatar of [
        'https://atacante.example/p.gif?u=123',
        '/uploads/s1-compressed-1-aaaa.webp',
        '/uploads/u2-compressed-1-aaaa.webp',
        'javascript:alert(1)',
      ]) {
        await expect(service.updateSelf(me, { avatar })).rejects.toThrow(
          new BadRequestException(AVATAR_NOT_ALLOWED_MESSAGE),
        );
      }
      await service.updateSelf(me, {
        avatar: 'https://antiga.example/foto.png',
      });
      await service.updateSelf(me, { avatar: AVATAR_ICON_URLS[0] });
      expect(rows.find((u) => u.id === 20)?.avatar).toBe(AVATAR_ICON_URLS[0]);
      await service.updateSelf(
        me,
        {},
        null,
        '/uploads/u20-compressed-2-bbbb.webp',
      );
      expect(rows.find((u) => u.id === 20)?.avatar).toBe(
        '/uploads/u20-compressed-2-bbbb.webp',
      );

      await expect(
        service.createClient({
          name: 'X',
          email: 'x@email.com',
          password: 'SenhaForte#1',
          avatar: 'https://atacante.example/p.gif',
        }),
      ).rejects.toThrow(new BadRequestException(AVATAR_NOT_ALLOWED_MESSAGE));
    });

    it('ao trocar a foto, o arquivo anterior da PRÓPRIA conta é apagado; arquivos de outro dono ficam', async () => {
      const accounts = twoStores();
      const own = 'u20-compressed-1-aaaa.webp';
      const foreign = 's1-compressed-1-aaaa.webp';
      writeFileSync(join(uploads, own), 'x');
      writeFileSync(join(uploads, foreign), 'x');
      accounts[6].avatar = `/uploads/${own}`;
      const { service } = setup(accounts);
      const me = actor(accounts[6]);
      await service.updateSelf(me, { avatar: AVATAR_ICON_URLS[1] });
      expect(existsSync(join(uploads, own))).toBe(false);

      // Conta antiga apontando para um arquivo de loja: trocar a foto não apaga o arquivo da loja
      accounts[6].avatar = `/uploads/${foreign}`;
      await service.updateSelf(me, { avatar: AVATAR_ICON_URLS[2] });
      expect(existsSync(join(uploads, foreign))).toBe(true);
    });
  });

  it('ADMIN trocando o e-mail de um membro conta no limite TEAM_WRITE da loja; 409 vai para a auditoria', async () => {
    process.env.RATE_LIMIT_TEAM_WRITE = '2/600';
    const accounts = twoStores();
    const { service, audit } = setup(accounts);
    const admin = actor(accounts[0]);
    await expect(
      service.updateTeamMember(2, STORE_A, { email: 'u11@email.com' }, admin),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'store.staff.update',
        result: 'FAILURE',
        metadata: { reason: 'email_in_use', email: 'u11@email.com' },
      }),
    );
    await service.updateTeamMember(
      2,
      STORE_A,
      { email: 'livre@email.com' },
      admin,
    );
    const limited = await service
      .updateTeamMember(2, STORE_A, { email: 'outro@email.com' }, admin)
      .catch((error: unknown) => error);
    expect((limited as { getStatus?: () => number }).getStatus?.()).toBe(429);
    // Sem troca de e-mail não conta
    await expect(
      service.updateTeamMember(2, STORE_A, { name: 'Cozinha' }, admin),
    ).resolves.toBeDefined();
  });
});

describe('UsersService: links de redefinição pendentes vencem quando a conta muda de mãos', () => {
  /** O update que vence os links pendentes de `userId` (used_at nulo, ainda no prazo). */
  function expectLinksExpired(
    resetLinks: { update: jest.Mock },
    userId: number,
  ) {
    const call = (resetLinks.update.mock.calls as Array<[Where, Where]>).find(
      ([where]) => where.user_id === userId,
    );
    expect(call).toBeDefined();
    const [where, partial] = call as [Where, Where];
    expect((where.used_at as FindOperator<unknown>).type).toBe('isNull');
    expect((where.expires_at as FindOperator<unknown>).type).toBe('moreThan');
    expect(partial.expires_at).toBeInstanceOf(Date);
  }

  it('troca do próprio e-mail ou da própria senha vence os links pendentes; editar só o nome não', async () => {
    const accounts = twoStores();
    const me = accounts[6]; // cliente 20
    me.password_hash = await bcrypt.hash('SenhaAtual#1', 4);
    const { service, resetLinks } = setup(accounts);

    await service.updateSelf(actor(me), { name: 'Só o nome' });
    expect(resetLinks.update).not.toHaveBeenCalled();

    await service.updateSelf(actor(me), {
      email: 'novo@email.com',
      current_password: 'SenhaAtual#1',
    });
    expectLinksExpired(resetLinks, 20);

    resetLinks.update.mockClear();
    await service.updateSelf(actor(me), {
      password: 'NovaSenha#2026',
      current_password: 'SenhaAtual#1',
    });
    expectLinksExpired(resetLinks, 20);
  });

  it('ADMIN trocando e-mail ou senha de um membro vence os links pendentes do membro', async () => {
    const accounts = twoStores();
    const { service, resetLinks } = setup(accounts);
    const admin = actor(accounts[0]);

    await service.updateTeamMember(2, STORE_A, { name: 'Cozinha' }, admin);
    expect(resetLinks.update).not.toHaveBeenCalled();

    await service.updateTeamMember(
      2,
      STORE_A,
      { email: 'caixa@loja.com', password: 'NovaSenha#2026' },
      admin,
    );
    expectLinksExpired(resetLinks, 2);
  });

  it('bloqueio, lixeira (própria conta ou pelo ADMIN) e "encerrar sessões" vencem os links pendentes', async () => {
    const accounts = twoStores();
    const { service, resetLinks } = setup(accounts);
    const superadmin = actor(accounts[7]);

    await service.block(13, 'fraude', superadmin);
    expectLinksExpired(resetLinks, 13);

    await service.revokeSessions(12, superadmin);
    expectLinksExpired(resetLinks, 12);

    await service.revokeSessions(20, actor(accounts[6]));
    expectLinksExpired(resetLinks, 20);

    await service.removeTeamMember(2, STORE_A, actor(accounts[0]));
    expectLinksExpired(resetLinks, 2);

    resetLinks.update.mockClear();
    await service.removeSelf(actor(accounts[6]));
    expectLinksExpired(resetLinks, 20);
  });
});

describe('UsersService: verificação de e-mail (modo compat, rotas antigas)', () => {
  it('troca do próprio e-mail pela rota antiga: resposta igual, e-mail não confirmado, REVERT + VERIFY na mesma transação e avisos depois', async () => {
    const accounts = twoStores();
    const me = accounts[6]; // cliente 20, u20@email.com
    me.email_verified_at = new Date('2026-01-02T00:00:00Z');
    const { service, rows, emailTokens, notices, audit, txManager } =
      setup(accounts);

    const result = await service.updateSelf(actor(me), {
      email: 'Novo@Email.com',
    });

    // Contrato antigo: troca imediata e sessão nova
    expect(result.sessionsRevoked).toBe(true);
    expect(result.user.email).toBe('novo@email.com');
    const row = rows.find((u) => u.id === 20);
    expect(row?.email_verified_at).toBeNull();
    // Pedidos de troca e verificação em aberto caem; nascem o "Não fui eu" e a verificação do novo
    expect(emailTokens.revokeOpen).toHaveBeenCalledWith(
      20,
      ['CHANGE', 'VERIFY'],
      txManager,
      expect.any(Date),
    );
    expect(emailTokens.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 20,
        purpose: 'REVERT',
        email: 'u20@email.com',
        previousEmail: 'novo@email.com',
      }),
      txManager,
    );
    expect(emailTokens.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 20,
        purpose: 'VERIFY',
        email: 'novo@email.com',
      }),
      txManager,
    );
    expect(notices.emailChanged).toHaveBeenCalledWith(
      expect.objectContaining({ id: 20 }),
      expect.objectContaining({
        oldEmail: 'u20@email.com',
        newEmail: 'novo@email.com',
        revertToken: expect.stringMatching(/^TOKEN_REVERT_/) as unknown,
      }),
    );
    expect(notices.verification).toHaveBeenCalledWith(
      expect.objectContaining({ id: 20 }),
      'novo@email.com',
      expect.stringMatching(/^TOKEN_VERIFY_/),
    );
    expect(notices.passwordChanged).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'account.credentials.change',
        metadata: { fields: ['email'], revert_link: true },
      }),
    );
  });

  it('troca só da senha pela rota antiga: aviso de senha alterada ao e-mail da conta, sem REVERT', async () => {
    const accounts = twoStores();
    const { service, emailTokens, notices } = setup(accounts);
    await service.updateSelf(actor(accounts[6]), {
      password: 'NovaSenha#2026',
    });
    expect(emailTokens.issue).not.toHaveBeenCalled();
    expect(emailTokens.revokeOpen).toHaveBeenCalledWith(
      20,
      ['CHANGE'],
      expect.anything(),
      expect.any(Date),
    );
    expect(notices.passwordChanged).toHaveBeenCalledWith(
      expect.objectContaining({ id: 20 }),
      'u20@email.com',
      expect.objectContaining({ changedAt: expect.any(Date) as unknown }),
    );
    expect(notices.emailChanged).not.toHaveBeenCalled();
  });

  it('e-mail reservado por outra conta ("Não fui eu" no prazo) conta como em uso: cadastro e troca → 409', async () => {
    const accounts = twoStores();
    const { service, emailTokens } = setup(accounts);
    emailTokens.isReserved.mockResolvedValue(true);

    await expect(
      service.createClient({
        name: 'Nova',
        email: 'reservado@email.com',
        password: 'SenhaForte@123',
      }),
    ).rejects.toThrow(EMAIL_TAKEN);
    await expect(
      service.updateSelf(actor(accounts[6]), { email: 'reservado@email.com' }),
    ).rejects.toThrow(EMAIL_TAKEN);
    // A própria conta é ignorada (pode voltar ao próprio e-mail antigo)
    expect(emailTokens.isReserved).toHaveBeenLastCalledWith(
      'reservado@email.com',
      20,
      expect.anything(),
    );
  });

  it('cadastro público dispara a verificação em segundo plano (sem atrasar a resposta)', async () => {
    const accounts = twoStores();
    const { service, emailTokens, notices } = setup(accounts);
    const user = await service.createClient({
      name: 'Nova',
      email: 'nova@email.com',
      password: 'SenhaForte@123',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(emailTokens.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: user.id,
        purpose: 'VERIFY',
        email: 'nova@email.com',
      }),
    );
    expect(notices.verification).toHaveBeenCalledWith(
      expect.objectContaining({ id: user.id }),
      'nova@email.com',
      expect.stringMatching(/^TOKEN_VERIFY_/),
    );
  });

  it('ADMIN trocando e-mail e senha de um membro: aviso informativo (sem "Não fui eu") e verificação do novo', async () => {
    const accounts = twoStores();
    const { service, rows, emailTokens, notices } = setup(accounts);
    rows.find((u) => u.id === 2)!.email_verified_at = new Date();

    await service.updateTeamMember(
      2,
      STORE_A,
      { email: 'cozinha.nova@loja.com', password: 'NovaSenha#2026' },
      actor(accounts[0]),
    );

    expect(rows.find((u) => u.id === 2)?.email_verified_at).toBeNull();
    expect(emailTokens.issue).toHaveBeenCalledTimes(1);
    expect(emailTokens.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 2,
        purpose: 'VERIFY',
        email: 'cozinha.nova@loja.com',
      }),
    );
    expect(notices.emailChanged).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2 }),
      expect.objectContaining({
        oldEmail: 'u2@email.com',
        newEmail: 'cozinha.nova@loja.com',
        revertToken: null,
        byStoreAdmin: true,
      }),
    );
    expect(notices.passwordChanged).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2 }),
      'u2@email.com',
      expect.objectContaining({ byStoreAdmin: true }),
    );
  });

  it('bloqueio cancela os pedidos de troca e de verificação, mas mantém o "Não fui eu" do dono do endereço antigo', async () => {
    const accounts = twoStores();
    const { service, emailTokens } = setup(accounts);
    await service.block(13, 'fraude', actor(accounts[7]));
    expect(emailTokens.revokeOpen).toHaveBeenCalledWith(13, [
      'CHANGE',
      'VERIFY',
    ]);
  });
});
