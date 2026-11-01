import { StoreAccountStatus } from '../store/entities/store.entity';
import {
  DEFAULT_STORE_DEACTIVATED_WARNING,
  DEFAULT_STORE_SUSPENDED_WARNING,
  planStoreStatusChange,
  STATUS_REASON_REQUIRED_MESSAGE,
  STORE_STATUS_ACTIONS,
  STORE_STATUS_TRANSITIONS,
  storeStatusWarnings,
  type StoreStatusAction,
} from './store-status-rules';

const { ACTIVE, SUSPENDED, INACTIVE } = StoreAccountStatus;
const ALL = [ACTIVE, SUSPENDED, INACTIVE];

describe('store-status-rules', () => {
  it('transições válidas: suspender, reativar, desativar e restaurar', () => {
    const valid: [StoreStatusAction, StoreAccountStatus, StoreAccountStatus][] =
      [
        ['suspend', ACTIVE, SUSPENDED],
        ['reactivate', SUSPENDED, ACTIVE],
        ['deactivate', ACTIVE, INACTIVE],
        ['deactivate', SUSPENDED, INACTIVE],
        ['restore', INACTIVE, ACTIVE],
      ];
    for (const [action, from, to] of valid) {
      const plan = planStoreStatusChange(from, action, 'Motivo informado');
      expect(plan).toMatchObject({ ok: true, action, from, to });
    }
  });

  it('todas as outras combinações são recusadas com uma explicação', () => {
    for (const action of STORE_STATUS_ACTIONS) {
      for (const current of ALL) {
        if (STORE_STATUS_TRANSITIONS[action].from.includes(current)) continue;
        const plan = planStoreStatusChange(current, action, 'Motivo');
        expect(plan.ok).toBe(false);
        if (!plan.ok) expect(plan.message.length).toBeGreaterThan(10);
      }
    }
    expect(planStoreStatusChange(SUSPENDED, 'suspend', 'x')).toEqual({
      ok: false,
      message: 'A loja já está suspensa.',
    });
    expect(planStoreStatusChange(INACTIVE, 'reactivate')).toMatchObject({
      ok: false,
      message: expect.stringContaining('restaurar') as unknown,
    });
    expect(planStoreStatusChange(SUSPENDED, 'restore')).toMatchObject({
      ok: false,
      message: expect.stringContaining('reativar') as unknown,
    });
  });

  it('suspender e desativar exigem motivo; ele vira o status_reason (cortado em 300)', () => {
    for (const action of ['suspend', 'deactivate'] as const) {
      expect(planStoreStatusChange(ACTIVE, action, '   ')).toEqual({
        ok: false,
        message: STATUS_REASON_REQUIRED_MESSAGE,
      });
      expect(planStoreStatusChange(ACTIVE, action, null)).toEqual({
        ok: false,
        message: STATUS_REASON_REQUIRED_MESSAGE,
      });
    }
    const plan = planStoreStatusChange(
      ACTIVE,
      'suspend',
      `  ${'a'.repeat(400)} `,
    );
    expect(plan.ok && plan.statusReason?.length).toBe(300);
  });

  it('reativar e restaurar limpam o motivo (a observação vai só para a auditoria)', () => {
    expect(
      planStoreStatusChange(SUSPENDED, 'reactivate', 'Pagamento acertado'),
    ).toMatchObject({ ok: true, statusReason: null });
    expect(planStoreStatusChange(INACTIVE, 'restore')).toMatchObject({
      ok: true,
      statusReason: null,
    });
  });

  it('ação desconhecida é recusada', () => {
    expect(
      planStoreStatusChange(ACTIVE, 'apagar' as StoreStatusAction, 'x'),
    ).toMatchObject({ ok: false });
  });

  it('avisa (sem bloquear) ao suspender ou desativar a loja padrão', () => {
    expect(storeStatusWarnings('deactivate', { isDefaultStore: true })).toEqual(
      [DEFAULT_STORE_DEACTIVATED_WARNING],
    );
    expect(storeStatusWarnings('suspend', { isDefaultStore: true })).toEqual([
      DEFAULT_STORE_SUSPENDED_WARNING,
    ]);
    expect(DEFAULT_STORE_DEACTIVATED_WARNING).toContain('404');
    for (const action of STORE_STATUS_ACTIONS) {
      expect(storeStatusWarnings(action, { isDefaultStore: false })).toEqual(
        [],
      );
    }
    expect(storeStatusWarnings('restore', { isDefaultStore: true })).toEqual(
      [],
    );
  });

  it('cada ação tem a própria ação de auditoria platform.store.*', () => {
    expect(
      STORE_STATUS_ACTIONS.map(
        (action) => STORE_STATUS_TRANSITIONS[action].auditAction,
      ),
    ).toEqual([
      'platform.store.suspend',
      'platform.store.reactivate',
      'platform.store.deactivate',
      'platform.store.restore',
    ]);
  });
});
