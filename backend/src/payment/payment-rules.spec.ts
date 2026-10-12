import {
  amountMatches,
  cardOrderMethod,
  describeMercadoPagoError,
  externalReferenceUserId,
  isFinalPaymentStatus,
  isSimulatedPaymentId,
  mercadoPagoDate,
  parseWebhookPaymentId,
  paymentKindFor,
  resolvePaymentMode,
  simulatedPixProgress,
  splitPayerName,
} from './payment-rules';

const DEV = { NODE_ENV: 'development' };

describe('payment-rules', () => {
  describe('resolvePaymentMode', () => {
    it('em development/test sem PAYMENT_SANDBOX: sandbox quando não há token ou o token é de teste', () => {
      expect(resolvePaymentMode(DEV).sandbox).toBe(true);
      expect(resolvePaymentMode({ NODE_ENV: 'test' }).sandbox).toBe(true);
      expect(
        resolvePaymentMode({ ...DEV, MP_ACCESS_TOKEN: '  ' }).sandbox,
      ).toBe(true);
      expect(
        resolvePaymentMode({ ...DEV, MP_ACCESS_TOKEN: 'TEST-123' }).sandbox,
      ).toBe(true);
      expect(
        resolvePaymentMode({ ...DEV, MP_ACCESS_TOKEN: 'APP_USR-123' }).sandbox,
      ).toBe(false);
    });

    it('PAYMENT_SANDBOX explícito tem prioridade (em development/test)', () => {
      expect(
        resolvePaymentMode({
          ...DEV,
          MP_ACCESS_TOKEN: 'TEST-123',
          PAYMENT_SANDBOX: 'false',
        }).sandbox,
      ).toBe(false);
      expect(
        resolvePaymentMode({
          ...DEV,
          MP_ACCESS_TOKEN: 'APP_USR-123',
          PAYMENT_SANDBOX: 'true',
        }).sandbox,
      ).toBe(true);
      expect(
        resolvePaymentMode({ ...DEV, PAYMENT_SANDBOX: 'talvez' }).sandbox,
      ).toBe(true);
      expect(resolvePaymentMode({ ...DEV, PAYMENT_SANDBOX: '' }).sandbox).toBe(
        true,
      );
    });

    it('produção (ou NODE_ENV ausente/desconhecido) nunca liga o sandbox e recusa PAYMENT_SANDBOX=true', () => {
      expect(resolvePaymentMode({}).sandbox).toBe(false);
      expect(resolvePaymentMode({ NODE_ENV: 'production' }).sandbox).toBe(
        false,
      );
      expect(resolvePaymentMode({ NODE_ENV: 'staging' }).sandbox).toBe(false);
      expect(
        resolvePaymentMode({
          NODE_ENV: 'production',
          MP_ACCESS_TOKEN: 'TEST-123',
        }).sandbox,
      ).toBe(false);

      const refused = resolvePaymentMode({
        NODE_ENV: 'production',
        MP_ACCESS_TOKEN: 'TEST-123',
        PAYMENT_SANDBOX: 'true',
      });
      expect(refused.sandbox).toBe(false);
      expect(refused.sandboxRefused).toBe(true);
      expect(resolvePaymentMode(DEV).sandboxRefused).toBe(false);
    });

    it('lê o token e o prazo de aprovação do PIX de teste (padrão 5 s)', () => {
      expect(
        resolvePaymentMode({ MP_ACCESS_TOKEN: ' TEST-1 ' }).accessToken,
      ).toBe('TEST-1');
      expect(resolvePaymentMode({}).accessToken).toBeNull();
      expect(resolvePaymentMode({}).pixApprovalSeconds).toBe(5);
      expect(
        resolvePaymentMode({ PIX_SANDBOX_APPROVAL_SECONDS: '12' })
          .pixApprovalSeconds,
      ).toBe(12);
      expect(
        resolvePaymentMode({ PIX_SANDBOX_APPROVAL_SECONDS: '0' })
          .pixApprovalSeconds,
      ).toBe(0);
      expect(
        resolvePaymentMode({ PIX_SANDBOX_APPROVAL_SECONDS: 'abc' })
          .pixApprovalSeconds,
      ).toBe(5);
      expect(
        resolvePaymentMode({ PIX_SANDBOX_APPROVAL_SECONDS: '-3' })
          .pixApprovalSeconds,
      ).toBe(5);
    });

    it('prazo do PIX: PIX_EXPIRATION_MINUTES (padrão 30; com Mercado Pago, mínimo 30)', () => {
      expect(resolvePaymentMode(DEV).pixExpirationMinutes).toBe(30);
      expect(
        resolvePaymentMode({ ...DEV, PIX_EXPIRATION_MINUTES: '45' })
          .pixExpirationMinutes,
      ).toBe(45);
      // Sem Mercado Pago (PIX simulado) vale qualquer prazo positivo
      expect(
        resolvePaymentMode({ ...DEV, PIX_EXPIRATION_MINUTES: '2' })
          .pixExpirationMinutes,
      ).toBe(2);
      const adjusted = resolvePaymentMode({
        ...DEV,
        MP_ACCESS_TOKEN: 'TEST-1',
        PIX_EXPIRATION_MINUTES: '10',
      });
      expect(adjusted.pixExpirationMinutes).toBe(30);
      expect(adjusted.pixExpirationAdjusted).toBe(true);
      for (const invalid of ['0', '-5', '1.5', 'trinta', '999999']) {
        expect(
          resolvePaymentMode({ ...DEV, PIX_EXPIRATION_MINUTES: invalid })
            .pixExpirationMinutes,
        ).toBe(30);
      }
    });

    it('MP_NOTIFICATION_URL só vale como URL http(s)', () => {
      expect(resolvePaymentMode(DEV).notificationUrl).toBeNull();
      expect(
        resolvePaymentMode({
          MP_NOTIFICATION_URL: ' https://api.loja.com.br/payment/webhook ',
        }).notificationUrl,
      ).toBe('https://api.loja.com.br/payment/webhook');
      expect(
        resolvePaymentMode({ MP_NOTIFICATION_URL: 'webhook' }).notificationUrl,
      ).toBeNull();
    });
  });

  it('associa a forma de pagamento do pedido ao tipo de pagamento online', () => {
    expect(paymentKindFor('PIX')).toBe('PIX');
    expect(paymentKindFor('CREDIT_CARD')).toBe('CARD');
    expect(paymentKindFor('DEBIT_CARD')).toBe('CARD');
    expect(paymentKindFor('MONEY')).toBeNull();
  });

  it('forma de pagamento do pedido criado por cartão: tipo do Mercado Pago ou meio "deb..."', () => {
    expect(cardOrderMethod('master')).toBe('CREDIT_CARD');
    expect(cardOrderMethod('debelo')).toBe('DEBIT_CARD');
    expect(cardOrderMethod('debvisa')).toBe('DEBIT_CARD');
    expect(cardOrderMethod('master', 'debit_card')).toBe('DEBIT_CARD');
    expect(cardOrderMethod('debmaster', 'credit_card')).toBe('CREDIT_CARD');
    expect(cardOrderMethod(undefined, 'prepaid_card')).toBe('DEBIT_CARD');
    expect(cardOrderMethod(null)).toBe('CREDIT_CARD');
  });

  it('o valor pago precisa ser o total com tolerância de R$ 0,01 (nem menos, nem mais)', () => {
    expect(amountMatches(45.9, 45.9)).toBe(true);
    expect(amountMatches(45.89, 45.9)).toBe(true);
    expect(amountMatches(45.91, 45.9)).toBe(true);
    expect(amountMatches(45.88, 45.9)).toBe(false);
    expect(amountMatches(45.92, 45.9)).toBe(false);
    // Pagar a mais também não quita outro pedido (R$ 75 de PIX para um pedido de R$ 25)
    expect(amountMatches(75, 25)).toBe(false);
    expect(amountMatches(0.01, 45.9)).toBe(false);
  });

  it('reconhece status finais do Mercado Pago e ids simulados', () => {
    expect(isFinalPaymentStatus('approved')).toBe(true);
    expect(isFinalPaymentStatus('rejected')).toBe(true);
    expect(isFinalPaymentStatus('cancelled')).toBe(true);
    expect(isFinalPaymentStatus('pending')).toBe(false);
    expect(isFinalPaymentStatus('in_process')).toBe(false);
    expect(isSimulatedPaymentId(900_000_000_000_001)).toBe(true);
    expect(isSimulatedPaymentId(123_456_789_012)).toBe(false);
  });

  describe('PIX simulado (sandbox)', () => {
    const at = (iso: string) => new Date(iso);
    const pending = {
      status: 'pending',
      auto_approve_at: at('2026-10-11T12:00:05Z'),
      expires_at: at('2026-10-11T12:30:00Z'),
    };

    it('aprova no prazo do sandbox e não antes', () => {
      expect(simulatedPixProgress(pending, at('2026-10-11T12:00:04Z'))).toBe(
        null,
      );
      expect(simulatedPixProgress(pending, at('2026-10-11T12:00:05Z'))).toEqual(
        { status: 'approved', status_detail: 'accredited' },
      );
    });

    it('vence sem aprovação quando o prazo de aprovação passa do vencimento', () => {
      const late = { ...pending, auto_approve_at: at('2026-10-11T13:00:00Z') };
      expect(simulatedPixProgress(late, at('2026-10-11T12:30:00Z'))).toEqual({
        status: 'cancelled',
        status_detail: 'expired',
      });
    });

    it('PIX cancelado (ou já aprovado) não muda mais', () => {
      expect(
        simulatedPixProgress(
          { ...pending, status: 'cancelled' },
          at('2026-10-11T12:10:00Z'),
        ),
      ).toBe(null);
      expect(
        simulatedPixProgress(
          { ...pending, status: 'approved' },
          at('2026-10-11T12:40:00Z'),
        ),
      ).toBe(null);
    });
  });

  it('data de vencimento no formato do Mercado Pago (ISO com fuso)', () => {
    expect(mercadoPagoDate(new Date('2026-10-11T19:35:00Z'))).toBe(
      '2026-10-11T19:35:00.000+00:00',
    );
  });

  it('lê o cliente da referência externa dos pagamentos deste servidor', () => {
    expect(externalReferenceUserId('comestra-cliente-42-1791732193705')).toBe(
      42,
    );
    expect(externalReferenceUserId('outra-coisa')).toBeNull();
    expect(externalReferenceUserId(undefined)).toBeNull();
  });

  it('extrai o id do pagamento das notificações do Mercado Pago (webhook e IPN)', () => {
    expect(
      parseWebhookPaymentId({
        action: 'payment.updated',
        type: 'payment',
        data: { id: '123456789' },
      }),
    ).toBe(123456789);
    expect(
      parseWebhookPaymentId({}, { type: 'payment', 'data.id': '555' }),
    ).toBe(555);
    expect(parseWebhookPaymentId({}, { topic: 'payment', id: '777' })).toBe(
      777,
    );
    expect(
      parseWebhookPaymentId({}, { topic: 'merchant_order', id: '777' }),
    ).toBeNull();
    expect(parseWebhookPaymentId({ data: { id: 'abc' } })).toBeNull();
    expect(parseWebhookPaymentId({ data: { id: '0' } })).toBeNull();
    expect(parseWebhookPaymentId(null)).toBeNull();
  });

  it('monta o nome do pagador do PIX a partir do usuário logado', () => {
    expect(splitPayerName('Maria da Silva')).toEqual({
      first_name: 'Maria',
      last_name: 'da Silva',
    });
    expect(splitPayerName('  Ana  ')).toEqual({
      first_name: 'Ana',
      last_name: 'Cliente',
    });
    expect(splitPayerName(null)).toEqual({
      first_name: 'Cliente',
      last_name: 'Cliente',
    });
  });

  it('extrai a mensagem dos erros do Mercado Pago e de rede', () => {
    expect(
      describeMercadoPagoError({
        message: 'bad_request',
        status: 400,
        cause: [{ code: 2006, description: 'Card Token not found' }],
      }),
    ).toEqual({ message: 'Card Token not found', httpStatus: 400 });
    expect(
      describeMercadoPagoError(
        new Error('getaddrinfo ENOTFOUND api.mercadopago.com'),
      ),
    ).toEqual({
      message: 'getaddrinfo ENOTFOUND api.mercadopago.com',
      httpStatus: null,
    });
    expect(describeMercadoPagoError('timeout')).toEqual({
      message: 'timeout',
      httpStatus: null,
    });
  });
});
