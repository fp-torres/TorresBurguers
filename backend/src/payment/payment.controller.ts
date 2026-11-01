import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request as ExpressRequest } from 'express';
import type { AuthUser } from '../auth/auth-user';
import { clientIpKey } from '../auth/link-token';
import { PublicStore, PublicStoreRoute } from '../tenancy/decorators';
import type { TenantContext } from '../tenancy/tenant-context';
import { PaymentService } from './payment.service';
import {
  CreateCardPaymentDto,
  CreatePixPaymentDto,
} from './dto/create-payment.dto';
import { ParsePaymentIdPipe } from './parse-payment-id.pipe';
import { ClientOnlyGuard } from '../orders/client-only.guard';

type AuthRequest = Partial<ExpressRequest> & { user: AuthUser };

/**
 * Pagamentos online do delivery, na conta Mercado Pago da loja:
 * - /stores/:storeSlug/payment/...: compra numa loja da vitrine;
 * - /payment/...: rotas antigas (app mobile), na loja padrão.
 * Os guards de método rodam de baixo para cima: JWT e "só clientes" antes de resolver a loja.
 */
@ApiTags('Pagamentos')
@Controller(['payment', 'stores/:storeSlug/payment'])
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  // O valor é calculado no servidor a partir de "order"; aprovado → o servidor cria o pedido (orderId).
  // Cobranças limitadas por cliente na loja e por IP (429).
  @Post('card')
  @ApiBearerAuth()
  @PublicStoreRoute({ sellable: true, auth: 'none' })
  @UseGuards(AuthGuard('jwt'), ClientOnlyGuard)
  createCardPayment(
    @Body() dto: CreateCardPaymentDto,
    @Request() req: AuthRequest,
    @PublicStore() store: TenantContext,
  ) {
    return this.paymentService.createCardPayment(
      dto,
      req.user,
      store,
      clientIpKey(req as ExpressRequest),
    );
  }

  // O pedido é criado pelo servidor quando o PIX for pago (status, webhook ou conciliação).
  // O mesmo carrinho com PIX pendente devolve o mesmo PIX; teto de PIX pendentes por cliente (429).
  @Post('pix')
  @ApiBearerAuth()
  @PublicStoreRoute({ sellable: true, auth: 'none' })
  @UseGuards(AuthGuard('jwt'), ClientOnlyGuard)
  createPixPayment(
    @Body() dto: CreatePixPaymentDto,
    @Request() req: AuthRequest,
    @PublicStore() store: TenantContext,
  ) {
    return this.paymentService.createPixPayment(
      dto,
      req.user,
      store,
      clientIpKey(req as ExpressRequest),
    );
  }

  // Polling dos apps: somente o pagador ou ADMIN/EMPLOYEE da loja do pagamento (404 nos demais casos)
  @Get('status/:id')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  checkStatus(
    @Param('id', ParsePaymentIdPipe) id: number,
    @Request() req: AuthRequest,
    @Param('storeSlug') storeSlug?: string,
  ) {
    return this.paymentService.getStatusFor(id, req.user, storeSlug);
  }

  // O pagador desiste de um pagamento pendente (o PIX deixa de valer e nunca vira pedido)
  @Post(':id/cancel')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  cancel(
    @Param('id', ParsePaymentIdPipe) id: number,
    @Request() req: AuthRequest,
    @Param('storeSlug') storeSlug?: string,
  ) {
    return this.paymentService.cancelFor(id, req.user, storeSlug);
  }
}

/**
 * Notificações do Mercado Pago (de todas as lojas): só em POST /payment/webhook. Público; o corpo não
 * é confiável — o pagamento citado é reconsultado no Mercado Pago com a credencial da loja dele.
 * Limite por IP (PAYMENT_WEBHOOK → 429; o Mercado Pago reenvia depois) e no máximo uma reconsulta
 * por pagamento a cada NOTIFICATION_RECHECK_MS (ver PaymentService.handleNotification).
 */
@ApiTags('Pagamentos')
@Controller('payment')
export class PaymentWebhookController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post('webhook')
  @HttpCode(200)
  handleWebhook(
    @Body() body: unknown,
    @Query() query: Record<string, unknown>,
    @Req() req?: ExpressRequest,
  ) {
    this.paymentService.handleNotification(body, query ?? {}, clientIpKey(req));
    return { status: 'ok' };
  }
}
