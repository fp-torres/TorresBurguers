import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';
import { emptyToNull, toNumber, trimString } from '../../common/transforms';
import { IsNumberInRange, IsText } from '../../common/validators';

/** Siglas das 27 unidades federativas. */
export const UFS =
  'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(
    ' ',
  );

const INVALID_ZIP = 'CEP inválido. Informe os 8 dígitos (ex.: 22041-001).';

/** CEP: mantém só os dígitos ("22041-001" → "22041001"). */
function toZipCode(value: unknown): unknown {
  if (typeof value === 'number') return String(value).padStart(8, '0');
  return typeof value === 'string' ? value.replace(/\D/g, '') : value;
}

/** Sigla da UF em maiúsculas ("rj " → "RJ"). */
function toUf(value: unknown): unknown {
  const text = trimString(value);
  return typeof text === 'string' ? text.toUpperCase() : text;
}

/** Endereço de entrega do cliente (sempre vinculado a quem está logado). */
export class CreateAddressDto {
  @ApiPropertyOptional({ example: 'Casa', maxLength: 50, nullable: true })
  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @IsText({
    maxLength: 50,
    invalid: 'O apelido deve ser um texto.',
    tooLong: 'O apelido pode ter no máximo 50 caracteres.',
  })
  nickname?: string | null;

  @ApiProperty({ example: '22041-001', description: 'CEP com ou sem traço.' })
  @Transform(({ value }) => toZipCode(value))
  @IsText({
    maxLength: 8,
    pattern: /^\d{8}$/,
    required: INVALID_ZIP,
    invalid: INVALID_ZIP,
    tooLong: INVALID_ZIP,
  })
  zipCode: string;

  @ApiProperty({ example: 'Av. Atlântica', maxLength: 150 })
  @Transform(({ value }) => trimString(value))
  @IsText({
    maxLength: 150,
    required: 'Informe a rua.',
    invalid: 'A rua deve ser um texto.',
    tooLong: 'A rua pode ter no máximo 150 caracteres.',
  })
  street: string;

  @ApiProperty({
    example: '1500',
    description: 'Número do imóvel (aceita "S/N").',
  })
  @Transform(({ value }) =>
    typeof value === 'number' ? String(value) : trimString(value),
  )
  @IsText({
    maxLength: 20,
    required: 'Informe o número.',
    invalid: 'O número deve ser um texto.',
    tooLong: 'O número pode ter no máximo 20 caracteres.',
  })
  number: string;

  @ApiPropertyOptional({ example: 'Apto 202', maxLength: 100, nullable: true })
  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @IsText({
    maxLength: 100,
    invalid: 'O complemento deve ser um texto.',
    tooLong: 'O complemento pode ter no máximo 100 caracteres.',
  })
  complement?: string | null;

  @ApiProperty({ example: 'Copacabana', maxLength: 100 })
  @Transform(({ value }) => trimString(value))
  @IsText({
    maxLength: 100,
    required: 'Informe o bairro.',
    invalid: 'O bairro deve ser um texto.',
    tooLong: 'O bairro pode ter no máximo 100 caracteres.',
  })
  neighborhood: string;

  @ApiProperty({ example: 'Rio de Janeiro', maxLength: 100 })
  @Transform(({ value }) => trimString(value))
  @IsText({
    maxLength: 100,
    required: 'Informe a cidade.',
    invalid: 'A cidade deve ser um texto.',
    tooLong: 'A cidade pode ter no máximo 100 caracteres.',
  })
  city: string;

  @ApiProperty({ example: 'RJ', description: 'Sigla da UF (2 letras).' })
  @Transform(({ value }) => toUf(value))
  @IsIn(UFS, {
    message: 'UF inválida. Use a sigla do estado com 2 letras (ex.: RJ).',
  })
  state: string;

  @ApiPropertyOptional({ example: -22.9711, nullable: true })
  @Transform(({ value }) => toNumber(value))
  @IsOptional()
  @IsNumberInRange({ min: -90, max: 90, invalid: 'Latitude inválida.' })
  latitude?: number | null;

  @ApiPropertyOptional({ example: -43.1822, nullable: true })
  @Transform(({ value }) => toNumber(value))
  @IsOptional()
  @IsNumberInRange({ min: -180, max: 180, invalid: 'Longitude inválida.' })
  longitude?: number | null;
}
