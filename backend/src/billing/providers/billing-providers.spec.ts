import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { BRAND } from '../../config/brand';
import { BillingInterval } from '../entities/plan.entity';
import {
  billingBackUrl,
  configuredBillingProvider,
  ManualBillingProvider,
  ONLINE_BILLING_UNAVAILABLE_MESSAGE,
} from './billing-provider';
import { BillingProvidersService } from './billing-providers.service';
import {
  MercadoPagoBillingProvider,
  withTimeout,
  type MercadoPagoSaasApi,
} from './mercado-pago-billing.provider';

const NOW = new Date('2026-10-11T12:00:00.000Z');
const PLAN = {
  name: 'Essencial',
  price: 99.9,
  currency: 'BRL',
  billing_interval: BillingInterval.MONTHLY,
};

function fakeApi(): jest.Mocked<MercadoPagoSaasApi> {
  return {
    createPreapproval: jest.fn().mockResolvedValue({
      id: 'pre-123',
      status: 'pending',
      init_point:
        'https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=pre-123',
    }),
    getPreapproval: jest.fn(),
    updatePreapproval: jest.fn().mockResolvedValue({}),
    getAuthorizedPayment: jest.fn(),
    getPayment: jest.fn(),
  };
}

function provider(api = fakeApi()) {
  return {
    api,
    provider: new MercadoPagoBillingProvider(api, {
      backUrl: 'https://app.comestra.com.br/subscription',
      now: () => NOW,
    }),
  };
}

