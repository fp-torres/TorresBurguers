import {
  MercadoPagoConfig,
  Payment as MercadoPagoPayment,
  PaymentRefund,
} from 'mercadopago';

export type MercadoPagoPaymentResponse = Awaited<
  ReturnType<MercadoPagoPayment['get']>
>;
export type MercadoPagoCreateBody = Parameters<
  MercadoPagoPayment['create']
>[0]['body'];

/** Operações do Mercado Pago usadas pelos pagamentos (os testes trocam por um dublê). */
export interface PaymentGateway {
  createPayment(
    body: MercadoPagoCreateBody,
    idempotencyKey: string,
  ): Promise<MercadoPagoPaymentResponse>;
  getPayment(id: number): Promise<MercadoPagoPaymentResponse>;
  cancelPayment(
    id: number,
    idempotencyKey: string,
  ): Promise<MercadoPagoPaymentResponse>;
  refundPayment(id: number, idempotencyKey: string): Promise<unknown>;
}

/**
 * SDK oficial com uma configuração NOVA a cada chamada: o SDK grava os requestOptions (inclusive a
 * chave de idempotência) na configuração compartilhada, e uma chave antiga seria reaproveitada pela
 * cobrança seguinte (o Mercado Pago devolveria o pagamento anterior).
 */
export class MercadoPagoGateway implements PaymentGateway {
  constructor(
    private readonly accessToken: string,
    private readonly timeoutMs = 10_000,
  ) {}

  private config(idempotencyKey?: string): MercadoPagoConfig {
    return new MercadoPagoConfig({
      accessToken: this.accessToken,
      options: {
        timeout: this.timeoutMs,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      },
    });
  }

  createPayment(body: MercadoPagoCreateBody, idempotencyKey: string) {
    return new MercadoPagoPayment(this.config(idempotencyKey)).create({
      body,
    });
  }

  getPayment(id: number) {
    return new MercadoPagoPayment(this.config()).get({ id });
  }

  cancelPayment(id: number, idempotencyKey: string) {
    return new MercadoPagoPayment(this.config(idempotencyKey)).cancel({ id });
  }

  refundPayment(id: number, idempotencyKey: string) {
    // Corpo vazio = estorno total
    return new PaymentRefund(this.config(idempotencyKey)).create({
      payment_id: id,
      body: {},
    });
  }
}
