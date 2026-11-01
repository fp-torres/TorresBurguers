import type { QueryRunner } from 'typeorm';
import { MultiTenantFoundation1791765597480 } from './1791765597480-MultiTenantFoundation';
import { PlatformIntegrity1792800000000 } from './1792800000000-PlatformIntegrity';

type Counts = Record<string, number>;

const NO_LOSSES: Counts = {
  audit_logs: 0,
  invoices: 0,
  events: 0,
  support_sessions: 0,
  invitations: 0,
  reset_tokens: 0,
  blocked: 0,
  revoked: 0,
};

/** QueryRunner falso: responde às consultas das travas e registra o resto (DDL). */
function fakeRunner(options: {
  stores?: number;
  losses?: Partial<Counts>;
  offendingUsers?: unknown[];
}) {
  const statements: string[] = [];
  const runner = {
    query: jest.fn((sql: string) => {
      statements.push(sql);
      if (sql.includes('AS "stores"'))
        return Promise.resolve([{ stores: options.stores ?? 1 }]);
      if (sql.includes('AS "audit_logs"'))
        return Promise.resolve([{ ...NO_LOSSES, ...(options.losses ?? {}) }]);
      if (sql.includes('"platform_role" IS NOT NULL AND NOT'))
        return Promise.resolve(options.offendingUsers ?? []);
      return Promise.resolve([]);
    }),
    hasTable: jest.fn(() => Promise.resolve(false)),
    hasColumn: jest.fn(() => Promise.resolve(false)),
  };
  return { runner: runner as unknown as QueryRunner, statements };
}

const destructive = (statements: string[]) =>
  statements.filter((sql) => /\bDROP\b/.test(sql));

describe('MultiTenantFoundation.down(): reversão destrutiva só com autorização explícita', () => {
  const saved = process.env.DB_ALLOW_DESTRUCTIVE_REVERT;
  afterEach(() => {
    if (saved === undefined) delete process.env.DB_ALLOW_DESTRUCTIVE_REVERT;
    else process.env.DB_ALLOW_DESTRUCTIVE_REVERT = saved;
  });

  it('com auditoria, cobrança, suporte ou contas bloqueadas: recusa e não apaga nada', async () => {
    delete process.env.DB_ALLOW_DESTRUCTIVE_REVERT;
    const { runner, statements } = fakeRunner({
      losses: { audit_logs: 12, invoices: 3, support_sessions: 1, blocked: 2 },
    });
    await expect(
      new MultiTenantFoundation1791765597480().down(runner),
    ).rejects.toThrow(
      /Reversão recusada: ela apagaria 12 registro\(s\) de auditoria; 3 fatura\(s\).*DB_ALLOW_DESTRUCTIVE_REVERT=true/,
    );
    expect(destructive(statements)).toEqual([]);
  });

  it('com DB_ALLOW_DESTRUCTIVE_REVERT=true a reversão segue', async () => {
    process.env.DB_ALLOW_DESTRUCTIVE_REVERT = 'true';
    const { runner, statements } = fakeRunner({ losses: { audit_logs: 5 } });
    await new MultiTenantFoundation1791765597480().down(runner);
    expect(destructive(statements)).toEqual(
      expect.arrayContaining([
        'DROP TABLE "audit_logs"',
        'DROP TABLE "subscription_invoices"',
      ]),
    );
  });

  it('banco sem nada a perder reverte sem a variável; mais de uma loja continua recusado', async () => {
    delete process.env.DB_ALLOW_DESTRUCTIVE_REVERT;
    const clean = fakeRunner({});
    await new MultiTenantFoundation1791765597480().down(clean.runner);
    expect(destructive(clean.statements).length).toBeGreaterThan(0);

    process.env.DB_ALLOW_DESTRUCTIVE_REVERT = 'true';
    const many = fakeRunner({ stores: 2 });
    await expect(
      new MultiTenantFoundation1791765597480().down(many.runner),
    ).rejects.toThrow(/existem 2 lojas/);
    expect(destructive(many.statements)).toEqual([]);
  });
});

describe('PlatformIntegrity.up(): dados existentes', () => {
  it('conta com papel global na equipe de uma loja: migration recusada com a lista (nada é criado depois)', async () => {
    const { runner, statements } = fakeRunner({
      offendingUsers: [
        { id: 9, email: 'ops@x.com', role: 'ADMIN', store_id: 3 },
      ],
    });
    await expect(
      new PlatformIntegrity1792800000000().up(runner),
    ).rejects.toThrow(/#9 ops@x\.com \(ADMIN, loja 3\).*--revoke/);
    expect(
      statements.some((sql) => sql.includes('CHK_users_platform_role')),
    ).toBe(false);
  });

  it('dados válidos: CHECK criado NOT VALID e validado; triggers de mesma loja e imutabilidade', async () => {
    const { runner, statements } = fakeRunner({});
    await new PlatformIntegrity1792800000000().up(runner);
    const joined = statements.join('\n');
    expect(joined).toContain(
      'ADD CONSTRAINT "CHK_users_platform_role" CHECK ("platform_role" IS NULL OR ("role" = \'CLIENT\' AND "store_id" IS NULL)) NOT VALID',
    );
    expect(joined).toContain('VALIDATE CONSTRAINT "CHK_users_platform_role"');
    for (const trigger of [
      'TRG_orders_payment_same_store',
      'TRG_subscription_events_subscription_same_store',
      'TRG_subscription_invoices_subscription_same_store',
      'TRG_stores_owner_same_store',
      'TRG_invitations_accepted_user_same_store',
      'TRG_subscriptions_store_immutable',
      'TRG_support_sessions_store_immutable',
      'TRG_users_store_no_transfer',
    ]) {
      expect(joined).toContain(`CREATE TRIGGER "${trigger}"`);
    }
  });
});
