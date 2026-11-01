import { ConflictException, ForbiddenException, Logger } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { storeStorageGate } from '../common/uploads/storage-quota';
import { storeStorageUsage } from '../common/uploads/storage-usage';
import {
  ADVISORY_LOCK_BUSY_MESSAGE,
  ADVISORY_LOCK_WAIT_MS,
} from './advisory-lock';
import { PlanLimitsService, startOfMonthInZone } from './plan-limits.service';

type RepoMock = { findOne: jest.Mock; count: jest.Mock };
const repo = (): RepoMock => ({ findOne: jest.fn(), count: jest.fn() });

function setup(plan: Record<string, unknown> | null, usage = [0, 0, 0]) {
  const subscriptions = repo();
  const users = repo();
  const products = repo();
  const orders = repo();
  const stores = repo();
  subscriptions.findOne.mockResolvedValue(plan ? { plan } : null);
  stores.findOne.mockResolvedValue({ id: 7, time_zone: 'America/Sao_Paulo' });
  users.count.mockResolvedValue(usage[0]);
  products.count.mockResolvedValue(usage[1]);
  orders.count.mockResolvedValue(usage[2]);
  // Transação: repositórios próprios (contagens feitas na conexão da transação, depois da trava)
  const tx = {
    subscriptions: repo(),
    users: repo(),
    products: repo(),
    orders: repo(),
    stores: repo(),
  };
  tx.subscriptions.findOne.mockResolvedValue(plan ? { plan } : null);
  tx.stores.findOne.mockResolvedValue({
    id: 7,
    time_zone: 'America/Sao_Paulo',
  });
  tx.users.count.mockResolvedValue(usage[0]);
  tx.products.count.mockResolvedValue(usage[1]);
  tx.orders.count.mockResolvedValue(usage[2]);
  const byName: Record<string, RepoMock> = {
    Subscription: tx.subscriptions,
    User: tx.users,
    Product: tx.products,
    Order: tx.orders,
    Store: tx.stores,
  };
  const calls: string[] = [];
  const manager = {
    query: jest.fn((sql: string) => {
      calls.push(sql);
      return Promise.resolve([]);
    }),
    getRepository: jest.fn((entity: { name: string }) => byName[entity.name]),
  };
  const transaction = jest.fn((work: (m: typeof manager) => unknown) =>
    work(manager),
  );
  Object.assign(stores, { manager: { transaction } });
  const service = new PlanLimitsService(
    subscriptions as never,
    users as never,
    products as never,
    orders as never,
    stores as never,
  );
  return {
    service,
    subscriptions,
    users,
    products,
    orders,
    tx,
    manager,
    transaction,
    calls,
  };
}

const PLAN = {
  name: 'Essencial',
  max_staff_users: 3,
  max_products: 10,
  max_monthly_orders: null,
  features: { online_payments: true, advanced_reports: false },
};

