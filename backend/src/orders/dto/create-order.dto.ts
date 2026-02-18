import { IsArray, IsInt, IsNotEmpty, IsString, ValidateNested, Min, IsOptional, IsEnum, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { OrderType } from '../entities/order.entity';

export class OrderItemDto {
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

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  meatPoint?: string;

  @ApiProperty({ required: false })
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

  @ApiProperty({ enum: OrderType })
  @IsEnum(OrderType)
  type: OrderType;

  @ApiProperty({ required: false })
  @IsInt()
  @IsOptional()
  addressId?: number;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  paymentMethod: string;

  // --- CORREÇÃO 1: Liberar o paymentId ---
  @ApiProperty({ required: false })
  @IsNumber()
  @IsOptional()
  paymentId?: number;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  changeFor?: string;
}