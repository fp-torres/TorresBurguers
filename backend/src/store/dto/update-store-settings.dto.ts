import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { UFS } from '../../addresses/dto/create-address.dto';
import {
  emptyToNull,
  toBoolean,
  toNumber,
  trimString,
} from '../../common/transforms';
import {
  IsNumberInRange,
  IsOptionalNotNull,
  IsText,
} from '../../common/validators';
import type { StoreDeliveryZonesConfig } from '../../orders/order-rules';
import type { OpeningHoursEntry } from '../entities/store.entity';
import { parseStoreDeliverySettings } from '../../orders/store-delivery-settings';
import { MAX_OPENING_HOURS_ENTRIES, parseOpeningHours } from '../store-rules';
import {
  IsParsedBy,
  IsStoreDocument,
  IsStoreEmail,
  IsTimeZone,
  normalizedBy,
  toDocument,
  toEmail,
  toPhone,
  toTimeZone,
  toUpper,
  toZipCode,
} from './store-validators';

const INVALID_ZIP = 'CEP inválido. Informe os 8 dígitos (ex.: 20040-003).';
const INVALID_PHONE =
  'Telefone inválido. Informe o DDD e o número (10 ou 11 dígitos).';
const INVALID_COLOR = 'Cor inválida. Use o formato #RRGGBB (ex.: #E11D48).';

/** Campos opcionais de texto: vazio ou null limpa o valor gravado. */
function OptionalText(field: string, maxLength: number) {
  return IsText({
    maxLength,
    invalid: `${field} deve ser um texto.`,
    tooLong: `${field} pode ter no máximo ${maxLength} caracteres.`,
  });
}

/**
 * PATCH /store/settings (ADMIN): envie só o que mudou. Em campos opcionais, texto vazio ou null limpa.
 * Não editáveis aqui (400 se enviados): slug, situação na plataforma, domínio próprio, responsável,
 * logo (POST/DELETE /store/logo), credenciais de pagamento (/store/settings/payments) e abertura
 * da loja (/store/status).
 */
export class UpdateStoreSettingsDto {
  // --- Dados comerciais ---

  @ApiPropertyOptional({ example: 'Lanchonete do Bairro', maxLength: 120 })
  @Transform(({ value }) => trimString(value))
  @IsOptionalNotNull()
  @IsText({
    maxLength: 120,
    required: 'Informe o nome da loja.',
    invalid: 'O nome da loja deve ser um texto.',
    tooLong: 'O nome da loja pode ter no máximo 120 caracteres.',
  })
  name?: string;

  @ApiPropertyOptional({ example: 'Lanchonete do Bairro LTDA', nullable: true })
  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @OptionalText('A razão social', 160)
  legal_name?: string | null;

  @ApiPropertyOptional({
    example: '11.222.333/0001-81',
    nullable: true,
    description:
      'CPF (11 dígitos) ou CNPJ (14 caracteres, inclusive o alfanumérico), com ou sem pontuação. Gravado sem pontuação.',
  })
  @Transform(({ value }) => toDocument(value))
  @IsOptional()
  @IsStoreDocument()
  document?: string | null;

  @ApiPropertyOptional({ example: 'contato@lanchonete.com.br', nullable: true })
  @Transform(({ value }) => toEmail(value))
  @IsOptional()
  @IsStoreEmail(160)
  email?: string | null;

  @ApiPropertyOptional({
    example: '(21) 99999-9999',
    nullable: true,
    description: 'Gravado só com os dígitos (DDD + número).',
  })
  @Transform(({ value }) => toPhone(value))
  @IsOptional()
  @IsText({
    maxLength: 11,
    pattern: /^\d{10,11}$/,
    invalid: INVALID_PHONE,
    tooLong: INVALID_PHONE,
  })
  phone?: string | null;

  @ApiPropertyOptional({
    example: 'Hambúrgueres artesanais desde 2010.',
    nullable: true,
  })
  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @OptionalText('A descrição', 300)
  description?: string | null;

