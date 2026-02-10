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

  // --- NOVO: Ponto da Carne ---
  @ApiProperty({ required: false, example: 'Ao Ponto' })
  @IsString()
  @IsOptional()
  meatPoint?: string;

  // --- NOVO: Ingredientes Removidos ---
  @ApiProperty({ required: false, type: [String], example: ['Cebola'] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  removedIngredients?: string[];
}

export class CreateOrderDto {
  @ApiProperty({ type: [OrderItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];

  @ApiProperty({ enum: OrderType, example: OrderType.DELIVERY })
  @IsEnum(OrderType)
  type: OrderType;

  @ApiProperty({ example: 1, required: false })
  @IsInt()
  @IsOptional()
  addressId?: number;

  @ApiProperty({ example: 'PIX' })
  @IsString()
  @IsNotEmpty()
  paymentMethod: string;
}