import { BadRequestException } from '@nestjs/common';
import {
  PlatformAuditService,
  TARGET_TYPE_REQUIRED_MESSAGE,
} from './platform-audit.service';
import {
  callsOf,
  fakeQueryBuilder,
  paramsOf,
  sqlOf,
  type FakeQueryBuilder,
} from './testing/fake-query-builder.helper-spec';

const LOG = {
  id: 3,
  created_at: new Date('2026-10-17T12:00:00.000Z'),
  action: 'platform.store.suspend',
  result: 'SUCCESS',
  actor_scope: 'PLATFORM',
  actor_user_id: 1,
  actor_email: 'ops@comestra.com',
  actor: { id: 1, name: 'Ops', email: 'ops@comestra.com' },
  store_id: 7,
  store: { id: 7, slug: 'loja-7', name: 'Loja 7' },
  target_type: 'store',
  target_id: '7',
  ip: '203.0.113.9',
  user_agent: 'jest',
  metadata: { reason: 'Fraude' },
};

function setup(rows: unknown[] = [LOG]) {
  let qb: FakeQueryBuilder = fakeQueryBuilder();
  const logs = {
    createQueryBuilder: jest.fn(() => {
      qb = fakeQueryBuilder({
        getMany: rows,
        // O total: COUNT(*) sem DISTINCT (o PostgreSQL devolve texto)
        getRawOne: { total: String(rows.length) },
      });
      return qb;
    }),
  };
  const service = new PlatformAuditService(logs as never);
  return { service, logs, qb: () => qb };
}

describe('PlatformAuditService', () => {
  it('a loja da rota tem prioridade e os filtros viram condições parametrizadas', async () => {
    const { service, qb } = setup();
    const result = await service.list(
      {
        store_id: 99,
        actor_id: 1,
        action: 'platform.store_x',
        result: 'SUCCESS',
        actor_scope: 'PLATFORM',
        from: '2026-10-01',
        to: '2026-10-17',
        page: 2,
        pageSize: 10,
      },
      { storeId: 7 },
    );
    const params = paramsOf(qb());
    expect(params).toMatchObject({
      storeId: 7,
      actorId: 1,
      // A ação exata ou as do grupo (respeitando os segmentos), com os curingas escapados
      actionExact: 'platform.store_x',
      actionPrefix: 'platform.store\\_x.%',
      result: 'SUCCESS',
      actorScope: 'PLATFORM',
    });
    expect((params.fromInstant as Date).toISOString()).toBe(
      '2026-10-01T03:00:00.000Z',
    );
    expect((params.toInstant as Date).toISOString()).toBe(
      '2026-10-18T03:00:00.000Z',
    );
    // O ator na lixeira continua aparecendo: withDeleted antes dos joins
    const methods = qb().calls.map((call) => call.method);
    expect(methods.indexOf('withDeleted')).toBeLessThan(
      methods.indexOf('leftJoin'),
    );
    expect(callsOf(qb(), 'offset')).toEqual([[10]]);
    expect(callsOf(qb(), 'limit')).toEqual([[10]]);
    // Total: COUNT(*) numa cópia da consulta (sem o COUNT(DISTINCT) com joins do getManyAndCount)
    expect(callsOf(qb(), 'getManyAndCount')).toEqual([]);
    expect(callsOf(qb(), 'clone')).toHaveLength(1);
    expect(callsOf(qb(), 'select')).toContainEqual(['COUNT(*)', 'total']);
    expect(result).toMatchObject({
      total: 1,
      page: 2,
      pageSize: 10,
      items: [
        {
          id: 3,
          action: 'platform.store.suspend',
          actor: { id: 1, name: 'Ops', email: 'ops@comestra.com' },
          store: { id: 7, slug: 'loja-7', name: 'Loja 7' },
          metadata: { reason: 'Fraude' },
        },
      ],
    });
  });

  it('ação: grupo terminado em ponto só traz o grupo; alvo por tipo e id', async () => {
    const { service, qb } = setup();
    await service.list({
      action: 'plan.',
      target_type: 'subscription',
      target_id: '12',
    });
    expect(paramsOf(qb())).toMatchObject({
      actionPrefix: 'plan.%',
      actionExact: null,
      targetType: 'subscription',
      targetId: '12',
    });
    expect(sqlOf(qb())).toContain('a.target_type = :targetType');
    expect(sqlOf(qb())).toContain('a.target_id = :targetId');
  });

  it('target_id sem target_type → 400', async () => {
    const { service } = setup();
    await expect(service.list({ target_id: '12' })).rejects.toThrow(
      new BadRequestException(TARGET_TYPE_REQUIRED_MESSAGE),
    );
  });

  it('período inválido → 400', async () => {
    const { service } = setup();
    await expect(
      service.list({ from: '2026-10-18', to: '2026-10-01' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('eventos de autenticação: só ações auth.*, por conta (autora ou alvo) e e-mail', async () => {
    const { service, qb } = setup();
    await service.authEvents({
      user_id: 12,
      email: 'Maria@Email.com',
      result: 'FAILURE',
    });
    expect(sqlOf(qb())).toContain("a.action LIKE 'auth.%'");
    expect(paramsOf(qb())).toMatchObject({
      userId: 12,
      userKey: '12',
      email: 'maria@email.com',
      result: 'FAILURE',
    });
  });

  it('eventos recentes de uma conta: autora, alvo ou e-mail digitado', async () => {
    const { service, qb } = setup();
    const events = await service.recentAuthEvents({
      id: 12,
      email: 'Maria@Email.com',
    });
    expect(events).toHaveLength(1);
    expect(paramsOf(qb())).toMatchObject({
      userId: 12,
      userKey: '12',
      email: 'maria@email.com',
    });
    expect(callsOf(qb(), 'limit')).toEqual([[20]]);
  });
});
