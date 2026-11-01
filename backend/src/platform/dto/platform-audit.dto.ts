import { ApiPropertyOptional, PickType } from '@nestjs/swagger';
import type {
  AuditActorScope,
  AuditResult,
} from '../../audit/entities/audit-log.entity';
import { StoreListQueryDto } from '../../store/dto/store-list-query.dto';
import { AUDIT_RESULTS } from './platform-users.dto';
import {
  OptionalQueryAction,
  OptionalQueryChoice,
  OptionalQueryId,
  OptionalQueryInstant,
  OptionalQueryTargetId,
  OptionalQueryTargetType,
} from './platform-validators';

export const AUDIT_SCOPES = [
  'PLATFORM',
  'STORE',
  'SYSTEM',
  'ANONYMOUS',
] as const satisfies readonly AuditActorScope[];

/** GET /platform/stores/:id/audit: auditoria de UMA loja (a loja vem da rota). */
export class StoreAuditQueryDto extends PickType(StoreListQueryDto, [
  'page',
  'pageSize',
] as const) {
  @ApiPropertyOptional({ example: 1, description: 'Quem fez a ação.' })
  @OptionalQueryId('actor_id')
  actor_id?: number;

  @ApiPropertyOptional({
    example: 'platform.store',
    description:
      'Ação ou grupo de ações, respeitando os segmentos do nome: platform.store traz platform.store e platform.store.*; auth.login.failure, só ela; terminado em ponto (plan.), só o grupo.',
  })
  @OptionalQueryAction()
  action?: string;

  @ApiPropertyOptional({
    example: 'user',
    description:
      'Tipo do alvo da ação (ex.: user, store, plan, subscription, subscription_invoice, invitation, support_session).',
  })
  @OptionalQueryTargetType()
  target_type?: string;

  @ApiPropertyOptional({
    example: '12',
    description: 'Identificador do alvo (exige target_type).',
  })
  @OptionalQueryTargetId()
  target_id?: string;

  @ApiPropertyOptional({ enum: AUDIT_RESULTS })
  @OptionalQueryChoice(
    AUDIT_RESULTS,
    'Resultado inválido. Use SUCCESS, FAILURE ou DENIED.',
  )
  result?: AuditResult;

  @ApiPropertyOptional({
    enum: AUDIT_SCOPES,
    description:
      'De onde partiu a ação: superpainel, equipe da loja, sistema ou anônimo.',
  })
  @OptionalQueryChoice(
    AUDIT_SCOPES,
    'Escopo inválido. Use PLATFORM, STORE, SYSTEM ou ANONYMOUS.',
  )
  actor_scope?: AuditActorScope;

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

/** GET /platform/audit: ?store_id=&actor_id=&action=&target_type=&target_id=&result=&actor_scope=&from=&to=&page=&pageSize= */
export class AuditQueryDto extends StoreAuditQueryDto {
  @ApiPropertyOptional({ example: 7, description: 'Estabelecimento afetado.' })
  @OptionalQueryId('store_id')
  store_id?: number;
}
