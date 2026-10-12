import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { OrderStatus } from '../order.enums';

/** PATCH /orders/:id — só o status muda por aqui (itens, valores e pagamento não são editáveis). */
export class UpdateOrderStatusDto {
  @ApiProperty({ enum: OrderStatus })
  @IsEnum(OrderStatus, {
    message:
      'Status inválido. Use: PENDING, PREPARING, READY_FOR_PICKUP, DELIVERING, DONE ou CANCELED.',
  })
  status: OrderStatus;
}
