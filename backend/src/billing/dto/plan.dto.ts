import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import {
  emptyToNull,
  toBoolean,
  toMoney,
  toNumber,
  trimString,
} from '../../common/transforms';
import {
  IsNumberInRange,
  IsOptionalNotNull,
  IsText,
  MAX_DB_INT,
} from '../../common/validators';
import { StoreListQueryDto } from '../../store/dto/store-list-query.dto';
import {
  BillingInterval,
  PlanStatus,
  type PlanFeatures,
} from '../entities/plan.entity';
import { PLAN_FEATURE_KEYS } from '../plan-rules';

/** Maior preço de plano aceito (cabe com folga no numeric(10,2) do banco). */
export const MAX_PLAN_PRICE = 999_999.99;
export const MAX_TRIAL_DAYS = 365;
export const MAX_SORT_ORDER = 100_000;
/** Código estável do plano: minúsculas, números e hífens (1 a 40), sem hífen nas pontas. */
export const PLAN_CODE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

const FEATURE_LIST = PLAN_FEATURE_KEYS.join(', ');

/** Texto sem espaços nas pontas e em minúsculas (código do plano, enums). */
function lowerTrim(value: unknown): unknown {
  const text = trimString(value);
  return typeof text === 'string' ? text.toLowerCase() : text;
}

function upperTrim(value: unknown): unknown {
  const text = trimString(value);
  return typeof text === 'string' ? text.toUpperCase() : text;
}

/** Problema do objeto de recursos (null = válido): só chaves conhecidas, com true/false. */
export function planFeaturesProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return `features deve ser um objeto com os recursos (${FEATURE_LIST}) marcados como true ou false.`;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!(PLAN_FEATURE_KEYS as string[]).includes(key)) {
      return `Recurso desconhecido: "${key.slice(0, 40)}". Use: ${FEATURE_LIST}.`;
    }
    if (typeof item !== 'boolean') {
      return `O recurso ${key} deve ser true ou false.`;
    }
  }
  return null;
}

/** Recursos do plano: lista fechada (online_payments, advanced_reports, custom_branding). */
export function IsPlanFeatures(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isPlanFeatures',
      target: target.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate: (value: unknown) => planFeaturesProblem(value) === null,
        defaultMessage: ({ value }: ValidationArguments) =>
          planFeaturesProblem(value) ?? 'Recursos do plano inválidos.',
      },
    });
  };
}

/** Limite opcional do plano: inteiro ≥ 1 ou null (ilimitado). */
function limitRules(label: string) {
  return {
    min: 1,
    max: MAX_DB_INT,
    integer: true,
    invalid: `O limite de ${label} deve ser um número inteiro a partir de 1 (ou null para ilimitado).`,
  };
}

/**
 * POST /platform/plans. Nenhum preço é fixo no código: tudo vem do superpainel.
 * Limites nulos (ou ausentes) = ilimitado; recursos ausentes = desligados.
 */
export class CreatePlanDto {
  @ApiProperty({
    example: 'essencial',
    maxLength: 40,
    description: 'Identificador estável: minúsculas, números e hífens.',
  })
  @Transform(({ value }) => lowerTrim(value))
  @IsText({
    maxLength: 40,
    required: 'O código do plano é obrigatório.',
    invalid:
      'Código do plano inválido: use letras minúsculas, números e hífens (ex.: essencial, pro-anual).',
    tooLong: 'O código do plano pode ter no máximo 40 caracteres.',
    pattern: PLAN_CODE_PATTERN,
  })
  code: string;

  @ApiProperty({ example: 'Essencial', maxLength: 80 })
  @Transform(({ value }) => trimString(value))
  @IsText({
    maxLength: 80,
    required: 'O nome do plano é obrigatório.',
    invalid: 'O nome do plano deve ser um texto.',
    tooLong: 'O nome do plano pode ter no máximo 80 caracteres.',
  })
  name: string;

  @ApiPropertyOptional({
    example: 'Para quem está começando: cardápio, pedidos e entregas.',
    nullable: true,
    maxLength: 1000,
  })
  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @IsText({
    maxLength: 1000,
    invalid: 'A descrição deve ser um texto.',
    tooLong: 'A descrição pode ter no máximo 1000 caracteres.',
  })
  description?: string | null;

  @ApiProperty({
    example: 99.9,
    minimum: 0,
    description: 'Preço por período em reais (2 casas). 0 = plano gratuito.',
  })
  @Transform(({ value }) => toMoney(value))
  @IsNumberInRange({
    min: 0,
    max: MAX_PLAN_PRICE,
    invalid: 'Informe um preço válido (ex.: 99.90).',
    tooLow: 'O preço não pode ser negativo.',
    tooHigh: 'Preço acima do limite permitido.',
  })
  price: number;

