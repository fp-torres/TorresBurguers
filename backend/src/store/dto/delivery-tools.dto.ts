import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';
import { UFS } from '../../addresses/dto/create-address.dto';
import { emptyToNull, toNumber, trimString } from '../../common/transforms';
import { IsNumberInRange, IsText } from '../../common/validators';
import type { StoreDeliveryZonesConfig } from '../../orders/order-rules';
import { parseStoreDeliverySettings } from '../../orders/store-delivery-settings';
import {
  IsParsedBy,
  normalizedBy,
  toUpper,
  toZipCode,
} from './store-validators';

const INVALID_ZIP = 'CEP inválido. Informe os 8 dígitos (ex.: 20040-003).';

function OptionalText(field: string, maxLength: number) {
  return IsText({
    maxLength,
    invalid: `${field} deve ser um texto.`,
    tooLong: `${field} pode ter no máximo ${maxLength} caracteres.`,
  });
}

/** Endereço (CEP, rua, número, bairro, cidade e UF) usado pelas ferramentas de entrega do painel. */
class DeliveryToolAddressDto {
  @ApiPropertyOptional({ example: 'Av. Rio Branco', nullable: true })
  @Transform(({ value }) => emptyToNull(trimString(value)))
  @IsOptional()
  @OptionalText('A rua', 160)
  street?: string | null;

  @ApiPropertyOptional({ example: '100', nullable: true })
  @Transform(({ value }) =>
    typeof value === 'number' ? String(value) : emptyToNull(trimString(value)),
  )
  @IsOptional()
  @OptionalText('O número', 20)
  number?: string | null;

  @ApiPropertyOptional({ example: 'Centro', nullable: true })
  @Transform(({ value }) => emptyToNull(trimString(value)))
  @IsOptional()
  @OptionalText('O bairro', 100)
  neighborhood?: string | null;

  @ApiPropertyOptional({ example: 'Rio de Janeiro', nullable: true })
  @Transform(({ value }) => emptyToNull(trimString(value)))
  @IsOptional()
  @OptionalText('A cidade', 100)
  city?: string | null;

  @ApiPropertyOptional({ example: 'RJ', nullable: true })
  @Transform(({ value }) => toUpper(value))
  @IsOptional()
  @IsIn(UFS, {
    message: 'UF inválida. Use a sigla do estado com 2 letras (ex.: RJ).',
  })
  state?: string | null;
}

/**
 * POST /store/settings/geocode (ADMIN): localiza no mapa o endereço informado ou, sem CEP no corpo, o endereço
 * salvo da loja. Não grava nada: o painel mostra o ponto para a loja conferir e salvar.
 */
export class GeocodeStoreDto extends DeliveryToolAddressDto {
  @ApiPropertyOptional({
    example: '20040-003',
    nullable: true,
    description: 'Sem CEP: usa o endereço salvo da loja.',
  })
  @Transform(({ value }) => toZipCode(value))
  @IsOptional()
  @IsText({
    maxLength: 8,
    pattern: /^\d{8}$/,
    invalid: INVALID_ZIP,
    tooLong: INVALID_ZIP,
  })
  zip_code?: string | null;
}

/**
 * POST /store/settings/delivery-simulation (ADMIN): "teste um endereço" — distância, faixa (ou zona), taxa e
 * prazo para o endereço informado, com a configuração em edição (delivery_zones, latitude e longitude do
 * rascunho; ausentes = as salvas). Não grava nada.
 */
export class DeliverySimulationDto extends DeliveryToolAddressDto {
  @ApiProperty({ example: '20040-003' })
  @Transform(({ value }) => toZipCode(value))
  @IsText({
    maxLength: 8,
    pattern: /^\d{8}$/,
    required: 'Informe o CEP do endereço a testar.',
    invalid: INVALID_ZIP,
    tooLong: INVALID_ZIP,
  })
  zip_code: string;

  @ApiPropertyOptional({
    description:
      'Configuração de entrega em edição (o mesmo formato de PATCH /store/settings). Ausente = a salva.',
  })
  @Transform(normalizedBy(parseStoreDeliverySettings))
  @IsOptional()
  @IsParsedBy(parseStoreDeliverySettings, 'Zonas de entrega inválidas')
  delivery_zones?: StoreDeliveryZonesConfig | null;

  @ApiPropertyOptional({ example: -22.9035, nullable: true })
  @Transform(({ value }) => toNumber(value))
  @IsOptional()
  @IsNumberInRange({
    min: -90,
    max: 90,
    invalid: 'Latitude inválida: use um número de -90 a 90 (ex.: -22.9035).',
  })
  latitude?: number | null;

  @ApiPropertyOptional({ example: -43.2096, nullable: true })
  @Transform(({ value }) => toNumber(value))
  @IsOptional()
  @IsNumberInRange({
    min: -180,
    max: 180,
    invalid: 'Longitude inválida: use um número de -180 a 180 (ex.: -43.2096).',
  })
  longitude?: number | null;
}
