import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  PaymentController,
  PaymentWebhookController,
} from './payment.controller';
import { PaymentService } from './payment.service';
import { PaymentReconciler } from './payment-reconciler.service';
import { Payment } from './entities/payment.entity';
import { Order } from '../orders/entities/order.entity';
import { Store } from '../store/entities/store.entity';
import { OrderPricingModule } from '../orders/order-pricing.module';

@Module({
  // Payment: pagamentos persistidos; Order: o servidor cria o pedido quando o pagamento é aprovado;
  // Store: credencial Mercado Pago de cada loja (lida só pelo PaymentService).
  // OrderPricingModule calcula o valor cobrado (e o retrato de preços guardado no pagamento).
  // TenantService, PlanLimitsService e AuditService vêm dos módulos globais.
  imports: [
    TypeOrmModule.forFeature([Payment, Order, Store]),
    OrderPricingModule,
  ],
  // Webhook primeiro: POST /payment/webhook nunca depende das rotas com :storeSlug
  controllers: [PaymentWebhookController, PaymentController],
  providers: [PaymentService, PaymentReconciler],
  exports: [PaymentService], // OrdersService: pedido de um paymentId e estorno no cancelamento
})
export class PaymentModule {}
