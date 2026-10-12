import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PaymentService } from './payment.service';
import {
  CreateCardPaymentDto,
  CreatePixPaymentDto,
} from './dto/create-payment.dto';
import { ParsePaymentIdPipe } from './parse-payment-id.pipe';
import { ClientOnlyGuard } from '../orders/client-only.guard';
import type { OrderActor } from '../orders/order-rules';

type ActorRequest = { user: OrderActor };

@ApiTags('Pagamentos')
@Controller('payment')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  // O valor é calculado no servidor a partir de "order"; aprovado → o servidor cria o pedido (orderId)
  @Post('card')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), ClientOnlyGuard)
  createCardPayment(
    @Body() dto: CreateCardPaymentDto,
    @Request() req: ActorRequest,
  ) {
    return this.paymentService.createCardPayment(dto, req.user);
  }

  // O pedido é criado pelo servidor quando o PIX for pago (status, webhook ou conciliação)
  @Post('pix')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), ClientOnlyGuard)
  createPixPayment(
    @Body() dto: CreatePixPaymentDto,
    @Request() req: ActorRequest,
  ) {
    return this.paymentService.createPixPayment(dto, req.user);
  }

  // Polling dos apps: somente o pagador ou a equipe; traz orderId assim que o pedido existir
  @Get('status/:id')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  checkStatus(
    @Param('id', ParsePaymentIdPipe) id: number,
    @Request() req: ActorRequest,
  ) {
    return this.paymentService.getStatusFor(id, req.user);
  }

  // O pagador desiste de um pagamento pendente (o PIX deixa de valer e nunca vira pedido)
  @Post(':id/cancel')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  cancel(
    @Param('id', ParsePaymentIdPipe) id: number,
    @Request() req: ActorRequest,
  ) {
    return this.paymentService.cancelFor(id, req.user);
  }

  // Notificações do Mercado Pago: público; o pagamento citado é reconsultado no próprio Mercado Pago
  @Post('webhook')
  @HttpCode(200)
  handleWebhook(
    @Body() body: unknown,
    @Query() query: Record<string, unknown>,
  ) {
    this.paymentService.handleNotification(body, query ?? {});
    return { status: 'ok' };
  }
}
