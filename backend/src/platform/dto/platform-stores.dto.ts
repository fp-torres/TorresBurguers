import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsEmail,
  IsOptional,
  MaxLength,
  ValidateNested,
} from 'class-validator';
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
import { StoreListQueryDto } from '../../store/dto/store-list-query.dto';
import { UpdateStoreSettingsDto } from '../../store/dto/update-store-settings.dto';
import { StoreAccountStatus } from '../../store/entities/store.entity';
import { NormalizeEmail } from '../../users/dto/transforms';
import {
  CUSTOM_DOMAIN_NOT_ROUTED_NOTICE,
  normalizeCustomDomain,
  normalizeSlugInput,
} from '../store-identity-rules';
import { STATUS_REASON_MAX_LENGTH } from '../store-status-rules';
import {
  idRules,
  IsCustomDomain,
  IsNestedObject,
  IsStoreSlug,
  OptionalQueryBoolean,
  OptionalQueryChoice,
  OptionalQueryDate,
  OptionalQueryId,
} from './platform-validators';

/** Dados cadastrais que o superpainel informa na criação e na edição da loja. */
export const STORE_PROFILE_FIELDS = [
  'legal_name',
  'document',
  'email',
  'phone',
  'address_zip_code',
  'address_street',
  'address_number',
  'address_complement',
  'address_neighborhood',
  'address_city',
  'address_state',
] as const;

export type StoreProfileField = (typeof STORE_PROFILE_FIELDS)[number];

/**
 * Mesmas regras de PATCH /store/settings: CPF/CNPJ com dígitos verificadores (gravado sem pontuação),
 * telefone e CEP só com dígitos, UF válida, textos com tamanho máximo. Vazio ou null limpa o campo.
 */
export class StoreProfileDto extends PickType(
  UpdateStoreSettingsDto,
  STORE_PROFILE_FIELDS,
) {}

const STORE_NAME_RULES = {
  maxLength: 120,
  required: 'Informe o nome do estabelecimento.',
  invalid: 'O nome do estabelecimento deve ser um texto.',
  tooLong: 'O nome do estabelecimento pode ter no máximo 120 caracteres.',
};

const SLUG_DESCRIPTION =
  'Endereço da loja (/loja/<slug>): 3 a 60 caracteres, minúsculas, números e hífens, sem hífen nas pontas. ' +
  'Endereços reservados pela plataforma (admin, api, platform, default, signup...) são recusados.';

/** Responsável pela loja: recebe um convite de ADMIN que o torna responsável ao ser aceito. */
export class PlatformStoreOwnerDto {
  @ApiProperty({
    example: 'dono@lanchonete.com.br',
    description:
      'E-mail sem conta na plataforma (a conta é criada ao aceitar o convite).',
  })
  @NormalizeEmail()
  @IsEmail(
    {},
    { message: 'Informe um e-mail válido para o responsável (owner.email).' },
  )
  @MaxLength(160, {
    message: 'O e-mail do responsável pode ter no máximo 160 caracteres.',
  })
  email: string;

  @ApiPropertyOptional({
    example: 'Maria Silva',
    maxLength: 50,
    description:
      'Só para referência (auditoria): a pessoa informa o próprio nome ao aceitar o convite.',
  })
  @Transform(({ value }) => emptyToNull(value) ?? undefined)
  @IsOptional()
  @IsText({
    maxLength: 50,
    invalid: 'O nome do responsável deve ser um texto.',
    tooLong: 'O nome do responsável pode ter no máximo 50 caracteres.',
  })
  name?: string;
}

/**
 * POST /platform/stores: cria a loja (ACTIVE, fechada, entrega desligada, retirada ligada) com a
 * assinatura do plano inicial, na mesma transação, e depois o convite do responsável (ADMIN).
 */
