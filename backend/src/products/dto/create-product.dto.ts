import { IsString, IsNotEmpty, IsNumber, IsEnum, IsBoolean, IsOptional, Min, IsArray } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ProductCategory } from '../entities/product.entity';
import { ApiProperty } from '@nestjs/swagger';

export class CreateProductDto {
  @ApiProperty({ example: 'X-Bacon Torres' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'Descrição...' })
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiProperty({ example: 29.90 })
  @Transform(({ value }) => parseFloat(String(value).replace(',', '.')))
  @IsNumber()
  @Min(0)
  price: number;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  image?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(({ value }) => value ? parseFloat(String(value).replace(',', '.')) : undefined)
  @IsNumber()
  @Min(0)
  promotion_price?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  is_highlight?: boolean;

  @ApiProperty({ enum: ProductCategory })
  @Transform(({ value }) => String(value).toLowerCase())
  @IsEnum(ProductCategory, { 
    message: 'Categoria inválida. Use: hamburgueres, bebidas, sobremesas, acompanhamentos, combos, molhos, adicionais' 
  })
  category: ProductCategory;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  available?: boolean;

  // --- TRANSFORMAÇÃO DE INGREDIENTES ---
  @ApiProperty({ required: false })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => {
    // Se vier como string única (ex: "Alface, Tomate"), transforma em array
    if (typeof value === 'string') {
      return value.split(',').map((v: string) => v.trim()).filter((v: string) => v.length > 0);
    }
    return value;
  })
  ingredients?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsArray()
  allowed_addons_ids?: number[];
}