import * as bcrypt from 'bcrypt';
import { AuditLog } from '../../audit/entities/audit-log.entity';
import { PlatformRole, User, UserRole } from '../../users/entities/user.entity';
import { runSuperadminCommand, validPassword } from './superadmin-command';

type Row = Partial<User> & { id: number };

/** Banco falso: uma conta (ou nenhuma), atualizações, auditoria e SQL bruto registrados. */
function fakeDb(account: Row | null, orders = 0) {
  const updates: [number, Record<string, unknown>][] = [];
  const audits: Record<string, unknown>[] = [];
  const queries: [string, unknown[] | undefined][] = [];
  const saved: Partial<User>[] = [];
  const userRepo = {
    findOne: jest.fn(() => Promise.resolve(account)),
    update: jest.fn((id: number, changes: Record<string, unknown>) => {
      updates.push([id, changes]);
      return Promise.resolve({ affected: 1 });
    }),
    create: jest.fn((data: Partial<User>) => data),
    save: jest.fn((data: Partial<User>) => {
      saved.push(data);
      return Promise.resolve({ ...data, id: 77 });
    }),
  };
  const auditRepo = {
    insert: jest.fn((row: Record<string, unknown>) => {
      audits.push(row);
      return Promise.resolve();
    }),
  };
  const getRepository = (entity: unknown) =>
    entity === AuditLog ? auditRepo : userRepo;
  const query = jest.fn((sql: string, params?: unknown[]) => {
    queries.push([sql, params]);
    if (sql.includes('FROM "orders"')) return Promise.resolve([{ orders }]);
    return Promise.resolve([]);
  });
  const manager = { getRepository, query };
  const db = {
    getRepository,
    query,
    transaction: jest.fn((fn: (m: typeof manager) => Promise<unknown>) =>
      fn(manager),
    ),
  };
  return { db: db as never, updates, audits, queries, saved, userRepo };
}

function output() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    out: {
      log: (message: string) => lines.push(message),
      error: (message: string) => errors.push(message),
    },
    lines,
    errors,
  };
}

const PLANTED: Row = {
  id: 12,
  email: 'ops@comestra.com.br',
  name: 'Atacante\u001b[2J',
  role: UserRole.CLIENT,
  store_id: null,
  platform_role: null,
  deleted_at: undefined,
  blocked_at: null,
  created_at: new Date('2026-10-20T10:00:00Z'),
  last_login_at: new Date('2026-10-21T10:00:00Z'),
};