  // --- Endereço ---

  @ApiPropertyOptional({ example: '20040-003', nullable: true })
  @Transform(({ value }) => toZipCode(value))
  @IsOptional()
  @IsText({
    maxLength: 8,
    pattern: /^\d{8}$/,
    invalid: INVALID_ZIP,
    tooLong: INVALID_ZIP,
  })
  address_zip_code?: string | null;

  @ApiPropertyOptional({ example: 'Av. Rio Branco', nullable: true })
  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @OptionalText('A rua', 160)
  address_street?: string | null;

  @ApiPropertyOptional({ example: '156', nullable: true })
  @Transform(({ value }) =>
    typeof value === 'number' ? String(value) : emptyToNull(value),
  )
  @IsOptional()
  @OptionalText('O número', 20)
  address_number?: string | null;

  @ApiPropertyOptional({ example: 'Loja B', nullable: true })
  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @OptionalText('O complemento', 80)
  address_complement?: string | null;

  @ApiPropertyOptional({ example: 'Centro', nullable: true })
  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @OptionalText('O bairro', 80)
  address_neighborhood?: string | null;

  @ApiPropertyOptional({ example: 'Rio de Janeiro', nullable: true })
  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @OptionalText('A cidade', 80)
  address_city?: string | null;

  @ApiPropertyOptional({ example: 'RJ', nullable: true })
  @Transform(({ value }) => toUpper(value))
  @IsOptional()
  @IsIn(UFS, {
    message: 'UF inválida. Use a sigla do estado com 2 letras (ex.: RJ).',
  })
  address_state?: string | null;

  @ApiPropertyOptional({
    example: -22.9035,
    nullable: true,
    description:
      'Local da loja no mapa (graus decimais): ponto de partida da entrega por distância. Envie latitude e longitude juntas; null limpa (não pode faltar no modo por distância).',
  })
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

  // --- Operação e vitrine ---

  @ApiPropertyOptional({ example: 'Bem-vindo! Peça já o seu.', nullable: true })
  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @OptionalText('A mensagem de loja aberta', 200)
  opening_message?: string | null;

  @ApiPropertyOptional({ example: 'Voltamos amanhã às 18h.', nullable: true })
  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @OptionalText('A mensagem de loja fechada', 200)
  closing_message?: string | null;

  @ApiPropertyOptional({ example: true })
  @Transform(({ value }) => toBoolean(value))
  @IsOptionalNotNull()
  @IsBoolean({ message: 'delivery_enabled deve ser verdadeiro ou falso.' })
  delivery_enabled?: boolean;