describe('PlanLimitsService', () => {
  it('libera enquanto o uso + o novo item cabe no limite', async () => {
    const { service } = setup(PLAN, [2, 9, 500]);
    await expect(
      service.assertWithinLimit(7, 'staff_users'),
    ).resolves.toBeUndefined();
    await expect(
      service.assertWithinLimit(7, 'products'),
    ).resolves.toBeUndefined();
    // limite nulo = ilimitado
    await expect(
      service.assertWithinLimit(7, 'monthly_orders'),
    ).resolves.toBeUndefined();
  });

  it('recusa (403) quando passaria do limite, citando o plano', async () => {
    const { service } = setup(PLAN, [3, 10, 0]);
    await expect(service.assertWithinLimit(7, 'staff_users')).rejects.toThrow(
      /Limite do plano Essencial atingido: 3 usuários/,
    );
    await expect(service.assertWithinLimit(7, 'products')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('as contagens são sempre filtradas pela loja', async () => {
    const { service, users, products, orders } = setup(PLAN, [1, 1, 1]);
    await service.usage(7);
    for (const counter of [users, products, orders]) {
      expect(counter.count).toHaveBeenCalledWith({
        where: expect.objectContaining({ store_id: 7 }) as unknown,
      });
    }
  });

  it('withinLimit: trava por loja + limite, conta NA transação e só então grava (rajada paralela não passa do limite)', async () => {
    const ok = setup(PLAN, [0, 9, 0]);
    const work = jest.fn().mockResolvedValue('gravado');
    await expect(ok.service.withinLimit(7, 'products', work)).resolves.toBe(
      'gravado',
    );
    expect(ok.transaction).toHaveBeenCalledTimes(1);
    expect(ok.manager.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      ['plan-limit:7:products'],
    );
    expect(ok.tx.products.count).toHaveBeenCalled();
    expect(ok.products.count).not.toHaveBeenCalled();
    expect(work).toHaveBeenCalledWith(ok.manager);
    // A trava vem antes da contagem
    expect(ok.manager.query.mock.invocationCallOrder[0]).toBeLessThan(
      ok.tx.products.count.mock.invocationCallOrder[0],
    );

    const full = setup(PLAN, [0, 10, 0]);
    const never = jest.fn();
    await expect(
      full.service.withinLimit(7, 'products', never),
    ).rejects.toThrow(ForbiddenException);
    expect(never).not.toHaveBeenCalled();

    // Dentro de uma transação de quem chama: usa a mesma (sem abrir outra)
    const inner = setup(PLAN, [3, 0, 0]);
    await expect(
      inner.service.lockAndAssert(inner.manager as never, 7, 'staff_users'),
    ).rejects.toThrow(/Limite do plano Essencial atingido: 3 usuários/);
    expect(inner.transaction).not.toHaveBeenCalled();
    expect(inner.manager.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      ['plan-limit:7:staff_users'],
    );
  });

  it('lockAndAssert: espera pela trava com teto (lock_timeout só na espera); esgotado → 409 sem contar', async () => {
    const ok = setup(PLAN, [0, 9, 0]);
    await ok.service.lockAndAssert(ok.manager as never, 7, 'products');
    expect(ok.calls).toEqual([
      expect.stringContaining("set_config('lock_timeout'"),
      expect.stringContaining('pg_advisory_xact_lock'),
      'SET LOCAL lock_timeout TO DEFAULT',
    ]);
    expect(ok.manager.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("set_config('lock_timeout'"),
      [`${ADVISORY_LOCK_WAIT_MS}ms`],
    );

    // Fila parada na trava (outra transação da loja demorando): a espera acaba e vira 409, sem 500
    const busy = setup(PLAN, [0, 9, 0]);
    busy.manager.query.mockImplementation((sql: string) => {
      if (!sql.includes('pg_advisory_xact_lock')) return Promise.resolve([]);
      return Promise.reject(
        new QueryFailedError(
          sql,
          [],
          Object.assign(new Error('lock timeout'), {
            code: '55P03',
          }),
        ),
      );
    });
    await expect(
      busy.service.lockAndAssert(busy.manager as never, 7, 'products'),
    ).rejects.toThrow(new ConflictException(ADVISORY_LOCK_BUSY_MESSAGE));
    expect(busy.tx.products.count).not.toHaveBeenCalled();

    // Outros erros do banco seguem como estão
    const down = setup(PLAN, [0, 9, 0]);
    down.manager.query.mockImplementation((sql: string) =>
      sql.includes('pg_advisory_xact_lock')
        ? Promise.reject(new Error('conexão perdida'))
        : Promise.resolve([]),
    );
    await expect(
      down.service.lockAndAssert(down.manager as never, 7, 'products'),
    ).rejects.toThrow('conexão perdida');
  });

  it('withinLimit em plano ilimitado: grava sem contar', async () => {
    const { service, tx } = setup({ ...PLAN, max_products: null }, [0, 0, 0]);
    const work = jest.fn().mockResolvedValue(1);
    await service.withinLimit(7, 'products', work);
    expect(work).toHaveBeenCalled();
    expect(tx.products.count).not.toHaveBeenCalled();
  });

  it('recursos do plano', async () => {
    const { service } = setup(PLAN);
    await expect(service.hasFeature(7, 'online_payments')).resolves.toBe(true);
    await expect(service.hasFeature(7, 'advanced_reports')).resolves.toBe(
      false,
    );
    await expect(service.assertFeature(7, 'advanced_reports')).rejects.toThrow(
      /não inclui relatórios/,
    );
  });

  it('loja sem assinatura vigente: falha fechada', async () => {
    const { service } = setup(null);
    await expect(service.assertWithinLimit(7, 'products')).rejects.toThrow(
      /não tem uma assinatura ativa/,
    );
    await expect(service.hasFeature(7, 'online_payments')).resolves.toBe(false);
  });
});

describe('PlanLimitsService — armazenamento (max_storage_mb)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('limite do plano vigente para a cota das imagens; ilimitado ou sem plano = sem limite', async () => {
    await expect(
      setup({ ...PLAN, max_storage_mb: 500 }).service.storageLimit(7),
    ).resolves.toEqual({ planName: 'Essencial', limitMb: 500 });
    await expect(
      setup({ ...PLAN, max_storage_mb: null }).service.storageLimit(7),
    ).resolves.toBeNull();
    // Loja sem assinatura vigente: a situação da loja já bloqueia o painel; a cota não recusa por isso
    await expect(setup(null).service.storageLimit(7)).resolves.toBeNull();
  });

  it('uso medido na pasta (com cache); pasta ilegível = null, com aviso no log', async () => {
    const usage = {
      bytes: 2048,
      files: 2,
      measuredAt: new Date('2026-10-31T12:00:00.000Z'),
    };
    const measured = jest
      .spyOn(storeStorageUsage, 'usage')
      .mockResolvedValueOnce(usage);
    const { service } = setup(PLAN);
    await expect(service.storageUsage(7)).resolves.toEqual(usage);
    expect(measured).toHaveBeenCalledWith(7);

    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    measured.mockRejectedValueOnce(
      Object.assign(new Error('/srv/segredo'), { code: 'EACCES' }),
    );
    await expect(service.storageUsage(7)).resolves.toBeNull();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('EACCES');
    expect(logged).not.toContain('/srv/segredo');
  });

  it('na subida da API passa a informar o limite à cota das imagens; no desligamento, deixa de informar', async () => {
    const { service, subscriptions } = setup({ ...PLAN, max_storage_mb: 1 });
    jest.spyOn(storeStorageUsage, 'usage').mockResolvedValue({
      bytes: 1024 * 1024,
      files: 1,
      measuredAt: new Date(),
    });

    service.onModuleInit();
    try {
      await expect(storeStorageGate.precheck(7)).rejects.toThrow(
        /Limite de armazenamento do plano Essencial atingido: 1 de 1 MB em uso/,
      );
    } finally {
      service.onModuleDestroy();
    }
    subscriptions.findOne.mockClear();
    await expect(storeStorageGate.precheck(7)).resolves.toBeNull();
    expect(subscriptions.findOne).not.toHaveBeenCalled();
  });
});

