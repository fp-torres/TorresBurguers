import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { Brackets, In, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { isSuperAdmin, type AuthUser } from '../auth/auth-user';
import {
  PasswordResetService,
  RESET_TOKEN_TTL_MINUTES,
} from '../auth/password-reset.service';
import { likeContains, pageRequest } from '../store/dto/store-list-query.dto';
import { Store } from '../store/entities/store.entity';
import type { Paginated } from '../store/store-presenter';
import { PlatformRole, User } from '../users/entities/user.entity';
import { numericSearchDigits } from './platform-filters';
import { UsersService, USER_NOT_FOUND } from '../users/users.service';
import type {
  PlatformUserListQueryDto,
  UserSortField,
} from './dto/platform-users.dto';
import { PlatformAuditService } from './platform-audit.service';
import {
  presentPlatformUser,
  storeSummary,
  type AuditLogView,
  type PlatformUserView,
  type StoreSummary,
} from './platform-presenter';

const PLATFORM_ONLY_MESSAGE = 'Área exclusiva da administração da plataforma.';
export const SELF_BLOCK_MESSAGE = 'Você não pode bloquear a própria conta.';
// A validade vem da mesma constante que define a expiração do link (não fica desatualizada)
export const PASSWORD_LINK_NOTICE = `Link de redefinição gerado. Ele aparece só agora: copie e envie para a pessoa por um canal seguro. Vale por ${RESET_TOKEN_TTL_MINUTES} minutos e uma única vez; links anteriores deixam de valer.`;
/** Com o SMTP configurado, o link vai só para o e-mail do titular (o operador não o vê). */
export const PASSWORD_LINK_SENT_NOTICE = (emailMasked: string) =>
  `Link de redefinição enviado para o e-mail da conta (${emailMasked}). Vale por ${RESET_TOKEN_TTL_MINUTES} minutos e uma única vez; links anteriores deixam de valer.`;

const SORT_COLUMNS: Record<UserSortField, string> = {
  created_at: 'u.created_at',
  name: 'u.name',
  email: 'u.email',
  last_login_at: 'u.last_login_at',
};

export type PlatformUserDetail = PlatformUserView & {
  /** É o responsável principal (stores.owner_user_id) da loja à qual pertence. */
  is_owner: boolean;
  recent_auth_events: AuditLogView[];
};

/**
 * Contas no superpainel (clientes, equipe de todas as lojas e administração da plataforma): busca,
 * detalhe com os eventos de autenticação, bloqueio, desbloqueio, encerramento das sessões e link de
 * redefinição de senha. As alterações usam o UsersService/PasswordResetService, que exigem
 * superadmin, incrementam a versão das sessões quando preciso e gravam a auditoria
 * (user.block, user.unblock, user.revoke_sessions, user.password_reset_link).
 */
@Injectable()
export class PlatformUsersService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(Store)
    private readonly stores: Repository<Store>,
    private readonly usersService: UsersService,
    private readonly passwordReset: PasswordResetService,
    private readonly auditLogs: PlatformAuditService,
    private readonly audit: AuditService,
  ) {}

  /**
   * GET /platform/users (paginado no banco; resposta por lista de campos permitidos). Com o operador
   * (rota), a leitura entra na auditoria: platform.users.list com os filtros e a quantidade devolvida.
   */
  async list(
    query: PlatformUserListQueryDto,
    actor?: AuthUser | null,
    request?: Request | null,
  ): Promise<Paginated<PlatformUserView>> {
    const { search, page, pageSize, offset } = pageRequest(query);
    const qb = this.users.createQueryBuilder('u');
    if (query.include_deleted === true) qb.withDeleted();

    if (search) {
      // Só um termo com cara de telefone procura nos dígitos do telefone: "Loja 219" ou um e-mail
      // com números não traz toda conta cujo telefone contém esses dígitos
      const digits = numericSearchDigits(search);
      qb.andWhere(
        new Brackets((match) => {
          match.where('u.name ILIKE :term').orWhere('u.email ILIKE :term');
          // "(21) 99999-0000" encontra o telefone gravado com ou sem pontuação
          if (digits) {
            match.orWhere(
              "regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g') LIKE :digits",
            );
          }
        }),
        { term: likeContains(search), digits: `%${digits ?? ''}%` },
      );
    }
    if (query.role) qb.andWhere('u.role = :role', { role: query.role });
    if (query.store_id !== undefined) {
      qb.andWhere('u.store_id = :storeId', { storeId: query.store_id });
    }
    if (query.platform_role === 'SUPER_ADMIN') {
      qb.andWhere('u.platform_role = :platformRole', {
        platformRole: PlatformRole.SUPER_ADMIN,
      });
    } else if (query.platform_role === 'NONE') {
      qb.andWhere('u.platform_role IS NULL');
    }
    if (query.blocked === true) qb.andWhere('u.blocked_at IS NOT NULL');
    if (query.blocked === false) qb.andWhere('u.blocked_at IS NULL');

    const sort = query.sort ?? 'created_at';
    const descending =
      query.order === 'desc' ||
      (query.order === undefined &&
        (sort === 'created_at' || sort === 'last_login_at'));
    const [rows, total] = await qb
      .orderBy(
        SORT_COLUMNS[sort],
        descending ? 'DESC' : 'ASC',
        descending ? 'NULLS LAST' : 'NULLS FIRST',
      )
      .addOrderBy('u.id', descending ? 'DESC' : 'ASC')
      .offset(offset)
      .limit(pageSize)
      .getManyAndCount();

    const stores = await this.storeSummaries(rows.map((row) => row.store_id));
    if (actor) {
      await this.audit.record({
        actor,
        action: 'platform.users.list',
        targetType: 'user',
        metadata: {
          filters: {
            search: search ?? null,
            role: query.role ?? null,
            store_id: query.store_id ?? null,
            platform_role: query.platform_role ?? null,
            blocked: query.blocked ?? null,
            include_deleted: query.include_deleted === true,
          },
          page,
          page_size: pageSize,
          returned: rows.length,
          total,
        },
        request,
      });
    }
    return {
      items: rows.map((user) =>
        presentPlatformUser(user, {
          store:
            user.store_id !== null && user.store_id !== undefined
              ? (stores.get(user.store_id) ?? null)
              : null,
        }),
      ),
      total,
      page,
      pageSize,
    };
  }

  /**
   * GET /platform/users/:id: a conta (inclusive na lixeira) + eventos recentes de autenticação. Com o
   * operador (rota), a leitura entra na auditoria (platform.users.view, só o alvo).
   */
  async detail(
    id: number,
    actor?: AuthUser | null,
    request?: Request | null,
  ): Promise<PlatformUserDetail> {
    const user = await this.users.findOne({ where: { id }, withDeleted: true });
    if (!user) throw new NotFoundException(USER_NOT_FOUND);
    if (actor) {
      await this.audit.record({
        actor,
        storeId: user.store_id ?? null,
        action: 'platform.users.view',
        targetType: 'user',
        targetId: user.id,
        metadata: { deleted: !!user.deleted_at },
        request,
      });
    }
    return this.presentDetail(user);
  }

  /** POST /platform/users/:id/block { reason }: login recusado e sessões encerradas na hora. */
  async block(
    id: number,
    reason: string,
    actor: AuthUser,
    request?: Request | null,
  ): Promise<PlatformUserDetail> {
    this.assertPlatformOperator(actor);
    if (id === actor.id) throw new BadRequestException(SELF_BLOCK_MESSAGE);
    const user = await this.usersService.block(id, reason, actor, request);
    return this.presentDetail(user);
  }

  /** POST /platform/users/:id/unblock */
  async unblock(
    id: number,
    actor: AuthUser,
    request?: Request | null,
  ): Promise<PlatformUserDetail> {
    this.assertPlatformOperator(actor);
    const user = await this.usersService.unblock(id, actor, request);
    return this.presentDetail(user);
  }

  /** POST /platform/users/:id/revoke-sessions: todos os tokens da conta deixam de valer. */
  async revokeSessions(
    id: number,
    actor: AuthUser,
    request?: Request | null,
  ): Promise<{ message: string; user: PlatformUserDetail }> {
    this.assertPlatformOperator(actor);
    await this.usersService.revokeSessions(id, actor, request);
    return {
      message:
        'Todas as sessões da conta foram encerradas: será preciso entrar de novo em todos os dispositivos.',
      user: await this.detail(id),
    };
  }

  /**
   * POST /platform/users/:id/password-reset: { url, delivered, expires_at, message }. Com o SMTP
   * configurado, o link vai só para o e-mail do titular (url null, delivered true); sem ele, a url
   * aparece uma única vez para o operador repassar (delivered false).
   */
  async passwordResetLink(
    id: number,
    actor: AuthUser,
    request?: Request | null,
  ): Promise<{
    url: string | null;
    delivered: boolean;
    expires_at: Date;
    message: string;
  }> {
    this.assertPlatformOperator(actor);
    const link = await this.passwordReset.createLinkForUser(id, actor, request);
    return {
      url: link.url,
      delivered: link.delivered,
      expires_at: link.expires_at,
      message: link.delivered
        ? PASSWORD_LINK_SENT_NOTICE(link.email_masked)
        : PASSWORD_LINK_NOTICE,
    };
  }

  // ---------------------------------------------------------------------------

  private async presentDetail(user: User): Promise<PlatformUserDetail> {
    const [store, events] = await Promise.all([
      user.store_id !== null && user.store_id !== undefined
        ? this.stores.findOne({
            where: { id: user.store_id },
            select: {
              id: true,
              slug: true,
              name: true,
              account_status: true,
              owner_user_id: true,
            },
          })
        : Promise.resolve(null),
      this.auditLogs.recentAuthEvents(user),
    ]);
    return {
      ...presentPlatformUser(user, { store: storeSummary(store) }),
      is_owner: !!store && store.owner_user_id === user.id,
      recent_auth_events: events,
    };
  }

  /** Resumo das lojas de uma página de contas (uma consulta só). */
  private async storeSummaries(
    ids: (number | null | undefined)[],
  ): Promise<Map<number, StoreSummary>> {
    const unique = [
      ...new Set(ids.filter((id): id is number => typeof id === 'number')),
    ];
    if (!unique.length) return new Map();
    const stores = await this.stores.find({
      where: { id: In(unique) },
      select: { id: true, slug: true, name: true, account_status: true },
    });
    return new Map(
      stores.map((store) => [store.id, storeSummary(store) as StoreSummary]),
    );
  }

  private assertPlatformOperator(actor: AuthUser | null | undefined): void {
    if (!isSuperAdmin(actor)) {
      throw new ForbiddenException(PLATFORM_ONLY_MESSAGE);
    }
  }
}
