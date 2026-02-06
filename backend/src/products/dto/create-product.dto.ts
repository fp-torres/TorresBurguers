import { IsString, IsNotEmpty, IsNumber, IsEnum, IsBoolean, IsOptional, Min } from 'class-validator';
import { ProductCategory } from '../entities/product.entity';
import { ApiProperty } from '@nestjs/swagger'; // Para documentar no Swagger

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