  @ApiPropertyOptional({ example: true })
  @Transform(({ value }) => toBoolean(value))
  @IsOptionalNotNull()
  @IsBoolean({ message: 'takeout_enabled deve ser verdadeiro ou falso.' })
  takeout_enabled?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Taxas e prazos por bairro ou faixa de CEP: { "fallback": { "fee": 12, "time": "50-60 min" }, "zones": [{ "neighborhoods": ["Centro"], "cities": ["Rio de Janeiro"], "zip_ranges": [{ "from": "20000-000", "to": "20099-999" }], "fee": 5, "time": "30-40 min" }], "outside_zones": "fallback" }. ' +
      'Cada zona precisa de bairros e/ou faixas de CEP; "cities" é opcional (restringe os bairros). Vale a primeira zona com o bairro (conferido pelo CEP) ou com o CEP. ' +
      '"outside_zones": "fallback" (padrão: endereço fora das zonas paga o "fallback") ou "refuse" (a loja recusa: 400 "Este endereço está fora da área de entrega da loja."). ' +
      '"fallback" é obrigatório, exceto com "refuse" (que exige pelo menos uma zona). null remove as zonas próprias. ' +
      'Opcionais (em reais, sobre o subtotal dos itens com as promoções, sem a taxa): "min_order" (pedido mínimo da entrega; 0 = sem mínimo), ' +
      '"free_delivery_above" (frete grátis a partir deste subtotal), "min_order_takeout" (true = o mínimo vale também na retirada) e, em cada zona, ' +
      '"min_order" e "free_delivery_above" próprios (ausentes = os da loja). ' +
      'Modo de cobrança (opcional): "mode": "zones" (padrão, por bairro/CEP) ou "distance" (por km a partir de latitude/longitude da loja) com ' +
      '"distance": { "bands": [{ "up_to_km": 2, "fee": 5, "time": "25-35 min", "min_order"?, "free_delivery_above"? }], "max_km"?, "extra_km_fee"?, "route_factor"? (1 a 3, padrão 1.3), "road_distance"? }. ' +
      'No modo distância, "zones" pode ficar vazia e "fallback"/"outside_zones" valem além do raio ou para endereços não localizados.',
    example: {
      fallback: { fee: 12, time: '50-60 min' },
      zones: [
        {
          neighborhoods: ['Centro', 'Lapa'],
          fee: 5,
          time: '30-40 min',
          free_delivery_above: 40,
        },
      ],
      outside_zones: 'fallback',
      min_order: 25,
      free_delivery_above: 60,
    },
  })
  @Transform(normalizedBy(parseStoreDeliverySettings))
  @IsOptional()
  @IsParsedBy(parseStoreDeliverySettings, 'Zonas de entrega inválidas')
  delivery_zones?: StoreDeliveryZonesConfig | null;

  @ApiPropertyOptional({
    example: '15-20 min',
    nullable: true,
    description: 'Prazo da retirada no balcão. null = padrão da plataforma.',
  })
  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @OptionalText('O prazo da retirada', 20)
  takeout_estimate?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: `Até ${MAX_OPENING_HOURS_ENTRIES} horários { day: 0 (domingo) a 6 (sábado), open: "HH:MM", close: "HH:MM" }. Fechamento antes da abertura = vira a madrugada. null ou [] remove.`,
    example: [{ day: 2, open: '18:00', close: '23:30' }],
  })
  @Transform(normalizedBy(parseOpeningHours))
  @IsOptional()
  @IsParsedBy(parseOpeningHours, 'Horários de funcionamento inválidos')
  opening_hours?: OpeningHoursEntry[] | null;

  @ApiPropertyOptional({
    example: 'America/Sao_Paulo',
    description: 'Fuso do "hoje", dos relatórios e dos horários da loja.',
  })
  @Transform(({ value }) => toTimeZone(value))
  @IsOptionalNotNull()
  @IsTimeZone()
  time_zone?: string;

  // --- Identidade visual (exige o recurso custom_branding do plano) ---

  @ApiPropertyOptional({ example: '#E11D48', nullable: true })
  @Transform(({ value }) => toUpper(value))
  @IsOptional()
  @IsText({
    maxLength: 7,
    pattern: /^#[0-9A-F]{6}$/,
    invalid: INVALID_COLOR,
    tooLong: INVALID_COLOR,
  })
  primary_color?: string | null;
}

/** Campos do DTO, na ordem: a lista de permitidos usada no serviço. */
export const STORE_SETTINGS_FIELDS = [
  'name',
  'legal_name',
  'document',
  'email',
  'phone',
  'description',
  'address_zip_code',
  'address_street',
  'address_number',
  'address_complement',
  'address_neighborhood',
  'address_city',
  'address_state',
  'latitude',
  'longitude',
  'opening_message',
  'closing_message',
  'delivery_enabled',
  'takeout_enabled',
  'delivery_zones',
  'takeout_estimate',
  'opening_hours',
  'time_zone',
  'primary_color',
] as const satisfies readonly (keyof UpdateStoreSettingsDto)[];

export type StoreSettingsField = (typeof STORE_SETTINGS_FIELDS)[number];
