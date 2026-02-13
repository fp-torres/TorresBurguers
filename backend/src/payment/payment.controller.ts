import { Controller, Post, Body, Get, Param } from '@nestjs/common';
import { PaymentService } from './payment.service';

@Controller('payment')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post('card')
  async createCardPayment(@Body() data: any) {
    // data deve conter: { token, amount, email, paymentMethodId, installments, docType, docNumber }
    return this.paymentService.processCardPayment(data);
  }

  @Post('pix')
  async createPixPayment(@Body() data: any) {
    // data deve conter: { amount, email, docNumber }
    return this.paymentService.processPixPayment(data);
  }

  @Get('status/:id')
  async checkStatus(@Param('id') id: string) {
    return this.paymentService.getPaymentStatus(Number(id));
  }
  
  // Webhook (Opcional por enquanto, vamos usar Polling no front que é mais fácil pra começar)
  @Post('webhook')
  async handleWebhook(@Body() body: any) {
    console.log('Webhook recebido:', body);
    return { status: 'ok' };
  }
}