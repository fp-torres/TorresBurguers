import { IsArray, IsInt, IsNotEmpty, IsString, ValidateNested, Min, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

class OrderItemDto {
  @IsInt()
  @IsNotEmpty()
  productId: number;

  @IsInt()
  @Min(1, { message: 'A quantidade deve ser no mínimo 1' }) 
  quantity: number;

  @IsString()
  @IsOptional() 
  observation?: string;
}

export class CreateOrderDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];
}