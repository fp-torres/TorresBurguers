import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository, type SelectQueryBuilder } from 'typeorm';
import { AuditLog } from '../audit/entities/audit-log.entity';
import { storeTimeZone } from '../orders/order-rules';
import { pageRequest } from '../store/dto/store-list-query.dto';
import type { Paginated } from '../store/store-presenter';
import { normalizeEmail } from '../users/email';
import type {
  AuditQueryDto,
  StoreAuditQueryDto,
} from './dto/platform-audit.dto';
import type { AuthEventsQueryDto } from './dto/platform-users.dto';
import { actionFilter, parseInstantRange } from './platform-filters';
import { presentAuditLog, type AuditLogView } from './platform-presenter';

export const TARGET_TYPE_REQUIRED_MESSAGE =
  'Informe o tipo do alvo (target_type) junto com target_id.';

/** Eventos de autenticação recentes no detalhe da conta. */
export const RECENT_AUTH_EVENTS_LIMIT = 20;

/**
 * Leitura da trilha de auditoria no superpainel (paginada no banco, mais recentes primeiro), com o
 * ator e a loja resumidos. Os metadados já foram gravados sem segredos (sanitizeForAudit).
 */
@Injectable()
export class PlatformAuditService {
  constructor(
    @InjectRepository(AuditLog)
    private readonly logs: Repository<AuditLog>,
  ) {}

  /** GET /platform/audit e GET /platform/stores/:id/audit (scope.storeId fixa a loja da rota). */
  async list(
    query: AuditQueryDto | StoreAuditQueryDto,
    scope: { storeId?: number } = {},
  ): Promise<Paginated<AuditLogView>> {
    const { page, pageSize, offset } = pageRequest(query);
    const qb = this.baseQuery();

    const storeId =
      scope.storeId ?? ('store_id' in query ? query.store_id : undefined);
    if (storeId !== undefined) {
      qb.andWhere('a.store_id = :storeId', { storeId });
    }
    if (query.actor_id !== undefined) {
      qb.andWhere('a.actor_user_id = :actorId', { actorId: query.actor_id });
    }
    if (query.action) {
      const action = actionFilter(query.action);
      qb.andWhere(
        new Brackets((match) => {
          match.where('a.action LIKE :actionPrefix');
          if (action.exact !== null) match.orWhere('a.action = :actionExact');
        }),
        { actionPrefix: action.prefix, actionExact: action.exact },
      );
    }
    if (query.target_type) {
      qb.andWhere('a.target_type = :targetType', {
        targetType: query.target_type,
      });
    }
    if (query.target_id !== undefined) {
      if (!query.target_type) {
        throw new BadRequestException(TARGET_TYPE_REQUIRED_MESSAGE);
      }
      qb.andWhere('a.target_id = :targetId', { targetId: query.target_id });
    }
    if (query.result) {
      qb.andWhere('a.result = :result', { result: query.result });
    }
    if (query.actor_scope) {
      qb.andWhere('a.actor_scope = :actorScope', {
        actorScope: query.actor_scope,
      });
    }
    this.applyRange(qb, query.from, query.to);
    return this.page(qb, page, pageSize, offset);
  }

  /** GET /platform/auth-events: ações auth.* (login, logout geral, redefinição de senha). */
  async authEvents(
    query: AuthEventsQueryDto,
  ): Promise<Paginated<AuditLogView>> {
    const { page, pageSize, offset } = pageRequest(query);
    const qb = this.baseQuery().andWhere("a.action LIKE 'auth.%'");

    if (query.user_id !== undefined) {
      qb.andWhere(
        new Brackets((match) => {
          match
            .where('a.actor_user_id = :userId')
            .orWhere("(a.target_type = 'user' AND a.target_id = :userKey)");
        }),
        { userId: query.user_id, userKey: String(query.user_id) },
      );
    }
    if (query.email) {
      qb.andWhere('LOWER(a.actor_email) = :email', {
        email: normalizeEmail(query.email),
      });
    }
    if (query.result) {
      qb.andWhere('a.result = :result', { result: query.result });
    }
    this.applyRange(qb, query.from, query.to);
    return this.page(qb, page, pageSize, offset);
  }

  /**
   * Eventos de autenticação recentes de uma conta: como autora, como alvo ou pelo e-mail usado na
   * tentativa (senha errada não identifica a conta, só o e-mail digitado).
   */
  async recentAuthEvents(
    user: { id: number; email: string },
    limit = RECENT_AUTH_EVENTS_LIMIT,
  ): Promise<AuditLogView[]> {
    const rows = await this.baseQuery()
      .andWhere("a.action LIKE 'auth.%'")
      .andWhere(
        new Brackets((match) => {
          match
            .where('a.actor_user_id = :userId')
            .orWhere("(a.target_type = 'user' AND a.target_id = :userKey)")
            .orWhere('LOWER(a.actor_email) = :email');
        }),
        {
          userId: user.id,
          userKey: String(user.id),
          email: normalizeEmail(user.email),
        },
      )
      .orderBy('a.created_at', 'DESC')
      .addOrderBy('a.id', 'DESC')
      .limit(limit)
      .getMany();
    return rows.map(presentAuditLog);
  }

  // ---------------------------------------------------------------------------

  /** Registros com o ator (inclusive contas na lixeira) e a loja resumidos. */
  private baseQuery(): SelectQueryBuilder<AuditLog> {
    return (
      this.logs
        .createQueryBuilder('a')
        // Antes dos joins: o ator que foi para a lixeira continua aparecendo pelo nome
        .withDeleted()
        .leftJoin('a.actor', 'actor')
        .addSelect(['actor.id', 'actor.name', 'actor.email'])
        .leftJoin('a.store', 'store')
        .addSelect(['store.id', 'store.slug', 'store.name'])
    );
  }

  /** from/to: AAAA-MM-DD (dia inteiro no fuso da plataforma) ou data e hora ISO com fuso. */
  private applyRange(
    qb: SelectQueryBuilder<AuditLog>,
    from: string | undefined,
    to: string | undefined,
  ): void {
    const range = parseInstantRange(from, to, storeTimeZone());
    if (!range.ok) throw new BadRequestException(range.message);
    if (range.from) {
      qb.andWhere('a.created_at >= :fromInstant', { fromInstant: range.from });
    }
    if (range.toExclusive) {
      qb.andWhere('a.created_at < :toInstant', {
        toInstant: range.toExclusive,
      });
    }
  }

  private async page(
    qb: SelectQueryBuilder<AuditLog>,
    page: number,
    pageSize: number,
    offset: number,
  ): Promise<Paginated<AuditLogView>> {
    // Junções many-to-one (ator, loja) não multiplicam linhas: offset/limit direto no SQL, e o total
    // é um COUNT(*) simples (o getManyAndCount fazia COUNT(DISTINCT a.id) com os joins: centenas de
    // ms com 1 milhão de registros). Sem colunas das junções, o PostgreSQL nem as executa.
    const count = qb.clone().select('COUNT(*)', 'total');
    const [rows, counted] = await Promise.all([
      qb
        .orderBy('a.created_at', 'DESC')
        .addOrderBy('a.id', 'DESC')
        .offset(offset)
        .limit(pageSize)
        .getMany(),
      count.getRawOne<{ total: string | number }>(),
    ]);
    const total = Number(counted?.total ?? 0);
    return { items: rows.map(presentAuditLog), total, page, pageSize };
  }
}