describe('Provedores da cobrança SaaS', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  describe('MercadoPagoBillingProvider (preapproval)', () => {
    it('cria a assinatura recorrente com external_reference, back_url e valor do plano', async () => {
      const { api, provider: mp } = provider();

      const checkout = await mp.createCheckout(
        { id: 12 },
        PLAN,
        { name: 'Lanchonete Boa' },
        'financeiro@loja.com',
        { startDate: new Date('2026-11-11T12:00:00.000Z') },
      );

      expect(checkout).toEqual({
        checkout_url:
          'https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=pre-123',
        provider_subscription_id: 'pre-123',
        provider_status: 'pending',
      });
      const [body, idempotencyKey] = api.createPreapproval.mock.calls[0];
      expect(body).toEqual({
        reason: `${BRAND.name} — plano Essencial (Lanchonete Boa)`,
        external_reference: 'comestra-assinatura-12',
        payer_email: 'financeiro@loja.com',
        back_url: 'https://app.comestra.com.br/subscription',
        status: 'pending',
        auto_recurring: {
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: 99.9,
          currency_id: 'BRL',
          start_date: '2026-11-11T12:00:00.000Z',
        },
      });
      expect(idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('anual = a cada 12 meses; data de início no passado → cobra ao autorizar', async () => {
      const { api, provider: mp } = provider();
      await mp.createCheckout(
        { id: 1 },
        { ...PLAN, price: 1200, billing_interval: BillingInterval.YEARLY },
        { name: 'Loja' },
        'a@b.com',
        { startDate: new Date('2026-10-01T00:00:00.000Z') },
      );
      const [body] = api.createPreapproval.mock.calls[0];
      expect(body.auto_recurring).toEqual({
        frequency: 12,
        frequency_type: 'months',
        transaction_amount: 1200,
        currency_id: 'BRL',
      });
    });

    it('recusa do Mercado Pago (4xx) → 400 com o motivo; indisponível → 502', async () => {
      const api = fakeApi();
      api.createPreapproval
        .mockRejectedValueOnce({
          status: 400,
          message: 'Invalid payer_email',
        })
        .mockRejectedValueOnce({ status: 500, message: 'internal_error' })
        .mockResolvedValueOnce({ id: 'x' });
      const { provider: mp } = provider(api);
      const call = () =>
        mp.createCheckout({ id: 1 }, PLAN, { name: 'Loja' }, 'x@y.com');

      await expect(call()).rejects.toThrow(
        new BadRequestException(
          'O Mercado Pago recusou a assinatura: Invalid payer_email',
        ),
      );
      await expect(call()).rejects.toThrow(BadGatewayException);
      // Sem link de pagamento na resposta
      await expect(call()).rejects.toThrow(BadGatewayException);
    });

    it('cancelamento e novo valor pela atualização da preapproval', async () => {
      const { api, provider: mp } = provider();
      await mp.cancelSubscription('pre-1');
      await mp.updateAmount('pre-1', 149.9, 'BRL');
      expect(api.updatePreapproval.mock.calls).toEqual([
        ['pre-1', { status: 'cancelled' }],
        [
          'pre-1',
          { auto_recurring: { transaction_amount: 149.9, currency_id: 'BRL' } },
        ],
      ]);
    });

    it('chamada que não responde estoura o prazo', async () => {
      jest.useFakeTimers();
      try {
        const pending = withTimeout(new Promise(() => undefined), 1000);
        const assertion = expect(pending).rejects.toMatchObject({
          status: 504,
        });
        await jest.advanceTimersByTimeAsync(1000);
        await assertion;
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('ManualBillingProvider', () => {
    it('não tem checkout online (409) e não há o que cancelar no provedor', async () => {
      const manual = new ManualBillingProvider();
      expect(manual.online).toBe(false);
      await expect(manual.createCheckout()).rejects.toThrow(
        new ConflictException(ONLINE_BILLING_UNAVAILABLE_MESSAGE),
      );
      await expect(manual.cancelSubscription()).resolves.toBeUndefined();
    });
  });

  describe('configuração por ambiente', () => {
    const keys = [
      'SAAS_BILLING_PROVIDER',
      'MP_SAAS_ACCESS_TOKEN',
      'SAAS_BILLING_BACK_URL',
      'APP_WEB_URL',
    ] as const;
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
      for (const key of keys) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
    });
    afterEach(() => {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });

    it('SAAS_BILLING_PROVIDER: MANUAL por padrão (valor desconhecido também)', () => {
      expect(configuredBillingProvider({})).toBe('MANUAL');
      expect(
        configuredBillingProvider({ SAAS_BILLING_PROVIDER: 'mercado_pago' }),
      ).toBe('MERCADO_PAGO');
      expect(
        configuredBillingProvider({ SAAS_BILLING_PROVIDER: 'stripe' }),
      ).toBe('MANUAL');
    });

    it('página de retorno: SAAS_BILLING_BACK_URL ou a página da assinatura no painel', () => {
      expect(
        billingBackUrl({ SAAS_BILLING_BACK_URL: 'https://app.x.com/volta' }),
      ).toBe('https://app.x.com/volta');
      expect(billingBackUrl({ APP_WEB_URL: 'https://app.x.com' })).toBe(
        'https://app.x.com/subscription',
      );
    });

    it('checkout online só com MERCADO_PAGO + credencial da plataforma', () => {
      const service = new BillingProvidersService();
      expect(service.onlineCheckoutAvailable()).toBe(false);
      expect(() => service.checkoutProvider()).toThrow(
        new ConflictException(ONLINE_BILLING_UNAVAILABLE_MESSAGE),
      );

      // Provedor escolhido, mas sem credencial: indisponível
      process.env.SAAS_BILLING_PROVIDER = 'MERCADO_PAGO';
      expect(() => service.checkoutProvider()).toThrow(
        ONLINE_BILLING_UNAVAILABLE_MESSAGE,
      );
      expect(service.mercadoPago()).toBeNull();

      process.env.MP_SAAS_ACCESS_TOKEN = 'APP_USR-plataforma';
      expect(service.onlineCheckoutAvailable()).toBe(true);
      expect(service.checkoutProvider()).toBeInstanceOf(
        MercadoPagoBillingProvider,
      );
      expect(service.forCode('MANUAL')).toBeInstanceOf(ManualBillingProvider);

      // Credencial presente mas provedor MANUAL: webhook/sincronização funcionam, checkout não
      process.env.SAAS_BILLING_PROVIDER = 'MANUAL';
      expect(service.mercadoPago()).toBeInstanceOf(MercadoPagoBillingProvider);
      expect(service.onlineCheckoutAvailable()).toBe(false);
    });
  });
});
