import { SubscriptionStatus } from '../billing/entities/subscription.entity';
import { StoreAccountStatus } from '../store/entities/store.entity';
import {
  SUBSCRIPTION_SUSPENDED_MESSAGE,
  SUBSCRIPTION_UNPAID_MESSAGE,
  capabilityDeniedMessage,
  hasCapability,
  storeAccessState,
} from './store-access';

const NOW = new Date('2026-10-11T12:00:00Z');
const active = { account_status: StoreAccountStatus.ACTIVE };

describe('storeAccessState', () => {
  it('loja ativa com assinatura ativa ou em teste opera normalmente', () => {
    for (const status of [
      SubscriptionStatus.ACTIVE,
      SubscriptionStatus.TRIALING,
    ]) {
      const access = storeAccessState(active, { status }, NOW);
      expect(access).toMatchObject({
        availability: 'OPERATIONAL',
        canSell: true,
        canManage: true,
        canOperate: true,
        canRead: true,
        publicVisible: true,
        message: null,
      });
    }
  });

  it('loja desativada: nada liberado e fora da vitrine', () => {
    const access = storeAccessState(
      { account_status: StoreAccountStatus.INACTIVE },
      { status: SubscriptionStatus.ACTIVE },
      NOW,
    );
    expect(access.availability).toBe('INACTIVE');
    expect(access.publicVisible).toBe(false);
    for (const capability of ['read', 'operate', 'manage', 'billing'] as const)
      expect(hasCapability(access, capability)).toBe(false);
  });

  it('loja suspensa: não vende nem altera, mas consulta, conclui pedidos e regulariza a cobrança', () => {
    const access = storeAccessState(
      { account_status: StoreAccountStatus.SUSPENDED, status_reason: 'Fraude' },
      { status: SubscriptionStatus.ACTIVE },
      NOW,
    );
    expect(access).toMatchObject({
      availability: 'SUSPENDED',
      canSell: false,
      canManage: false,
      canOperate: true,
      canRead: true,
      canManageBilling: true,
      publicVisible: true,
    });
    expect(access.message).toContain('Fraude');
    expect(capabilityDeniedMessage(access, 'manage')).toContain('bloqueadas');
  });

  it('sem assinatura: falha fechada (não vende nem altera)', () => {
    const access = storeAccessState(active, null, NOW);
    expect(access.availability).toBe('NO_SUBSCRIPTION');
    expect(access.canSell).toBe(false);
    expect(access.canManage).toBe(false);
  });

  it('inadimplente dentro da tolerância continua vendendo, com aviso', () => {
    const access = storeAccessState(
      active,
      {
        status: SubscriptionStatus.PAST_DUE,
        grace_period_ends_at: new Date('2026-10-15T00:00:00Z'),
      },
      NOW,
    );
    expect(access.availability).toBe('PAST_DUE');
    expect(access.canSell).toBe(true);
    expect(access.message).toMatch(/tolerância/);
  });

  it('inadimplente com a tolerância vencida já conta como suspensa, mesmo antes da rotina rodar', () => {
    const access = storeAccessState(
      active,
      {
        status: SubscriptionStatus.PAST_DUE,
        grace_period_ends_at: new Date('2026-10-10T00:00:00Z'),
      },
      NOW,
    );
    expect(access.availability).toBe('SUBSCRIPTION_SUSPENDED');
    expect(access.canSell).toBe(false);
    expect(access.message).toBe(SUBSCRIPTION_UNPAID_MESSAGE);
  });

  it('assinatura suspensa: "falta de pagamento" só quando a tolerância de uma cobrança acabou; sem causa conhecida (suspensão manual), mensagem neutra', () => {
    const suspended = (grace: Date | null) =>
      storeAccessState(
        active,
        {
          status: SubscriptionStatus.SUSPENDED,
          grace_period_ends_at: grace,
        },
        NOW,
      );
    // Rotina: a tolerância venceu e a data fica gravada
    expect(suspended(new Date('2026-10-10T00:00:00Z')).message).toBe(
      SUBSCRIPTION_UNPAID_MESSAGE,
    );
    // Superadmin suspendeu uma assinatura em dia (ou ainda na tolerância): não afirma inadimplência
    for (const grace of [null, new Date('2026-10-15T00:00:00Z')]) {
      const access = suspended(grace);
      expect(access).toMatchObject({
        availability: 'SUBSCRIPTION_SUSPENDED',
        canSell: false,
        message: SUBSCRIPTION_SUSPENDED_MESSAGE,
      });
      expect(access.message).not.toMatch(/pagamento/);
    }
  });

  it('assinatura suspensa: a causa gravada (suspended_by) decide a mensagem, sem inferir pelas datas', () => {
    const expiredGrace = new Date('2026-10-10T00:00:00Z');
    const futureGrace = new Date('2026-10-15T00:00:00Z');
    const suspendedBy = (
      suspended_by: 'PLATFORM' | 'BILLING',
      grace: Date | null,
    ) =>
      storeAccessState(
        active,
        {
          status: SubscriptionStatus.SUSPENDED,
          grace_period_ends_at: grace,
          suspended_by,
        },
        NOW,
      );
    // Superadmin suspendeu uma assinatura inadimplente com a tolerância já vencida: não é "falta de
    // pagamento" (pagar não reativa), a mensagem manda falar com o suporte
    for (const grace of [expiredGrace, futureGrace, null]) {
      const access = suspendedBy('PLATFORM', grace);
      expect(access).toMatchObject({
        availability: 'SUBSCRIPTION_SUSPENDED',
        canSell: false,
        canManageBilling: true,
        message: SUBSCRIPTION_SUSPENDED_MESSAGE,
      });
      expect(access.message).not.toMatch(/pagamento/);
    }
    // Rotina de cobrança: sempre "falta de pagamento"
    for (const grace of [expiredGrace, futureGrace, null]) {
      expect(suspendedBy('BILLING', grace).message).toBe(
        SUBSCRIPTION_UNPAID_MESSAGE,
      );
    }
  });

  it('assinatura suspensa ou cancelada bloqueia vendas e alterações', () => {
    for (const status of [
      SubscriptionStatus.SUSPENDED,
      SubscriptionStatus.CANCELED,
    ]) {
      const access = storeAccessState(active, { status }, NOW);
      expect(access.canSell).toBe(false);
      expect(access.canManage).toBe(false);
      expect(access.canRead).toBe(true);
      expect(access.canManageBilling).toBe(true);
    }
  });

  it('cancelamento agendado vale até o fim do período', () => {
    const before = storeAccessState(
      active,
      {
        status: SubscriptionStatus.ACTIVE,
        cancel_at_period_end: true,
        current_period_end: new Date('2026-10-20T00:00:00Z'),
      },
      NOW,
    );
    expect(before.canSell).toBe(true);

    const after = storeAccessState(
      active,
      {
        status: SubscriptionStatus.ACTIVE,
        cancel_at_period_end: true,
        current_period_end: new Date('2026-10-01T00:00:00Z'),
      },
      NOW,
    );
    expect(after.availability).toBe('SUBSCRIPTION_CANCELED');
    expect(after.canSell).toBe(false);
  });
});
