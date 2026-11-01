import { ConflictException, Injectable } from '@nestjs/common';
import type { BillingProviderCode } from '../entities/subscription.entity';
import {
  billingBackUrl,
  configuredBillingProvider,
  ManualBillingProvider,
  ONLINE_BILLING_UNAVAILABLE_MESSAGE,
  type BillingProvider,
} from './billing-provider';
import {
  MercadoPagoBillingProvider,
  MercadoPagoSaasSdkApi,
  type MercadoPagoSaasApi,
} from './mercado-pago-billing.provider';

/**
 * Escolhe o provedor da cobrança SaaS pelas variáveis de ambiente (lidas a cada uso, sem reiniciar
 * a configuração em memória):
 * - SAAS_BILLING_PROVIDER=MANUAL (padrão): faturas registradas pelo superadmin; sem checkout online;
 * - SAAS_BILLING_PROVIDER=MERCADO_PAGO + MP_SAAS_ACCESS_TOKEN: assinaturas recorrentes (preapproval).
 * A credencial é SEMPRE a da conta da plataforma, nunca a de uma loja.
 */
@Injectable()
export class BillingProvidersService {
  private readonly manual = new ManualBillingProvider();

  /** Fábrica da API do Mercado Pago (substituída nos testes). */
  protected createMercadoPagoApi(accessToken: string): MercadoPagoSaasApi {
    return new MercadoPagoSaasSdkApi(accessToken);
  }

  configuredCode(): BillingProviderCode {
    return configuredBillingProvider();
  }

  /** Conta Mercado Pago da plataforma configurada? (webhook e sincronização usam mesmo no MANUAL) */
  mercadoPago(): MercadoPagoBillingProvider | null {
    const token = process.env.MP_SAAS_ACCESS_TOKEN?.trim();
    if (!token) return null;
    return new MercadoPagoBillingProvider(this.createMercadoPagoApi(token), {
      backUrl: billingBackUrl(),
    });
  }

  /** Provedor de uma assinatura existente (para cancelar/atualizar a cobrança recorrente). */
  forCode(code: BillingProviderCode): BillingProvider | null {
    return code === 'MERCADO_PAGO' ? this.mercadoPago() : this.manual;
  }

  onlineCheckoutAvailable(): boolean {
    return (
      this.configuredCode() === 'MERCADO_PAGO' && this.mercadoPago() !== null
    );
  }

  /** Provedor do checkout online da loja; sem configuração → 409 com a mensagem de indisponível. */
  checkoutProvider(): BillingProvider {
    const provider =
      this.configuredCode() === 'MERCADO_PAGO' ? this.mercadoPago() : null;
    if (!provider?.online) {
      throw new ConflictException(ONLINE_BILLING_UNAVAILABLE_MESSAGE);
    }
    return provider;
  }
}