export class CreatePlatformStoreDto extends StoreProfileDto {
  @ApiProperty({ example: 'Lanchonete do Bairro', maxLength: 120 })
  @Transform(({ value }) => trimString(value))
  @IsText(STORE_NAME_RULES)
  name: string;

  @ApiProperty({
    example: 'lanchonete-do-bairro',
    description: SLUG_DESCRIPTION,
  })
  @Transform(({ value }) => normalizeSlugInput(value))
  @IsStoreSlug()
  slug: string;

  @ApiProperty({
    example: 2,
    description: 'Plano inicial: a assinatura é criada junto com a loja.',
  })
  @Transform(({ value }) => toNumber(value))
  @IsNumberInRange({
    ...idRules('plan_id'),
    invalid: 'Informe o plano inicial (plan_id) com um id válido.',
  })
  plan_id: number;

  @ApiPropertyOptional({
    default: false,
    description:
      'Permite um plano indisponível para novas contratações (INACTIVE), ex.: plano interno ou negociado.',
  })
  @Transform(({ value }) => toBoolean(value))
  @IsOptionalNotNull()
  @IsBoolean({ message: 'allow_inactive_plan deve ser verdadeiro ou falso.' })
  allow_inactive_plan?: boolean;

  @ApiProperty({ type: () => PlatformStoreOwnerDto })
  @IsDefined({ message: 'Informe o responsável pela loja (owner.email).' })
  // Lista não é objeto (o @ValidateNested validaria item a item e o serviço receberia um array)
  @IsNestedObject(
    'owner deve ser um objeto com o responsável pela loja (owner.email).',
  )
  @ValidateNested()
  @Type(() => PlatformStoreOwnerDto)
  owner: PlatformStoreOwnerDto;
}

/** PATCH /platform/stores/:id: envie só o que mudou. Situação: use as rotas suspend/reactivate/... */
export class UpdatePlatformStoreDto extends StoreProfileDto {
  @ApiPropertyOptional({ example: 'Lanchonete do Bairro', maxLength: 120 })
  @Transform(({ value }) => trimString(value))
  @IsOptionalNotNull()
  @IsText(STORE_NAME_RULES)
  name?: string;

  @ApiPropertyOptional({
    example: 'lanchonete-do-bairro',
    description: `${SLUG_DESCRIPTION} Mudar o endereço faz os links antigos deixarem de funcionar.`,
  })
  @Transform(({ value }) => normalizeSlugInput(value))
  @IsOptionalNotNull()
  @IsStoreSlug()
  slug?: string;

  @ApiPropertyOptional({
    example: 'pedidos.minhaloja.com.br',
    nullable: true,
    description: `Domínio próprio (único entre as lojas). ${CUSTOM_DOMAIN_NOT_ROUTED_NOTICE} Vazio ou null remove.`,
  })
  @Transform(({ value }) => normalizeCustomDomain(value))
  @IsOptional()
  @IsCustomDomain()
  custom_domain?: string | null;

  @ApiPropertyOptional({
    example: 12,
    nullable: true,
    description:
      'Responsável principal: um ADMIN ativo (fora da lixeira e não bloqueado) desta loja. null remove.',
  })
  @Transform(({ value }) => toNumber(value))
  @IsOptional()
  @IsNumberInRange(idRules('owner_user_id'))
  owner_user_id?: number | null;
}

/** POST /platform/stores/:id/suspend e /deactivate: motivo obrigatório. */
export class StoreStatusReasonDto {
  @ApiProperty({
    example: 'Solicitação do responsável: loja fechada para reforma.',
    maxLength: STATUS_REASON_MAX_LENGTH,
  })
  @Transform(({ value }) => trimString(value))
  @IsText({
    maxLength: STATUS_REASON_MAX_LENGTH,
    required:
      'Informe o motivo (ele aparece para a equipe da loja e fica na auditoria).',
    invalid: 'O motivo deve ser um texto.',
    tooLong: `O motivo pode ter no máximo ${STATUS_REASON_MAX_LENGTH} caracteres.`,
  })
  reason: string;
}

