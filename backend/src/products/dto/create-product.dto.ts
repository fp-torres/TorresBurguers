import { IsString, IsNotEmpty, IsNumber, IsEnum, IsBoolean, IsOptional, Min, IsArray } from 'class-validator';
import { Transform } from 'class-transformer';
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
  @Transform(({ value }) => {
    // Se vier "29,90" ou "29.90" ou "R$ 29,90", converte para número
    if (typeof value === 'string') {
      return parseFloat(value.replace('R$', '').replace(/\./g, '').replace(',', '.'));
    }
    return value;
  })
  @IsNumber()
  @Min(0)
  price: number;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  image?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return undefined;
    if (typeof value === 'string') {
       return parseFloat(value.replace('R$', '').replace(/\./g, '').replace(',', '.'));
    }
    return value;
  })
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

  @ApiProperty({ required: false })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => {
    if (!value) return [];
    if (typeof value === 'string') {
      return value.split(',').map((v: string) => v.trim()).filter((v: string) => v.length > 0);
    }
    return value;
  })
  ingredients?: string[];

  @ApiProperty({ required: false, type: [Number] })
  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true }) 
  @Transform(({ value }) => {
    if (!value) return [];
    const values = Array.isArray(value) ? value : [value];
    return values.map((v: any) => Number(v));
  })
  allowed_addons_ids?: number[];
}