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
    // Garante que converte "29,90" ou "29.90" para número 29.9
    return parseFloat(String(value).replace(',', '.'));
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
    return parseFloat(String(value).replace(',', '.'));
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

  // --- INGREDIENTES (String única -> Array) ---
  @ApiProperty({ required: false })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => {
    if (!value) return [];
    // Se vier "Alface, Tomate", vira ["Alface", "Tomate"]
    if (typeof value === 'string') {
      return value.split(',').map((v: string) => v.trim()).filter((v: string) => v.length > 0);
    }
    // Se já for array, retorna ele mesmo
    return value;
  })
  ingredients?: string[];

  // --- ADICIONAIS (CORREÇÃO DO ERRO 400) ---
  @ApiProperty({ required: false, type: [Number] })
  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true }) // Valida se cada item é número
  @Transform(({ value }) => {
    if (!value) return [];
    // Se vier um único valor (ex: "1"), transforma em ["1"]
    const values = Array.isArray(value) ? value : [value];
    // Converte tudo para número (ex: ["1", "2"] -> [1, 2])
    return values.map((v: any) => Number(v));
  })
  allowed_addons_ids?: number[];
}