import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
} from 'class-validator';
import {
  IMAGE_REF_PATTERN,
  toBoolean,
  toImageRef,
  toIntArray,
  toMoney,
  toSlug,
  toStringArray,
  trimString,
} from '../../common/transforms';
import {
  IsNumberInRange,
  IsOptionalNotNull,
  IsText,
  MAX_DB_INT,
} from '../../common/validators';
import { ProductCategory } from '../entities/product.entity';

/** Maior preço aceito (cabe com folga no numeric(10,2) do banco). */
export const MAX_PRICE = 999_999.99;

/**
 * Preço promocional: como toMoney, mas vazio, null ou valor ≤ 0 significam "sem promoção" (null).
 * Assim o painel, a vitrine e o orçamento nunca tratam uma promoção 0 como item grátis.
 */
export function toPromotionPrice(value: unknown): unknown {
  const money = toMoney(value);
  return typeof money === 'number' && money <= 0 ? null : money;
}

const CATEGORIES = Object.values(ProductCategory).join(', ');

/** Referência de imagem: nome de arquivo enviado em POST /uploads ou URL http(s). */
export const IMAGE_REF_RULES = {
  maxLength: 500,
  pattern: IMAGE_REF_PATTERN,
  invalid:
    'Imagem inválida: informe o nome de um arquivo enviado em /uploads ou uma URL http(s).',
  tooLong: 'Referência de imagem muito longa.',
};

/**
 * Cadastro de produto — JSON ou multipart (FormData, imagem no campo "file").
 * Os nomes dos campos são os enviados pelo painel web e pelo app; textos do FormData
 * ("29.90", "true", campos repetidos...) são convertidos antes da validação.
 */
export class CreateProductDto {
  @ApiProperty({ example: 'X-Bacon da Casa', maxLength: 100 })
  @Transform(({ value }) => trimString(value))
  @IsText({
    maxLength: 100,
    required: 'O nome do produto é obrigatório.',
    invalid: 'O nome do produto deve ser um texto.',
    tooLong: 'O nome do produto pode ter no máximo 100 caracteres.',
  })
  name: string;

  @ApiPropertyOptional({
    example: 'Pão brioche, blend 180g, cheddar e bacon crocante.',
    maxLength: 1000,
  })
  @Transform(({ value }) => (value === null ? '' : trimString(value)))
  @IsOptionalNotNull()
  @IsText({
    maxLength: 1000,
    invalid: 'A descrição deve ser um texto.',
    tooLong: 'A descrição pode ter no máximo 1000 caracteres.',
  })
  description?: string;

  @ApiProperty({ example: 29.9, minimum: 0 })
  @Transform(({ value }) => toMoney(value))
  @IsNumberInRange({
    min: 0,
    max: MAX_PRICE,
    invalid: 'Informe um preço válido (ex.: 29.90).',
    tooLow: 'O preço não pode ser negativo.',
    tooHigh: 'Preço acima do limite permitido.',
  })
  price: number;

  @ApiPropertyOptional({
    example: 24.9,
    nullable: true,
    description:
      'Preço promocional, menor que o preço normal. Vazio, null, 0 ou negativo = sem promoção (gravado como null).',
  })
  @Transform(({ value }) => toPromotionPrice(value))
  @IsOptional()
  @IsNumberInRange({
    min: 0.01,
    max: MAX_PRICE,
    invalid: 'Informe um preço promocional válido (ex.: 24.90).',
    tooHigh: 'Preço promocional acima do limite permitido.',
  })
  promotion_price?: number | null;

  @ApiPropertyOptional({ example: false })
  @Transform(({ value }) => toBoolean(value))
  @IsOptionalNotNull()
  @IsBoolean({ message: 'is_highlight deve ser verdadeiro ou falso.' })
  is_highlight?: boolean;

  @ApiProperty({ enum: ProductCategory, example: ProductCategory.BURGER })
  @Transform(({ value }) => toSlug(value))
  @IsEnum(ProductCategory, {
    message: `Categoria inválida. Use: ${CATEGORIES}.`,
  })
  category: ProductCategory;

  @ApiPropertyOptional({ example: true, default: true })
  @Transform(({ value }) => toBoolean(value))
  @IsOptionalNotNull()
  @IsBoolean({ message: 'available deve ser verdadeiro ou falso.' })
  available?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Nome de um arquivo enviado em POST /uploads ou URL http(s). Se a requisição trouxer o arquivo no campo "file", ele prevalece.',
  })
  @Transform(({ value }) => toImageRef(value))
  @IsOptional()
  @IsText(IMAGE_REF_RULES)
  image?: string | null;

  @ApiPropertyOptional({
    type: [String],
    example: ['Pão brioche', 'Blend 180g', 'Cheddar'],
    description:
      'Lista (JSON), texto separado por vírgulas ou o campo repetido no FormData. Vazio limpa a lista.',
  })
  @Transform(({ value }) => toStringArray(value))
  @IsOptional()
  @IsText(
    {
      maxLength: 60,
      invalid: 'Cada ingrediente deve ser um texto.',
      tooLong: 'Cada ingrediente pode ter no máximo 60 caracteres.',
    },
    { each: true },
  )
  @ArrayMaxSize(50, { message: 'Informe no máximo 50 ingredientes.' })
  @IsArray({ message: 'ingredients deve ser uma lista de ingredientes.' })
  ingredients?: string[];

  @ApiPropertyOptional({
    type: [Number],
    example: [1, 2],
    description:
      'Ids dos adicionais permitidos: lista (JSON), "1,2" ou o campo repetido no FormData. Vazio remove todos.',
  })
  @Transform(({ value }) => toIntArray(value))
  @IsOptional()
  @IsNumberInRange(
    {
      min: 1,
      max: MAX_DB_INT,
      integer: true,
      invalid: 'allowed_addons_ids deve conter apenas ids de adicionais.',
      // Fora de 1..2147483647 (coluna integer): mesma mensagem dos ids na URL
      tooLow: 'Id inválido.',
      tooHigh: 'Id inválido.',
    },
    { each: true },
  )
  @ArrayMaxSize(200, { message: 'Informe no máximo 200 adicionais.' })
  @IsArray({ message: 'allowed_addons_ids deve ser uma lista de ids.' })
  allowed_addons_ids?: number[];
}
