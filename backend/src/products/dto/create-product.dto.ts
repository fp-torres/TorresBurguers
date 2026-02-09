import { IsString, IsNotEmpty, IsNumber, IsEnum, IsBoolean, IsOptional, Min } from 'class-validator';
import { ProductCategory } from '../entities/product.entity';
import { ApiProperty } from '@nestjs/swagger';

export class CreateProductDto {
  @ApiProperty({ example: 'X-Bacon Torres' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'Pão brioche, 2 carnes, muito bacon e queijo cheddar.' })
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiProperty({ example: 29.90 })
  @IsNumber()
  @Min(0)
  price: number;

  // --- NOVO: Campo de Promoção (Opcional) ---
  @ApiProperty({ example: 19.90, required: false, description: 'Preço com desconto' })
  @IsNumber()
  @IsOptional()
  @Min(0)
  promotion_price?: number;

  // --- NOVO: Campo de Destaque (Opcional) ---
  @ApiProperty({ example: true, required: false, description: 'Se aparece no topo do App' })
  @IsBoolean()
  @IsOptional()
  is_highlight?: boolean;

  @ApiProperty({ enum: ProductCategory, example: ProductCategory.BURGER })
  @IsEnum(ProductCategory, { 
    message: 'Categoria inválida. Use: hamburgueres, bebidas, sobremesas, etc.' 
  })
  category: ProductCategory;

  @ApiProperty({ example: true, required: false })
  @IsBoolean()
  @IsOptional()
  available?: boolean;
}