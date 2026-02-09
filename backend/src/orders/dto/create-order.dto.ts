import { IsArray, IsInt, IsNotEmpty, IsString, ValidateNested, Min, IsOptional, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { OrderType } from '../entities/order.entity';

class OrderItemDto {
  @ApiProperty()
  @IsInt()
  @IsNotEmpty()
  productId: number;

  @ApiProperty()
  @IsInt()
  @Min(1, { message: 'A quantidade deve ser no mínimo 1' }) 
  quantity: number;

  @ApiProperty({ required: false, type: [Number] })
  @IsArray()
  @IsOptional()
  addonIds?: number[];

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional() 
  observation?: string;
}

export class CreateOrderDto {
  @ApiProperty({ type: [OrderItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];

  // 1. Tipo: DELIVERY ou TAKEOUT
  @ApiProperty({ enum: OrderType, example: OrderType.DELIVERY })
  @IsEnum(OrderType)
  type: OrderType;

  // 2. ID do Endereço (Obrigatório se for Delivery, mas validaremos na lógica)
  @ApiProperty({ example: 1, required: false })
  @IsInt()
  @IsOptional()
  addressId?: number;

  // 3. Forma de Pagamento (PIX, Cartão, Dinheiro)
  @ApiProperty({ example: 'PIX' })
  @IsString()
  @IsNotEmpty()
  paymentMethod: string;
}