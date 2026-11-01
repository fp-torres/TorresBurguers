import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { User } from '../users/entities/user.entity';
import { Store } from '../store/entities/store.entity';
import { OrderPricingModule } from './order-pricing.module';
import { PaymentModule } from '../payment/payment.module';

/**
 * Pedidos por loja. TenantService (tenancy), PlanLimitsService (billing) e AuditService (audit)
 * vêm dos módulos globais.
 */
@Module({
  imports: [
    // Store: só o resumo { id, slug, name, logo } e o fuso dos relatórios
    TypeOrmModule.forFeature([Order, OrderItem, User, Store]),
    OrderPricingModule, // orçamento / valores do pedido
    PaymentModule, // conferência do pagamento online na criação do pedido e estornos
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
