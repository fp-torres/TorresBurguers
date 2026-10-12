import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { PaymentReconciler } from './payment-reconciler.service';
import { Payment } from './entities/payment.entity';
import { Order } from '../orders/entities/order.entity';
import { OrderPricingModule } from '../orders/order-pricing.module';

@Module({
  // Payment: pagamentos persistidos; Order: o servidor cria o pedido quando o pagamento é aprovado.
  // OrderPricingModule calcula o valor cobrado (e o retrato de preços guardado no pagamento).
  imports: [TypeOrmModule.forFeature([Payment, Order]), OrderPricingModule],
  controllers: [PaymentController],
  providers: [PaymentService, PaymentReconciler],
  exports: [PaymentService], // OrdersService: pedido de um paymentId e estorno no cancelamento
})
export class PaymentModule {}