  @ApiPropertyOptional({
    enum: BillingInterval,
    default: BillingInterval.MONTHLY,
  })
  @Transform(({ value }) => upperTrim(value))
  @IsOptionalNotNull()
  @IsEnum(BillingInterval, {
    message: 'Periodicidade inválida. Use MONTHLY (mensal) ou YEARLY (anual).',
  })
  billing_interval?: BillingInterval;

  @ApiPropertyOptional({
    example: 14,
    minimum: 0,
    maximum: MAX_TRIAL_DAYS,
    default: 0,
  })
  @Transform(({ value }) => toNumber(value))
  @IsOptionalNotNull()
  @IsNumberInRange({
    min: 0,
    max: MAX_TRIAL_DAYS,
    integer: true,
    invalid: `Os dias de teste grátis devem ser um número inteiro de 0 a ${MAX_TRIAL_DAYS}.`,
  })
  trial_days?: number;

  @ApiPropertyOptional({ example: 5, minimum: 1, nullable: true })
  @Transform(({ value }) => toNumber(value))
  @IsOptional()
  @IsNumberInRange(limitRules('usuários da equipe'))
  max_staff_users?: number | null;

  @ApiPropertyOptional({ example: 100, minimum: 1, nullable: true })
  @Transform(({ value }) => toNumber(value))
  @IsOptional()
  @IsNumberInRange(limitRules('produtos'))
  max_products?: number | null;

  @ApiPropertyOptional({ example: 1000, minimum: 1, nullable: true })
  @Transform(({ value }) => toNumber(value))
  @IsOptional()
  @IsNumberInRange(limitRules('pedidos por mês'))
  max_monthly_orders?: number | null;

  @ApiPropertyOptional({
    example: 500,
    minimum: 1,
    nullable: true,
    description:
      'Armazenamento das imagens da loja, em MB (1 MB = 1.048.576 bytes); null = ilimitado. Fotos de perfil não contam.',
  })
  @Transform(({ value }) => toNumber(value))
  @IsOptional()
  @IsNumberInRange(limitRules('armazenamento (MB)'))
  max_storage_mb?: number | null;

  @ApiPropertyOptional({
    example: {
      online_payments: true,
      advanced_reports: false,
      custom_branding: true,
    },
    description: `Recursos liberados (somente ${FEATURE_LIST}). Na edição, só as chaves enviadas mudam.`,
  })
  @IsOptionalNotNull()
  @IsPlanFeatures()
  features?: PlanFeatures;

  @ApiPropertyOptional({ enum: PlanStatus, default: PlanStatus.ACTIVE })
  @Transform(({ value }) => upperTrim(value))
  @IsOptionalNotNull()
  @IsEnum(PlanStatus, {
    message:
      'Situação do plano inválida. Use ACTIVE (disponível) ou INACTIVE (indisponível para novas contratações).',
  })
  status?: PlanStatus;

  @ApiPropertyOptional({
    example: true,
    default: true,
    description: 'Aparece na página pública de planos.',
  })
  @Transform(({ value }) => toBoolean(value))
  @IsOptionalNotNull()
  @IsBoolean({ message: 'is_public deve ser verdadeiro ou falso.' })
  is_public?: boolean;

  @ApiPropertyOptional({ example: 10, minimum: 0, default: 0 })
  @Transform(({ value }) => toNumber(value))
  @IsOptionalNotNull()
  @IsNumberInRange({
    min: 0,
    max: MAX_SORT_ORDER,
    integer: true,
    invalid: `A ordem de exibição deve ser um número inteiro de 0 a ${MAX_SORT_ORDER}.`,
  })
  sort_order?: number;
}

/**
 * PATCH /platform/plans/:id: envie só o que mudou. null é recusado nos campos obrigatórios e aceito
 * na descrição e nos limites (null = ilimitado). Planos nunca são apagados: desative (status INACTIVE).
 */
export class UpdatePlanDto extends PartialType(CreatePlanDto, {
  skipNullProperties: false,
}) {}

/** GET /platform/plans: ?status=&is_public=&search=&page=&pageSize= */
export class PlanListQueryDto extends StoreListQueryDto {
  @ApiPropertyOptional({ enum: PlanStatus })
  @Transform(({ value }) => upperTrim(emptyToNull(value) ?? undefined))
  @IsOptional()
  @IsEnum(PlanStatus, {
    message: 'Situação do plano inválida. Use ACTIVE ou INACTIVE.',
  })
  status?: PlanStatus;

  @ApiPropertyOptional({ example: true })
  @Transform(({ value }) => toBoolean(value))
  @IsOptional()
  @IsBoolean({ message: 'is_public deve ser verdadeiro ou falso.' })
  is_public?: boolean;
}
