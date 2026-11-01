import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsOptional } from 'class-validator';
import { emptyToNull, trimString } from '../../common/transforms';
import { IsText } from '../../common/validators';
import { StoreListQueryDto } from '../../store/dto/store-list-query.dto';
import { UserRole } from '../../users/entities/user.entity';
import { SORT_ORDERS, type SortOrder } from './platform-stores.dto';
import {
  OptionalQueryBoolean,
  OptionalQueryChoice,
  OptionalQueryId,
  OptionalQueryInstant,
} from './platform-validators';

export const USER_SORT_FIELDS = [
  'created_at',
  'name',
  'email',
  'last_login_at',
] as const;
export type UserSortField = (typeof USER_SORT_FIELDS)[number];

/** Papel global nos filtros: SUPER_ADMIN ou NONE (contas sem papel na plataforma). */
export const PLATFORM_ROLE_FILTERS = ['SUPER_ADMIN', 'NONE'] as const;
export type PlatformRoleFilter = (typeof PLATFORM_ROLE_FILTERS)[number];

export const AUDIT_RESULTS = ['SUCCESS', 'FAILURE', 'DENIED'] as const;

/**
 * GET /platform/users: ?search=&role=&store_id=&platform_role=&blocked=&include_deleted=&sort=&order=
 * &page=&pageSize= (busca por nome, e-mail ou telefone).
 */
export class PlatformUserListQueryDto extends StoreListQueryDto {
  @ApiPropertyOptional({ enum: UserRole })
  @OptionalQueryChoice(
    Object.values(UserRole),
    'Perfil inválido. Use CLIENT, ADMIN, EMPLOYEE, KITCHEN ou COURIER.',
  )
  role?: UserRole;

  @ApiPropertyOptional({ example: 7, description: 'Equipe de uma loja.' })
  @OptionalQueryId('store_id')
  store_id?: number;

  @ApiPropertyOptional({ enum: PLATFORM_ROLE_FILTERS })
  @OptionalQueryChoice(
    PLATFORM_ROLE_FILTERS,
    'Papel na plataforma inválido. Use SUPER_ADMIN ou NONE.',
  )
  platform_role?: PlatformRoleFilter;

  @ApiPropertyOptional({
    description: 'true = só bloqueadas; false = só livres.',
  })
  @OptionalQueryBoolean('blocked')
  blocked?: boolean;

  @ApiPropertyOptional({
    default: false,
    description: 'Inclui contas na lixeira.',
  })
  @OptionalQueryBoolean('include_deleted')
  include_deleted?: boolean;

  @ApiPropertyOptional({ enum: USER_SORT_FIELDS, default: 'created_at' })
  @OptionalQueryChoice(
    USER_SORT_FIELDS,
    'Ordenação inválida. Use created_at, name, email ou last_login_at.',
    'lower',
  )
  sort?: UserSortField;

  @ApiPropertyOptional({
    enum: SORT_ORDERS,
    description:
      'Padrão: desc em created_at e last_login_at; asc em name e email.',
  })
  @OptionalQueryChoice(SORT_ORDERS, 'Ordem inválida. Use asc ou desc.', 'lower')
  order?: SortOrder;
}

/** POST /platform/users/:id/block: motivo obrigatório (fica na conta e na auditoria). */
export class BlockUserDto {
  @ApiProperty({
    example: 'Conta comprometida (chamado 4321).',
    maxLength: 300,
  })
  @Transform(({ value }) => trimString(value))
  @IsText({
    maxLength: 300,
    required: 'Informe o motivo do bloqueio.',
    invalid: 'O motivo deve ser um texto.',
    tooLong: 'O motivo pode ter no máximo 300 caracteres.',
  })
  reason: string;
}

/** GET /platform/auth-events?user_id=&email=&result=&from=&to=&page=&pageSize= (auditoria auth.*). */
export class AuthEventsQueryDto extends PickType(StoreListQueryDto, [
  'page',
  'pageSize',
] as const) {
  @ApiPropertyOptional({
    example: 12,
    description: 'Eventos da conta (como autora ou alvo).',
  })
  @OptionalQueryId('user_id')
  user_id?: number;

  @ApiPropertyOptional({
    example: 'maria@email.com',
    description:
      'E-mail usado na tentativa (inclusive de contas inexistentes), sem diferenciar maiúsculas.',
  })
  @Transform(({ value }) => {
    const text = emptyToNull(value);
    return typeof text === 'string' ? text.toLowerCase() : (text ?? undefined);
  })
  @IsOptional()
  @IsEmail({}, { message: 'email deve ser um e-mail válido.' })
  email?: string;

  @ApiPropertyOptional({ enum: AUDIT_RESULTS })
  @OptionalQueryChoice(
    AUDIT_RESULTS,
    'Resultado inválido. Use SUCCESS, FAILURE ou DENIED.',
  )
  result?: (typeof AUDIT_RESULTS)[number];

  @ApiPropertyOptional({
    example: '2026-10-01',
    description: 'AAAA-MM-DD (início do dia) ou data e hora ISO 8601 com fuso.',
  })
  @OptionalQueryInstant('from')
  from?: string;

  @ApiPropertyOptional({
    example: '2026-10-31',
    description: 'AAAA-MM-DD (o dia inteiro) ou data e hora ISO 8601 com fuso.',
  })
  @OptionalQueryInstant('to')
  to?: string;
}
