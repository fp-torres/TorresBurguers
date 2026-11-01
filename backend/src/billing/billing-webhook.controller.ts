import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { IncomingHttpHeaders } from 'http';
import { BillingWebhookService } from './billing-webhook.service';

/**
 * Notificações do Mercado Pago da cobrança SaaS (conta da PLATAFORMA). Público: a autenticidade vem
 * do x-signature (MP_SAAS_WEBHOOK_SECRET) e o recurso é sempre reconsultado no Mercado Pago.
 * O webhook do delivery (contas das lojas) é outro: POST /payment/webhook.
 */
@ApiTags('Cobrança SaaS')
@Controller('billing/webhook')
export class BillingWebhookController {
  constructor(private readonly webhooks: BillingWebhookService) {}

  @Post('mercadopago')
  @HttpCode(200)
  async mercadoPago(
    @Headers() headers: IncomingHttpHeaders,
    @Query() query: Record<string, unknown>,
    @Body() body: unknown,
  ) {
    const result = await this.webhooks.handleMercadoPago({
      headers,
      query: query ?? {},
      body,
    });
    return { status: 'ok', result };
  }
}
