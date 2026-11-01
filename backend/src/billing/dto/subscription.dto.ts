import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsEmail,
  IsEnum,
  IsOptional,
  ValidateIf,
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
import { InvoiceStatus } from '../entities/subscription-invoice.entity';
import { SubscriptionStatus } from '../entities/subscription.entity';
import { MAX_PLAN_PRICE } from './plan.dto';

/** Data ISO 8601 (ex.: 2026-10-11 ou 2026-10-11T15:00:00Z). */
const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;

/** Texto ISO → Date. Vazio = ausente; inválido segue como veio para o @IsDate recusar. */
export function toDateValue(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (text === '') return undefined;
  if (!ISO_DATE.test(text)) return text;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : date;
}

function upperTrim(value: unknown): unknown {
  const text = trimString(value);
  return typeof text === 'string' ? text.toUpperCase() : text;
}

const dateMessage = (field: string) =>
  `${field} deve ser uma data ISO 8601 (ex.: 2026-10-11T15:00:00Z).`;

const PLAN_ID_RULES = {
  min: 1,
  max: MAX_DB_INT,
  integer: true,
  invalid: 'Informe o plano (plan_id) com um id válido.',
};

const OPTIONAL_REASON_RULES = {
  maxLength: 300,
  invalid: 'O motivo deve ser um texto.',
  tooLong: 'O motivo pode ter no máximo 300 caracteres.',
};

/** Motivo opcional (vai para o histórico da assinatura e para a auditoria). */
const OptionalReason = () =>
  applyDecorators(
    Transform(({ value }) => emptyToNull(value)),
    IsOptional(),
    IsText(OPTIONAL_REASON_RULES),
  );

/**
 * Motivo obrigatório (ações com impacto financeiro: anular/recusar fatura, cancelamento imediato).
 * Vazio ou só espaços conta como ausente.
 */
const RequiredReason = (required: string) =>
  applyDecorators(
    Transform(({ value }) => emptyToNull(value)),
    IsText({ ...OPTIONAL_REASON_RULES, required }),
  );

export const CANCEL_REASON_REQUIRED_MESSAGE =
  'Informe o motivo do cancelamento imediato.';
export const VOID_REASON_REQUIRED_MESSAGE = 'Informe o motivo da anulação.';
export const MARK_FAILED_REASON_REQUIRED_MESSAGE =
  'Informe o motivo da recusa do pagamento.';

// ---------------------------------------------------------------------------
// Listas do superpainel
// ---------------------------------------------------------------------------

/** GET /platform/subscriptions: ?status=&plan_id=&search= (nome ou slug da loja) &page=&pageSize= */
export class SubscriptionListQueryDto extends StoreListQueryDto {
  @ApiPropertyOptional({ enum: SubscriptionStatus })
  @Transform(({ value }) => upperTrim(emptyToNull(value) ?? undefined))
  @IsOptional()
  @IsEnum(SubscriptionStatus, {
    message:
      'Situação inválida. Use TRIALING, ACTIVE, PAST_DUE, SUSPENDED ou CANCELED.',
  })
  status?: SubscriptionStatus;

  @ApiPropertyOptional({ example: 2 })
  @Transform(({ value }) => toNumber(value) ?? undefined)
  @IsOptional()
  @IsNumberInRange(PLAN_ID_RULES)
  plan_id?: number;
}

/** GET /platform/invoices: ?status=&search= (nome ou slug da loja) &page=&pageSize= */
export class InvoiceListQueryDto extends StoreListQueryDto {
  @ApiPropertyOptional({ enum: InvoiceStatus })
  @Transform(({ value }) => upperTrim(emptyToNull(value) ?? undefined))
  @IsOptional()
  @IsEnum(InvoiceStatus, {
    message: 'Situação da fatura inválida. Use OPEN, PAID, FAILED ou VOID.',
  })
  status?: InvoiceStatus;
}

// ---------------------------------------------------------------------------
// Ações do superpainel
// ---------------------------------------------------------------------------

/** POST /platform/stores/:id/subscription — loja sem assinatura vigente. */
export class CreateStoreSubscriptionDto {
  @ApiProperty({ example: 2 })
  @Transform(({ value }) => toNumber(value))
  @IsNumberInRange(PLAN_ID_RULES)
  plan_id: number;

