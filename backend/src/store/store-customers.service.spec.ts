import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  DataSource,
  InsertResult,
  QueryFailedError,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import type { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth-user';
import { ENTITIES } from '../database/entities';
import { Order } from '../orders/entities/order.entity';
import {
  CUSTOMER_ALREADY_BLOCKED_MESSAGE,
  CUSTOMER_NOT_BLOCKED_MESSAGE,
  CUSTOMER_NOT_FOUND_MESSAGE,
  StoreCustomersService,
} from './store-customers.service';

/** Só os metadados das entidades, sem conectar: o QueryBuilder monta o SQL de verdade. */
class OfflineDataSource extends DataSource {
  async loadMetadata(): Promise<this> {
    await this.buildMetadatas();
    return this;
  }
}

/**
 * As consultas são montadas pelo QueryBuilder REAL do TypeORM (metadados das entidades, sem conexão):
 * os testes conferem o SQL gerado — principalmente o filtro por loja — e os resultados vêm de dublês.
 */
describe('StoreCustomersService (clientes = pedidos DESTA loja)', () => {
  let service: StoreCustomersService;
  let queries: { sql: string; params: unknown[] }[];
  let results: {
    rawMany?: unknown[];
    rawOne?: unknown;
    many?: unknown[];
    /** Linhas de store_customer_blocks (find/findOne dos bloqueios). */
    blocks?: unknown[];
    exists?: boolean;
  };
  const audit = { record: jest.fn() };

  beforeAll(async () => {
    const dataSource = await new OfflineDataSource({
      type: 'postgres',
      entities: ENTITIES,
      invalidWhereValuesBehavior: { null: 'throw', undefined: 'throw' },
    }).loadMetadata();
    service = new StoreCustomersService(
      dataSource.getRepository(Order),
      audit as unknown as AuditService,
    );
  });

  beforeEach(() => {
    queries = [];
    results = {};
    audit.record.mockReset().mockResolvedValue(undefined);
    const capture = (value: (sql: string) => unknown) =>
      function (this: SelectQueryBuilder<Order>) {
        const [sql, params] = this.getQueryAndParameters();
        queries.push({ sql, params });
        return Promise.resolve(value(sql)) as never;
      };
    const isBlocks = (sql: string) => sql.includes('"store_customer_blocks"');
    jest
      .spyOn(SelectQueryBuilder.prototype, 'getRawMany')
      .mockImplementation(capture(() => results.rawMany ?? []));
    jest
      .spyOn(SelectQueryBuilder.prototype, 'getRawOne')
      .mockImplementation(capture(() => results.rawOne));
    jest
      .spyOn(SelectQueryBuilder.prototype, 'getMany')
      .mockImplementation(
        capture((sql) =>
          isBlocks(sql) ? (results.blocks ?? []) : (results.many ?? []),
        ),
      );
    jest
      .spyOn(SelectQueryBuilder.prototype, 'getOne')
      .mockImplementation(
        capture((sql) =>
          isBlocks(sql) ? (results.blocks?.[0] ?? null) : null,
        ),
      );
    jest
      .spyOn(SelectQueryBuilder.prototype, 'getExists')
      .mockImplementation(capture(() => results.exists ?? false));
  });

  afterEach(() => jest.restoreAllMocks());

  /** Toda consulta filtra pelo id da loja do contexto. */
  const expectScopedTo = (storeId: number) => {
    expect(queries.length).toBeGreaterThan(0);
    for (const { sql, params } of queries) {
      expect(sql).toMatch(/"store_id" = \$\d+/);
      expect(params).toContain(storeId);
    }
  };

  it('lista paginada no banco, só com pedidos da loja e contas ativas', async () => {
    results.rawOne = { total: '12' };
    results.rawMany = [
      {
        id: 3,
        name: 'Maria',
        email: 'maria@email.com',
        phone: null,
        orders_count: '4',
        total_spent: '59.90',
        last_order_at: new Date('2026-10-10T12:00:00Z'),
      },
    ];

    const page = await service.list(7, { page: 2, pageSize: 10 });

    expect(page).toEqual({
      items: [
        {
          id: 3,
          name: 'Maria',
          email: 'maria@email.com',
          phone: null,
          orders_count: 4,
          total_spent: 59.9,
          last_order_at: new Date('2026-10-10T12:00:00Z'),
          blocked: false,
          block: null,
        },
      ],
      total: 12,
      page: 2,
      pageSize: 10,
    });
    expectScopedTo(7);

    const [count, rows] = queries;
    expect(count.sql).toContain('COUNT(DISTINCT "u"."id")');
    // A lixeira (contas excluídas) não entra
    expect(rows.sql).toContain('"u"."deleted_at" IS NULL');
    expect(rows.sql).toContain('GROUP BY "u"."id"');
    expect(rows.sql).toContain('ORDER BY MAX("o"."created_at") DESC');
    expect(rows.sql).toContain('LIMIT 10 OFFSET 10');
    // Total gasto: só pedidos pagos e não cancelados
    expect(rows.sql).toMatch(
      /SUM\("o"\."total_price"\) FILTER \(WHERE "o"\."payment_status" = \$\d+ AND "o"\."status" <> \$\d+\)/,
    );
    expect(rows.params).toEqual(expect.arrayContaining(['PAID', 'CANCELED']));
  });

  it('busca por nome, e-mail ou telefone, com curingas do usuário escapados', async () => {
    results.rawOne = { total: 0 };
    await service.list(7, { search: 'ana_100%' });
    expectScopedTo(7);
    expect(queries[1].sql).toContain('"u"."name" ILIKE $');
    expect(queries[1].sql).toContain('"u"."email" ILIKE $');
    expect(queries[1].params).toContain('%ana\\_100\\%%');

    queries = [];
    await service.list(7, { search: '(21) 99999' });
    expect(queries[1].sql).toContain('regexp_replace');
    expect(queries[1].params).toContain('%2199999%');
  });

  it('pageSize acima de 100 usa 100; padrão é página 1 com 20', async () => {
    results.rawOne = { total: 0 };
    await expect(service.list(7, { pageSize: 500 })).resolves.toMatchObject({
      page: 1,
      pageSize: 100,
    });
    expect(queries[1].sql).toContain('LIMIT 100 OFFSET 0');

    queries = [];
    await expect(service.list(7, {})).resolves.toMatchObject({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    expect(queries[1].sql).toContain('LIMIT 20 OFFSET 0');
  });

  it('detalhe: 404 uniforme se o cliente não comprou nesta loja (os pedidos nem são lidos)', async () => {
    results.rawOne = undefined;
    const error = await service.detail(7, 3).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as Error).message).toBe(CUSTOMER_NOT_FOUND_MESSAGE);
    expect(queries).toHaveLength(1);
    expectScopedTo(7);
    expect(queries[0].params).toContain(3);
  });

  it('detalhe: estatísticas e pedidos DESTA loja no formato público', async () => {
    results.rawOne = {
      id: '3',
      name: 'Maria',
      email: 'maria@email.com',
      phone: '21999990000',
      orders_count: '2',
      total_spent: '30.50',
      first_order_at: '2026-09-01T00:00:00.000Z',
      last_order_at: '2026-10-01T00:00:00.000Z',
    };
    results.many = [
      {
        id: 50,
        store_id: 7,
        status: 'DONE',
        payment_status: 'PAID',
        type: 'TAKEOUT',
        total_price: '30.50',
        delivery_fee: '0',
        payment_id: null,
        payment_method: 'MONEY',
        delivery_address: null,
        address: null,
        user: {
          id: 3,
          name: 'Maria',
          email: 'maria@email.com',
          phone: '21999990000',
          avatar: null,
          password_hash: 'hash-secreto',
        },
        driver: null,
        items: [],
      },
    ];

    const detail = await service.detail(7, 3);

    expect(detail.customer).toEqual({
      id: 3,
      name: 'Maria',
      email: 'maria@email.com',
      phone: '21999990000',
    });
    expect(detail.stats).toEqual({
      orders_count: 2,
      total_spent: 30.5,
      first_order_at: new Date('2026-09-01T00:00:00.000Z'),
      last_order_at: new Date('2026-10-01T00:00:00.000Z'),
    });
    expect(detail.block).toBeNull();
    expect(detail.orders).toHaveLength(1);
    expect(detail.orders[0]).toMatchObject({ id: 50, total_price: 30.5 });
    expect(JSON.stringify(detail)).not.toContain('hash-secreto');

    // Pedidos: loja do contexto + cliente pedido; lixeira incluída no histórico (withDeleted)
    expectScopedTo(7);
    const ordersQuery = queries[1];
    expect(ordersQuery.params).toEqual(expect.arrayContaining([7, 3]));
    expect(ordersQuery.sql).not.toContain('"deleted_at" IS NULL');
  });

  describe('bloqueio do cliente nesta loja', () => {
    const admin = { id: 90, role: 'ADMIN', store_id: 7 } as unknown as AuthUser;
    const actor = { user: admin, request: null };
    const blockRow = {
      store_id: 7,
      user_id: 3,
      reason: 'Pedidos falsos',
      blocked_by_user_id: 90,
      blocked_at: new Date('2026-10-20T10:00:00Z'),
      blocked_by: { id: 90, name: 'Dona Ana', password_hash: 'hash-secreto' },
    };
    let insert: jest.SpyInstance;
    let remove: jest.SpyInstance;

    beforeEach(() => {
      insert = jest
        .spyOn(Repository.prototype, 'insert')
        .mockResolvedValue({} as InsertResult);
      remove = jest
        .spyOn(Repository.prototype, 'delete')
        .mockResolvedValue({ affected: 1, raw: [] });
    });

    it('lista e detalhe mostram o bloqueio (motivo, quando e quem bloqueou; sem dados internos)', async () => {
      results.rawOne = { total: 1 };
      results.rawMany = [
        {
          id: 3,
          name: 'Maria',
          email: 'maria@email.com',
          phone: null,
          orders_count: '1',
          total_spent: '0',
          last_order_at: null,
        },
      ];
      results.blocks = [blockRow];

      const page = await service.list(7, {});
      expect(page.items[0]).toMatchObject({
        id: 3,
        blocked: true,
        block: {
          reason: 'Pedidos falsos',
          blocked_at: blockRow.blocked_at,
          blocked_by: { id: 90, name: 'Dona Ana' },
        },
      });
      expect(JSON.stringify(page)).not.toContain('hash-secreto');
      // Bloqueios lidos só desta loja e só dos clientes da página (inclusive quem bloqueou na lixeira)
      const blocksQuery = queries[2];
      expect(blocksQuery.sql).toContain('"store_customer_blocks"');
      expect(blocksQuery.params).toEqual(expect.arrayContaining([7, 3]));
      expectScopedTo(7);

      queries = [];
      results.rawOne = {
        id: 3,
        name: 'Maria',
        email: 'maria@email.com',
        phone: null,
        orders_count: 1,
        total_spent: 0,
        last_order_at: null,
      };
      results.many = [];
      const detail = await service.detail(7, 3);
      expect(detail.block).toEqual({
        reason: 'Pedidos falsos',
        blocked_at: blockRow.blocked_at,
        blocked_by: { id: 90, name: 'Dona Ana' },
      });
      expectScopedTo(7);
    });

    it('?blocked=true|false filtra pelo bloqueio NESTA loja (contagem e página)', async () => {
      results.rawOne = { total: 0 };
      await service.list(7, { blocked: true });
      for (const query of queries) {
        // O bloqueio é o desta loja: o mesmo parâmetro do filtro dos pedidos
        const store = /"o"\."store_id" = (\$\d+)/.exec(query.sql)?.[1];
        expect(store).toBeDefined();
        expect(query.sql).toContain(
          `AND EXISTS (SELECT 1 FROM "store_customer_blocks" "blk" WHERE "blk"."store_id" = ${store} AND "blk"."user_id" = "u"."id")`,
        );
      }
      queries = [];
      await service.list(7, { blocked: false });
      for (const query of queries) {
        expect(query.sql).toContain(
          'AND NOT EXISTS (SELECT 1 FROM "store_customer_blocks"',
        );
      }
      queries = [];
      await service.list(7, {});
      for (const query of queries) {
        expect(query.sql).not.toContain('store_customer_blocks');
      }
    });

    it('bloquear: só cliente que já pediu nesta loja (404 uniforme, nada gravado nem auditado)', async () => {
      results.exists = false;
      const error = await service
        .block(7, 3, 'Pedidos falsos', actor)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as Error).message).toBe(CUSTOMER_NOT_FOUND_MESSAGE);
      expect(queries[0].params).toEqual(expect.arrayContaining([7, 3]));
      expect(queries[0].sql).toContain('"u"."deleted_at" IS NULL');
      expect(insert).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('bloquear: grava loja + cliente + motivo + quem bloqueou, audita e devolve o bloqueio', async () => {
      results.exists = true;
      results.blocks = [blockRow];
      const request = { ip: '10.0.0.1', headers: {} };
      const view = await service.block(7, 3, 'Pedidos falsos', {
        user: admin,
        request: request as never,
      });

      expect(insert).toHaveBeenCalledWith({
        store_id: 7,
        user_id: 3,
        reason: 'Pedidos falsos',
        blocked_by_user_id: 90,
      });
      expect(audit.record).toHaveBeenCalledWith({
        actor: admin,
        storeId: 7,
        action: 'store.customer.block',
        targetType: 'user',
        targetId: 3,
        metadata: { reason: 'Pedidos falsos' },
        request,
      });
      expect(view).toEqual({
        reason: 'Pedidos falsos',
        blocked_at: blockRow.blocked_at,
        blocked_by: { id: 90, name: 'Dona Ana' },
      });
    });

    it('bloquear de novo → 409 (PK loja + cliente), sem auditoria', async () => {
      results.exists = true;
      insert.mockRejectedValueOnce(
        new QueryFailedError(
          'INSERT INTO "store_customer_blocks"',
          [],
          Object.assign(new Error('duplicate key'), { code: '23505' }),
        ),
      );
      await expect(service.block(7, 3, 'Outra vez', actor)).rejects.toThrow(
        new ConflictException(CUSTOMER_ALREADY_BLOCKED_MESSAGE),
      );
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('desbloquear: apaga só o bloqueio desta loja e audita o bloqueio desfeito', async () => {
      results.blocks = [blockRow];
      await service.unblock(7, 3, actor);
      expect(remove).toHaveBeenCalledWith({ store_id: 7, user_id: 3 });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId: 7,
          action: 'store.customer.unblock',
          targetType: 'user',
          targetId: 3,
          metadata: {
            reason: 'Pedidos falsos',
            blocked_at: blockRow.blocked_at,
            blocked_by_user_id: 90,
          },
        }),
      );
      expectScopedTo(7);
    });

    it('desbloquear quem não está bloqueado (ou de outra loja) → 404, nada apagado', async () => {
      results.blocks = [];
      await expect(service.unblock(7, 3, actor)).rejects.toThrow(
        new NotFoundException(CUSTOMER_NOT_BLOCKED_MESSAGE),
      );
      expect(remove).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
});
