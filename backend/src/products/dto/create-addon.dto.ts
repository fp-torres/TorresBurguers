import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import {
  emptyToNull,
  toBoolean,
  toImageRef,
  toMoney,
  toSlug,
  trimString,
} from '../../common/transforms';
import {
  IsNumberInRange,
  IsOptionalNotNull,
  IsText,
} from '../../common/validators';
import { IMAGE_REF_RULES, MAX_PRICE } from './create-product.dto';

/** Categoria padrão dos adicionais (mesmo default da coluna). */
export const DEFAULT_ADDON_CATEGORY = 'geral';

/** Cadastro de adicional (JSON). */
export class CreateAddonDto {
  @ApiProperty({ example: 'Bacon extra', maxLength: 60 })
  @Transform(({ value }) => trimString(value))
  @IsText({
    maxLength: 60,
    required: 'O nome do adicional é obrigatório.',
    invalid: 'O nome do adicional deve ser um texto.',
    tooLong: 'O nome do adicional pode ter no máximo 60 caracteres.',
  })
  name: string;

  @ApiProperty({ example: 4.5, minimum: 0 })
  @Transform(({ value }) => toMoney(value))
  @IsNumberInRange({
    min: 0,
    max: MAX_PRICE,
    invalid: 'Informe um preço válido para o adicional (ex.: 4.50).',
    tooLow: 'O preço do adicional não pode ser negativo.',
    tooHigh: 'Preço do adicional acima do limite permitido.',
  })
  price: number;

  @ApiPropertyOptional({ example: 'Fatias de bacon crocante', nullable: true })
  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @IsText({
    maxLength: 255,
    invalid: 'A descrição do adicional deve ser um texto.',
    tooLong: 'A descrição do adicional pode ter no máximo 255 caracteres.',
  })
  description?: string | null;

  @ApiPropertyOptional({
    example: DEFAULT_ADDON_CATEGORY,
    default: DEFAULT_ADDON_CATEGORY,
    description: 'Agrupamento livre (ex.: geral, hamburgueres, bebidas).',
  })
  @Transform(({ value }) => toSlug(value ?? '') || DEFAULT_ADDON_CATEGORY)
  @IsOptionalNotNull()
  @IsText({
    maxLength: 40,
    invalid: 'A categoria do adicional deve ser um texto.',
    tooLong: 'A categoria pode ter no máximo 40 caracteres.',
  })
  category?: string;

  @ApiPropertyOptional({ example: true, default: true })
  @Transform(({ value }) => toBoolean(value))
  @IsOptionalNotNull()
  @IsBoolean({ message: 'available deve ser verdadeiro ou falso.' })
  available?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Nome de um arquivo enviado em POST /uploads ou URL http(s).',
  })
  @Transform(({ value }) => toImageRef(value))
  @IsOptional()
  @IsText(IMAGE_REF_RULES)
  image?: string | null;
}