/** POST /platform/stores/:id/reactivate e /restore: observação opcional (vai só para a auditoria). */
export class StoreStatusNoteDto {
  @ApiPropertyOptional({
    maxLength: STATUS_REASON_MAX_LENGTH,
    nullable: true,
  })
  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @IsText({
    maxLength: STATUS_REASON_MAX_LENGTH,
    invalid: 'A observação deve ser um texto.',
    tooLong: `A observação pode ter no máximo ${STATUS_REASON_MAX_LENGTH} caracteres.`,
  })
  reason?: string | null;
}

export const STORE_SORT_FIELDS = ['created_at', 'name', 'slug'] as const;
export type StoreSortField = (typeof STORE_SORT_FIELDS)[number];

export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

/** Situação da assinatura nos filtros: as da assinatura + NONE (loja sem assinatura). */
export const STORE_SUBSCRIPTION_FILTERS = [
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'SUSPENDED',
  'CANCELED',
  'NONE',
] as const;
export type StoreSubscriptionFilter =
  (typeof STORE_SUBSCRIPTION_FILTERS)[number];

/**
 * GET /platform/stores: ?search=&account_status=&plan_id=&subscription_status=&sort=&order=&page=&pageSize=
 * (pageSize máx. 100).
 */
export class PlatformStoreListQueryDto extends StoreListQueryDto {
  @ApiPropertyOptional({ enum: StoreAccountStatus })
  @OptionalQueryChoice(
    Object.values(StoreAccountStatus),
    'Situação da loja inválida. Use ACTIVE, SUSPENDED ou INACTIVE.',
  )
  account_status?: StoreAccountStatus;

  @ApiPropertyOptional({
    example: 2,
    description: 'Plano da assinatura vigente (não cancelada).',
  })
  @OptionalQueryId('plan_id')
  plan_id?: number;

  @ApiPropertyOptional({
    enum: STORE_SUBSCRIPTION_FILTERS,
    description:
      'Situação da assinatura vigente. CANCELED = lojas cuja última assinatura foi cancelada (sem outra vigente); NONE = lojas sem assinatura.',
  })
  @OptionalQueryChoice(
    STORE_SUBSCRIPTION_FILTERS,
    'Situação da assinatura inválida. Use TRIALING, ACTIVE, PAST_DUE, SUSPENDED, CANCELED ou NONE.',
  )
  subscription_status?: StoreSubscriptionFilter;

  @ApiPropertyOptional({ enum: STORE_SORT_FIELDS, default: 'created_at' })
  @OptionalQueryChoice(
    STORE_SORT_FIELDS,
    'Ordenação inválida. Use created_at, name ou slug.',
    'lower',
  )
  sort?: StoreSortField;

  @ApiPropertyOptional({
    enum: SORT_ORDERS,
    description: 'Padrão: desc em created_at; asc em name e slug.',
  })
  @OptionalQueryChoice(SORT_ORDERS, 'Ordem inválida. Use asc ou desc.', 'lower')
  order?: SortOrder;
}

/** GET /platform/stores/:id/users: equipe da loja, inclusive a lixeira (padrão). */
export class PlatformStoreTeamQueryDto extends StoreListQueryDto {
  @ApiPropertyOptional({
    default: true,
    description: 'Inclui quem está na lixeira (padrão: true).',
  })
  @OptionalQueryBoolean('include_deleted')
  include_deleted?: boolean;
}

/** GET /platform/stores/:id/metrics?from=AAAA-MM-DD&to=AAAA-MM-DD (calendário da loja; até 366 dias). */
export class StoreMetricsQueryDto {
  @ApiPropertyOptional({
    example: '2026-10-01',
    description: 'Padrão: 30 dias antes de "to".',
  })
  @OptionalQueryDate('from')
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-31', description: 'Padrão: hoje.' })
  @OptionalQueryDate('to')
  to?: string;
}