  @ApiPropertyOptional({
    example: false,
    description:
      'Permite um plano indisponível (INACTIVE), ex.: plano interno ou negociado.',
  })
  @Transform(({ value }) => toBoolean(value))
  @IsOptionalNotNull()
  @IsBoolean({ message: 'allow_inactive_plan deve ser verdadeiro ou falso.' })
  allow_inactive_plan?: boolean;

  @ApiPropertyOptional({ maxLength: 300, nullable: true })
  @OptionalReason()
  reason?: string | null;
}

/** POST /platform/subscriptions/:id/change-plan — mudança imediata, sem proporcionalidade. */
export class ChangePlanDto extends CreateStoreSubscriptionDto {}

/**
 * POST /platform/subscriptions/:id/cancel. Cancelar agora (at_period_end false/ausente) exige o motivo:
 * a loja deixa de vender na hora e faturas de períodos futuros são anuladas. O agendado (true) aceita
 * sem motivo; se a assinatura não tiver período a vencer, o cancelamento é imediato e o serviço também
 * exige o motivo.
 */
export class PlatformCancelSubscriptionDto {
  @ApiPropertyOptional({
    example: false,
    default: false,
    description:
      'true = cancela no fim do período pago; false = cancela agora. Plano sem período cancela agora.',
  })
  @Transform(({ value }) => toBoolean(value))
  @IsOptionalNotNull()
  @IsBoolean({ message: 'at_period_end deve ser verdadeiro ou falso.' })
  at_period_end?: boolean;

  @ApiPropertyOptional({
    maxLength: 300,
    nullable: true,
    description:
      'Obrigatório no cancelamento imediato (at_period_end false ou ausente).',
  })
  @Transform(({ value }) => emptyToNull(value))
  @ValidateIf(
    (dto: PlatformCancelSubscriptionDto) =>
      dto.at_period_end !== true ||
      (dto.reason !== undefined && dto.reason !== null),
  )
  @IsText({
    ...OPTIONAL_REASON_RULES,
    required: CANCEL_REASON_REQUIRED_MESSAGE,
  })
  reason?: string | null;
}

/** POST /platform/subscriptions/:id/suspend — motivo obrigatório (vai para o histórico). */
export class SuspendSubscriptionDto {
  @ApiProperty({
    example: 'Inadimplência negociada sem acordo',
    maxLength: 300,
  })
  @Transform(({ value }) => trimString(value))
  @IsText({
    maxLength: 300,
    required: 'Informe o motivo da suspensão.',
    invalid: 'O motivo deve ser um texto.',
    tooLong: 'O motivo pode ter no máximo 300 caracteres.',
  })
  reason: string;
}

/**
 * POST /platform/subscriptions/:id/reactivate. Sem force, só reativa se não houver fatura vencida
 * em aberto; com force (motivo obrigatório), reativa mesmo assim.
 */
export class ReactivateSubscriptionDto {
  @ApiPropertyOptional({ example: false, default: false })
  @Transform(({ value }) => toBoolean(value))
  @IsOptionalNotNull()
  @IsBoolean({ message: 'force deve ser verdadeiro ou falso.' })
  force?: boolean;

  @ApiPropertyOptional({ maxLength: 300, nullable: true })
  @OptionalReason()
  reason?: string | null;
}

/**
 * POST /platform/subscriptions/:id/invoices. Sem período: o período atual (se ainda não tiver
 * fatura) ou o seguinte. Sem valor: o preço do plano. Sem vencimento: o início do período (ou agora,
 * se ele já começou).
 */
export class CreateInvoiceDto {
  @ApiPropertyOptional({ example: 99.9, minimum: 0.01 })
  @Transform(({ value }) => toMoney(value))
  @IsOptionalNotNull()
  @IsNumberInRange({
    min: 0.01,
    max: MAX_PLAN_PRICE,
    invalid: 'Informe um valor válido (ex.: 99.90).',
    tooLow: 'O valor da fatura deve ser maior que zero.',
    tooHigh: 'Valor acima do limite permitido.',
  })
  amount?: number;