describe('startOfMonthInZone', () => {
  it('meia-noite do dia 1 no fuso da loja', () => {
    // 11/10/2026 12:00 UTC → 1º/10 00:00 em São Paulo (UTC-3) = 03:00 UTC
    expect(
      startOfMonthInZone(
        new Date('2026-10-11T12:00:00Z'),
        'America/Sao_Paulo',
      ).toISOString(),
    ).toBe('2026-10-01T03:00:00.000Z');
    // Virada do mês: 01/11 01:00 UTC ainda é outubro em São Paulo
    expect(
      startOfMonthInZone(
        new Date('2026-11-01T01:00:00Z'),
        'America/Sao_Paulo',
      ).toISOString(),
    ).toBe('2026-10-01T03:00:00.000Z');
    expect(
      startOfMonthInZone(new Date('2026-10-11T12:00:00Z'), 'UTC').toISOString(),
    ).toBe('2026-10-01T00:00:00.000Z');
  });

  it('reaproveita os formatadores do fuso (sem criar um Intl.DateTimeFormat por chamada)', () => {
    startOfMonthInZone(new Date('2026-10-11T12:00:00Z'), 'America/Manaus');
    const spy = jest.spyOn(Intl, 'DateTimeFormat');
    try {
      for (let i = 0; i < 20; i += 1) {
        startOfMonthInZone(
          new Date(Date.UTC(2026, 9, 11, i)),
          'America/Manaus',
        );
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    // Manaus (UTC-4): 1º/10 00:00 = 04:00 UTC
    expect(
      startOfMonthInZone(
        new Date('2026-10-11T12:00:00Z'),
        'America/Manaus',
      ).toISOString(),
    ).toBe('2026-10-01T04:00:00.000Z');
  });

  it('fuso inválido cai em America/Sao_Paulo', () => {
    expect(
      startOfMonthInZone(
        new Date('2026-10-11T12:00:00Z'),
        'Fuso/Invalido',
      ).toISOString(),
    ).toBe('2026-10-01T03:00:00.000Z');
  });
});
