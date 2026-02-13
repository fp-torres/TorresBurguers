import { Module } from '@nestjs/common';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';

@Module({
  controllers: [PaymentController],
  providers: [PaymentService],
  exports: [PaymentService] // Exportamos caso o módulo de Pedidos (Orders) precise criar pagamentos
})
export class PaymentModule {}