  @ApiPropertyOptional({ example: '2026-11-11T00:00:00Z' })
  @Transform(({ value }) => toDateValue(value))
  @IsOptionalNotNull()
  @IsDate({ message: dateMessage('period_start') })
  period_start?: Date;

  @ApiPropertyOptional({ example: '2026-12-11T00:00:00Z' })
  @Transform(({ value }) => toDateValue(value))
  @IsOptionalNotNull()
  @IsDate({ message: dateMessage('period_end') })
  period_end?: Date;

  @ApiPropertyOptional({ example: '2026-11-11T00:00:00Z' })
  @Transform(({ value }) => toDateValue(value))
  @IsOptionalNotNull()
  @IsDate({ message: dateMessage('due_at') })
  due_at?: Date;

  @ApiPropertyOptional({ maxLength: 300, nullable: true })
  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @IsText({
    maxLength: 300,
    invalid: 'As observações devem ser um texto.',
    tooLong: 'As observações podem ter no máximo 300 caracteres.',
  })
  notes?: string | null;
}

/** POST /platform/invoices/:id/mark-paid — registro manual do pagamento (idempotente). */
export class MarkInvoicePaidDto {
  @ApiPropertyOptional({
    example: '2026-10-11T15:00:00Z',
    description: 'Padrão: agora. Não pode estar no futuro.',
  })
  @Transform(({ value }) => toDateValue(value))
  @IsOptionalNotNull()
  @IsDate({ message: dateMessage('paid_at') })
  paid_at?: Date;

  @ApiPropertyOptional({ example: 'PIX', maxLength: 40, nullable: true })
  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @IsText({
    maxLength: 40,
    invalid: 'A forma de pagamento deve ser um texto.',
    tooLong: 'A forma de pagamento pode ter no máximo 40 caracteres.',
  })
  payment_method?: string | null;

  @ApiPropertyOptional({
    example: 'E1234567890',
    maxLength: 80,
    nullable: true,
    description:
      'Identificador do pagamento (comprovante/transação). Único: o mesmo pagamento nunca quita duas faturas.',
  })
  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @IsText({
    maxLength: 80,
    pattern: /^[\w.:/-]+$/,
    invalid:
      'Identificador do pagamento inválido: use letras, números, ponto, hífen, barra ou sublinhado.',
    tooLong: 'O identificador do pagamento pode ter no máximo 80 caracteres.',
  })
  provider_payment_id?: string | null;

  @ApiPropertyOptional({ maxLength: 300, nullable: true })
  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @IsText({
    maxLength: 300,
    invalid: 'As observações devem ser um texto.',
    tooLong: 'As observações podem ter no máximo 300 caracteres.',
  })
  notes?: string | null;
}

/** POST /platform/invoices/:id/mark-failed — motivo obrigatório (histórico + auditoria). */
export class MarkInvoiceFailedDto {
  @ApiProperty({ example: 'PIX não identificado', maxLength: 300 })
  @RequiredReason(MARK_FAILED_REASON_REQUIRED_MESSAGE)
  reason: string;
}

/** POST /platform/invoices/:id/void — motivo obrigatório (a fatura deixa de ser cobrada). */
export class VoidInvoiceDto {
  @ApiProperty({ example: 'Cobrança lançada em duplicidade', maxLength: 300 })
  @RequiredReason(VOID_REASON_REQUIRED_MESSAGE)
  reason: string;
}

// ---------------------------------------------------------------------------
// Painel da loja
// ---------------------------------------------------------------------------

/** POST /store/subscription/cancel — sempre no fim do período (plano sem período cancela agora). */
export class StoreCancelSubscriptionDto {
  @ApiPropertyOptional({ maxLength: 300, nullable: true })
  @OptionalReason()
  reason?: string | null;
}

/** POST /store/subscription/checkout */
export class SubscriptionCheckoutDto {
  @ApiPropertyOptional({
    example: 'financeiro@minhaloja.com.br',
    description:
      'E-mail da conta Mercado Pago que vai pagar (padrão: o e-mail de quem está logado).',
  })
  @Transform(({ value }) => {
    const text = emptyToNull(value);
    return typeof text === 'string' ? text.toLowerCase() : (text ?? undefined);
  })
  @IsOptional()
  @IsEmail({}, { message: 'Informe um e-mail válido para o pagamento.' })
  payer_email?: string;
}
