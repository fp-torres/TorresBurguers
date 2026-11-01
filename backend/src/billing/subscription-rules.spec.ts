import { ConflictException } from '@nestjs/common';
import { BillingInterval } from './entities/plan.entity';
import { InvoiceStatus } from './entities/subscription-invoice.entity';
import { SubscriptionStatus } from './entities/subscription.entity';
import {
  addInterval,
  assertTransition,
  canDowngrade,
  canTransition,
  describeViolations,
  graceEnd,
  isPaidPlan,
  isUnpaidInvoice,
  monthlyPrice,
  parseSubscriptionExternalReference,
  roundMoney,
  subscriptionExternalReference,
  SUBSCRIPTION_TRANSITIONS,
  trialEnd,
} from './subscription-rules';

const { TRIALING, ACTIVE, PAST_DUE, SUSPENDED, CANCELED } = SubscriptionStatus;
const iso = (value: Date) => value.toISOString();

describe('subscription-rules', () => {
  describe('transições', () => {
    it('segue o mapa da arquitetura (seção 6)', () => {
      expect(SUBSCRIPTION_TRANSITIONS).toEqual({
        TRIALING: [ACTIVE, PAST_DUE, CANCELED],
        ACTIVE: [PAST_DUE, SUSPENDED, CANCELED],
        PAST_DUE: [ACTIVE, SUSPENDED, CANCELED],
        SUSPENDED: [ACTIVE, CANCELED],
        CANCELED: [],
      });
      expect(canTransition(TRIALING, ACTIVE)).toBe(true);
      expect(canTransition(SUSPENDED, ACTIVE)).toBe(true);
      expect(canTransition(PAST_DUE, SUSPENDED)).toBe(true);
    });

    it('recusa com 409 (a situação atual não permite) e mensagem em português', () => {
      expect(() => assertTransition(TRIALING, SUSPENDED)).toThrow(
        ConflictException,
      );
      expect(() => assertTransition(TRIALING, SUSPENDED)).toThrow(
        'A assinatura não pode passar de "Em teste grátis" para "Suspensa".',
      );
      expect(() => assertTransition(SUSPENDED, PAST_DUE)).toThrow(
        /não pode passar de "Suspensa" para "Pagamento em atraso"/,
      );
      expect(() => assertTransition(ACTIVE, ACTIVE)).toThrow(
        'A assinatura já está na situação "Ativa".',
      );
    });

    it('CANCELED é final', () => {
      for (const to of [TRIALING, ACTIVE, PAST_DUE, SUSPENDED, CANCELED]) {
        expect(canTransition(CANCELED, to)).toBe(false);
      }
      expect(() => assertTransition(CANCELED, ACTIVE)).toThrow(
        /cancelada e não pode mais mudar de situação/,
      );
      expect(() => assertTransition(CANCELED, SUSPENDED)).toThrow(
        ConflictException,
      );
    });
  });

  describe('addInterval', () => {
    it('mesmo dia e horário no mês seguinte', () => {
      expect(
        iso(
          addInterval(
            new Date('2026-10-11T15:30:00.000Z'),
            BillingInterval.MONTHLY,
          ),
        ),
      ).toBe('2026-11-11T15:30:00.000Z');
      // virada do ano
      expect(
        iso(
          addInterval(
            new Date('2026-12-15T00:00:00.000Z'),
            BillingInterval.MONTHLY,
          ),
        ),
      ).toBe('2027-01-15T00:00:00.000Z');
    });

    it('fim de mês: usa o último dia do mês de destino (nunca transborda)', () => {
      expect(
        iso(
          addInterval(
            new Date('2026-01-31T12:00:00.000Z'),
            BillingInterval.MONTHLY,
          ),
        ),
      ).toBe('2026-02-28T12:00:00.000Z');
      // ano bissexto
      expect(
        iso(
          addInterval(
            new Date('2028-01-31T12:00:00.000Z'),
            BillingInterval.MONTHLY,
          ),
        ),
      ).toBe('2028-02-29T12:00:00.000Z');
      expect(
        iso(
          addInterval(
            new Date('2026-03-31T12:00:00.000Z'),
            BillingInterval.MONTHLY,
          ),
        ),
      ).toBe('2026-04-30T12:00:00.000Z');
    });

    it('anual (29/02 → 28/02) e vários períodos', () => {
      expect(
        iso(
          addInterval(
            new Date('2028-02-29T10:00:00.000Z'),
            BillingInterval.YEARLY,
          ),
        ),
      ).toBe('2029-02-28T10:00:00.000Z');
      expect(
        iso(
          addInterval(
            new Date('2026-10-11T10:00:00.000Z'),
            BillingInterval.YEARLY,
          ),
        ),
      ).toBe('2027-10-11T10:00:00.000Z');
      expect(
        iso(
          addInterval(
            new Date('2026-11-30T10:00:00.000Z'),
            BillingInterval.MONTHLY,
            3,
          ),
        ),
      ).toBe('2027-02-28T10:00:00.000Z');
    });
  });

  it('fim do teste e da tolerância em dias corridos', () => {
    const start = new Date('2026-10-11T12:00:00.000Z');
    expect(iso(trialEnd(start, 14))).toBe('2026-10-25T12:00:00.000Z');
    expect(iso(trialEnd(start, 0))).toBe(iso(start));
    expect(iso(graceEnd(start, 7))).toBe('2026-10-18T12:00:00.000Z');
    expect(iso(graceEnd(start, -3))).toBe(iso(start));
  });

  describe('canDowngrade', () => {
    const plan = {
      max_staff_users: 3,
      max_products: 50,
      max_monthly_orders: null,
    };

    it('lista o que excede (uso igual ao limite cabe; nulo é ilimitado)', () => {
      expect(
        canDowngrade(
          { staff_users: 3, products: 50, monthly_orders: 100_000 },
          plan,
        ),
      ).toEqual([]);

      const violations = canDowngrade(
        { staff_users: 5, products: 80, monthly_orders: 10 },
        plan,
      );
      expect(violations).toEqual([
        { key: 'staff_users', label: 'usuários da equipe', limit: 3, usage: 5 },
        {
          key: 'products',
          label: 'produtos no cardápio',
          limit: 50,
          usage: 80,
        },
      ]);
      expect(describeViolations(violations)).toBe(
        'usuários da equipe: 5 em uso (limite 3); produtos no cardápio: 80 em uso (limite 50)',
      );
    });

    it('armazenamento: compara os bytes medidos com max_storage_mb (sem medição não bloqueia)', () => {
      const MB = 1024 * 1024;
      const usage = { staff_users: 1, products: 1, monthly_orders: 1 };
      const small = { ...plan, max_storage_mb: 500 };
      // Igual ao limite cabe; ilimitado ou sem medição (null) não bloqueia
      expect(canDowngrade(usage, small, 500 * MB)).toEqual([]);
      expect(
        canDowngrade(usage, { ...plan, max_storage_mb: null }, 9e9),
      ).toEqual([]);
      expect(canDowngrade(usage, small, null)).toEqual([]);
      expect(canDowngrade(usage, plan, 9e9)).toEqual([]);

      const violations = canDowngrade(usage, small, 612.5 * MB);
      expect(violations).toEqual([
        {
          key: 'storage_mb',
          label: 'MB de armazenamento',
          limit: 500,
          usage: 612.5,
        },
      ]);
      expect(describeViolations(violations)).toBe(
        'MB de armazenamento: 612,5 em uso (limite 500)',
      );
      // Inteiros continuam sem separador de milhar (texto de antes)
      expect(
        describeViolations([
          { key: 'products', label: 'produtos', limit: 1000, usage: 1200 },
        ]),
      ).toBe('produtos: 1200 em uso (limite 1000)');
    });
  });

  it('preço mensalizado para o MRR', () => {
    expect(
      monthlyPrice({ price: 99.9, billing_interval: BillingInterval.MONTHLY }),
    ).toBe(99.9);
    expect(
      monthlyPrice({ price: 1200, billing_interval: BillingInterval.YEARLY }),
    ).toBe(100);
    // soma sem arredondar cada item; arredonda o total
    const yearly = {
      price: 1199.9,
      billing_interval: BillingInterval.YEARLY,
    };
    expect(roundMoney(monthlyPrice(yearly) * 3)).toBe(299.98);
    expect(roundMoney(10.005)).toBe(10.01);
    expect(isPaidPlan({ price: 0 })).toBe(false);
    expect(isPaidPlan({ price: 0.01 })).toBe(true);
  });

  it('faturas em aberto: OPEN e FAILED (recusada continua cobrável)', () => {
    expect(isUnpaidInvoice(InvoiceStatus.OPEN)).toBe(true);
    expect(isUnpaidInvoice(InvoiceStatus.FAILED)).toBe(true);
    expect(isUnpaidInvoice(InvoiceStatus.PAID)).toBe(false);
    expect(isUnpaidInvoice(InvoiceStatus.VOID)).toBe(false);
  });

  it('external_reference da assinatura no provedor', () => {
    expect(subscriptionExternalReference(12)).toBe('comestra-assinatura-12');
    expect(parseSubscriptionExternalReference('comestra-assinatura-12')).toBe(
      12,
    );
    for (const invalid of [
      'comestra-pedido-12',
      'comestra-assinatura-',
      'comestra-assinatura-0',
      'comestra-assinatura-99999999999',
      'xcomestra-assinatura-1',
      12,
      null,
    ]) {
      expect(parseSubscriptionExternalReference(invalid)).toBeNull();
    }
  });
});
