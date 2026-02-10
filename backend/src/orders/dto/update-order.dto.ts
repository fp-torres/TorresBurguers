import { PartialType } from '@nestjs/mapped-types';
import { CreateOrderDto } from './create-order.dto';
import { IsEnum, IsOptional } from 'class-validator';
import { OrderStatus } from '../entities/order.entity';

export class UpdateOrderDto extends PartialType(CreateOrderDto) {
  @IsOptional()
  @IsEnum(OrderStatus, {
    message: 'Status inválido. Use: PENDING, PREPARING, DELIVERING, DONE, CANCELED'
  })
  status?: OrderStatus;
}