describe('npm run platform:superadmin (bootstrap do papel global)', () => {
  it('conta de cliente pré-existente sem --promote-existing: recusa, mostra os dados e não muda nada', async () => {
    const { db, updates, audits } = fakeDb({ ...PLANTED }, 3);
    const { out, errors } = output();

    await expect(
      runSuperadminCommand(db, { email: 'OPS@comestra.com.br' }, out),
    ).resolves.toBe(1);

    expect(updates).toEqual([]);
    expect(audits).toEqual([]);
    const text = errors.join('\n');
    expect(text).toContain('Conta #12');
    expect(text).toContain('criada em: 2026-10-20T10:00:00.000Z');
    expect(text).toContain('último acesso: 2026-10-21T10:00:00.000Z');
    expect(text).toContain('pedidos: 3');
    expect(text).toContain('--promote-existing');
    // Nome escolhido no cadastro público não injeta sequências de controle no terminal
    expect(text).not.toContain('\u001b');
  });

  it('--promote-existing: concede o papel com SENHA NOVA, encerra sessões e invalida links de redefinição', async () => {
    const { db, updates, audits, queries } = fakeDb({ ...PLANTED });
    const { out, lines } = output();

    await expect(
      runSuperadminCommand(
        db,
        { email: 'ops@comestra.com.br', promoteExisting: true },
        out,
      ),
    ).resolves.toBe(0);

    expect(updates).toHaveLength(1);
    const [id, changes] = updates[0];
    expect(id).toBe(12);
    expect(changes.platform_role).toBe(PlatformRole.SUPER_ADMIN);
    expect(typeof changes.token_version).toBe('function');
    // A senha plantada deixa de valer: a nova é a exibida uma vez
    const shown = /Senha inicial.*: (\S+)$/m.exec(lines.join('\n'))?.[1];
    expect(shown).toBeDefined();
    expect(validPassword(shown!)).toBe(true);
    expect(await bcrypt.compare(shown!, changes.password_hash as string)).toBe(
      true,
    );
    expect(
      await bcrypt.compare('AtkPass1!', changes.password_hash as string),
    ).toBe(false);
    expect(
      queries.some(
        ([sql, params]) =>
          sql.includes('UPDATE "password_reset_tokens"') && params?.[0] === 12,
      ),
    ).toBe(true);
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'platform.superadmin.grant',
        target_id: '12',
        metadata: expect.objectContaining({
          created: false,
          credential_reset: true,
        }) as unknown,
      }),
    ]);
  });

  it('SUPERADMIN_PASSWORD definida: usada na promoção (não exibida); fraca → recusada', async () => {
    const strong = fakeDb({ ...PLANTED });
    const printed = output();
    await runSuperadminCommand(
      strong.db,
      {
        email: PLANTED.email,
        promoteExisting: true,
        password: 'OutraSenha#Forte2026',
      },
      printed.out,
    );
    expect(
      await bcrypt.compare(
        'OutraSenha#Forte2026',
        strong.updates[0][1].password_hash as string,
      ),
    ).toBe(true);
    expect(printed.lines.join('\n')).not.toContain('OutraSenha#Forte2026');

    const weak = fakeDb({ ...PLANTED });
    const refused = output();
    await expect(
      runSuperadminCommand(
        weak.db,
        { email: PLANTED.email, promoteExisting: true, password: 'fraca' },
        refused.out,
      ),
    ).resolves.toBe(1);
    expect(weak.updates).toEqual([]);
  });

  it('conta da equipe, na lixeira ou bloqueada: nunca vira superadmin', async () => {
    for (const account of [
      { ...PLANTED, role: UserRole.ADMIN, store_id: 4 },
      { ...PLANTED, deleted_at: new Date() },
      { ...PLANTED, blocked_at: new Date() },
    ]) {
      const { db, updates } = fakeDb(account);
      const { out } = output();
      await expect(
        runSuperadminCommand(
          db,
          { email: PLANTED.email, promoteExisting: true },
          out,
        ),
      ).resolves.toBe(1);
      expect(updates).toEqual([]);
    }
  });

  it('superadmin existente: nada muda; --reset-password troca a senha e encerra as sessões', async () => {
    const admin = { ...PLANTED, platform_role: PlatformRole.SUPER_ADMIN };
    const idle = fakeDb(admin);
    await expect(
      runSuperadminCommand(idle.db, { email: PLANTED.email }, output().out),
    ).resolves.toBe(0);
    expect(idle.updates).toEqual([]);

    const reset = fakeDb(admin);
    await expect(
      runSuperadminCommand(
        reset.db,
        { email: PLANTED.email, resetPassword: true },
        output().out,
      ),
    ).resolves.toBe(0);
    expect(reset.updates[0][1]).toEqual(
      expect.objectContaining({
        password_hash: expect.any(String) as unknown,
        token_version: expect.any(Function) as unknown,
      }),
    );
    expect(reset.updates[0][1]).not.toHaveProperty('platform_role');
    expect(reset.audits[0]).toMatchObject({
      action: 'platform.superadmin.reset_password',
    });
  });

  it('conta nova: criada como cliente sem loja com papel global; --revoke encerra as sessões', async () => {
    const fresh = fakeDb(null);
    const { out, lines } = output();
    await expect(
      runSuperadminCommand(fresh.db, { email: 'novo@comestra.com.br' }, out),
    ).resolves.toBe(0);
    expect(fresh.saved[0]).toMatchObject({
      email: 'novo@comestra.com.br',
      role: UserRole.CLIENT,
      store_id: null,
      platform_role: PlatformRole.SUPER_ADMIN,
    });
    expect(lines.join('\n')).toContain('Senha inicial');

    const revoked = fakeDb({
      ...PLANTED,
      platform_role: PlatformRole.SUPER_ADMIN,
    });
    await expect(
      runSuperadminCommand(
        revoked.db,
        { email: PLANTED.email, revoke: true },
        output().out,
      ),
    ).resolves.toBe(0);
    expect(revoked.updates[0][1]).toMatchObject({ platform_role: null });

    const invalid = output();
    await expect(
      runSuperadminCommand(
        fakeDb(null).db,
        { email: 'sem-arroba' },
        invalid.out,
      ),
    ).resolves.toBe(1);
    expect(invalid.errors[0]).toContain('--email=');
  });
});
