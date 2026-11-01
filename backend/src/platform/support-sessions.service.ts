import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import {
  IsNull,
  LessThanOrEqual,
  MoreThan,
  Not,
  Repository,
  type FindOptionsWhere,
} from 'typeorm';
import { AuditService, type AuditEntry } from '../audit/audit.service';
import {
  isSuperAdmin,
  type AuthUser,
  type JwtPayload,
} from '../auth/auth-user';
import { requestMeta } from '../common/request-meta';
import { pageRequest } from '../store/dto/store-list-query.dto';
import { Store, StoreAccountStatus } from '../store/entities/store.entity';
import type { Paginated } from '../store/store-presenter';
import { STORE_NOT_FOUND_MESSAGE } from '../tenancy/tenant.service';
import { PlatformRole, User } from '../users/entities/user.entity';
import { SUPPORT_SESSION_MINUTES_RANGE } from './dto/platform-settings.dto';
import type { SupportSessionListQueryDto } from './dto/support-sessions.dto';
import {
  PLATFORM_SETTINGS_ID,
  PlatformSettings,
} from './entities/platform-settings.entity';
import { SupportSession } from './entities/support-session.entity';
import {
  presentSupportSession,
  type SupportSessionView,
} from './platform-presenter';

export const DEFAULT_SUPPORT_SESSION_MINUTES = 30;
export const SUPPORT_SESSION_NOT_FOUND_MESSAGE =
  'Sessão de suporte não encontrada.';
export const SUPPORT_SESSION_INACTIVE_STORE_MESSAGE =
  'Esta loja está desativada: restaure-a antes de abrir uma sessão de suporte (a equipe de uma loja desativada não acessa o painel).';
const PLATFORM_ONLY_MESSAGE = 'Área exclusiva da administração da plataforma.';

export interface StartedSupportSession {
  /** Token da sessão de suporte (somente leitura, desta loja): exibido só nesta resposta. */
  access_token: string;
  expires_at: Date;
  session: SupportSessionView;
}

/** Duração configurada (platform_settings.support_session_minutes), dentro da faixa permitida. */
export function supportSessionMinutes(value: unknown): number {
  const minutes = Number(value);
  if (!Number.isInteger(minutes)) return DEFAULT_SUPPORT_SESSION_MINUTES;
  return Math.min(
    SUPPORT_SESSION_MINUTES_RANGE.max,
    Math.max(SUPPORT_SESSION_MINUTES_RANGE.min, minutes),
  );
}

/**
 * Acesso assistido do suporte: o superadmin abre uma sessão com motivo para ver o painel de UMA loja.
 * O token é emitido para a conta do PRÓPRIO superadmin (nunca com as credenciais do lojista), com a
 * versão atual das sessões dele (tv) e o id da sessão (sid); a JwtStrategy o transforma em ADMIN
 * somente leitura da loja e o recusa depois do fim ou da expiração. Início e fim são auditados.
 */
@Injectable()
export class SupportSessionsService {
  constructor(
    @InjectRepository(SupportSession)
    private readonly sessions: Repository<SupportSession>,
    @InjectRepository(Store)
    private readonly stores: Repository<Store>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(PlatformSettings)
    private readonly settings: Repository<PlatformSettings>,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  /** POST /platform/stores/:id/support-sessions → { access_token, expires_at, session }. */
  async start(
    storeId: number,
    reason: string,
    actor: AuthUser,
    request?: Request | null,
    now: Date = new Date(),
  ): Promise<StartedSupportSession> {
    this.assertPlatformOperator(actor);
    const store = await this.stores.findOne({
      where: { id: storeId },
      select: { id: true, slug: true, name: true, account_status: true },
    });
    if (!store) throw new NotFoundException(STORE_NOT_FOUND_MESSAGE);
    if (store.account_status === StoreAccountStatus.INACTIVE) {
      throw new BadRequestException(SUPPORT_SESSION_INACTIVE_STORE_MESSAGE);
    }

    // Dados ATUAIS da conta do superadmin: o token leva a versão vigente das sessões dele
    const operator = await this.users.findOne({
      where: { id: actor.id },
      select: {
        id: true,
        email: true,
        role: true,
        name: true,
        token_version: true,
        platform_role: true,
        blocked_at: true,
      },
    });
    if (
      !operator ||
      operator.platform_role !== PlatformRole.SUPER_ADMIN ||
      operator.blocked_at
    ) {
      throw new ForbiddenException(PLATFORM_ONLY_MESSAGE);
    }

    const minutes = await this.durationMinutes();
    const expiresAt = new Date(now.getTime() + minutes * 60_000);
    const text = reason.trim();
    const session = await this.sessions.save(
      this.sessions.create({
        platform_user_id: operator.id,
        store_id: store.id,
        reason: text,
        expires_at: expiresAt,
        ended_at: null,
        ip: requestMeta(request).ip,
      }),
    );

    const payload: JwtPayload = {
      sub: operator.id,
      email: operator.email,
      role: operator.role,
      name: operator.name,
      tv: operator.token_version ?? 0,
      sid: session.id,
    };
    // Mesmo segredo/algoritmo do login (JwtModule); a validade é a da sessão
    const accessToken = this.jwt.sign(payload, { expiresIn: minutes * 60 });

    await this.audit.record({
      actor,
      storeId: store.id,
      action: 'platform.support_session.start',
      targetType: 'support_session',
      targetId: session.id,
      metadata: {
        reason: text,
        minutes,
        expires_at: expiresAt,
        store_slug: store.slug,
      },
      request,
    });

    session.store = store;
    session.platform_user = operator;
    return {
      access_token: accessToken,
      expires_at: expiresAt,
      session: presentSupportSession(session, now),
    };
  }

  /**
   * POST /platform/support-sessions/:id/end: encerra a sessão (o token dela deixa de valer na hora).
   * Já encerrada: devolve como está (idempotente, sem nova auditoria).
   */
  async end(
    id: number,
    actor: AuthUser,
    request?: Request | null,
    now: Date = new Date(),
  ): Promise<SupportSessionView> {
    this.assertPlatformOperator(actor);
    const session = await this.findWithRelations(id);
    if (session.ended_at) return presentSupportSession(session, now);

    const result = await this.sessions.update(
      { id, ended_at: IsNull() },
      { ended_at: now },
    );
    if (!result.affected) {
      // Encerrada por outra requisição neste meio-tempo
      return presentSupportSession(await this.findWithRelations(id), now);
    }

    session.ended_at = now;
    const startedAt = new Date(session.started_at).getTime();
    await this.audit.record({
      actor,
      storeId: session.store_id,
      action: 'platform.support_session.end',
      targetType: 'support_session',
      targetId: id,
      metadata: {
        opened_by_user_id: session.platform_user_id ?? null,
        expired_before_end: new Date(session.expires_at) <= now,
        duration_minutes: Number.isNaN(startedAt)
          ? null
          : Math.max(0, Math.round((now.getTime() - startedAt) / 60_000)),
      },
      request,
    });
    return presentSupportSession(session, now);
  }

  /** GET /platform/support-sessions?store_id=&platform_user_id=&active=&page=&pageSize= */
  async list(
    query: SupportSessionListQueryDto,
    now: Date = new Date(),
  ): Promise<Paginated<SupportSessionView>> {
    const { page, pageSize, offset } = pageRequest(query);
    const base: FindOptionsWhere<SupportSession> = {};
    if (query.store_id !== undefined) base.store_id = query.store_id;
    if (query.platform_user_id !== undefined) {
      base.platform_user_id = query.platform_user_id;
    }

    let where:
      | FindOptionsWhere<SupportSession>[]
      | FindOptionsWhere<SupportSession> = base;
    if (query.active === true) {
      where = { ...base, ended_at: IsNull(), expires_at: MoreThan(now) };
    } else if (query.active === false) {
      where = [
        { ...base, ended_at: Not(IsNull()) },
        { ...base, ended_at: IsNull(), expires_at: LessThanOrEqual(now) },
      ];
    }

    const [rows, total] = await this.sessions.findAndCount({
      where,
      relations: { store: true, platform_user: true },
      withDeleted: true,
      order: { started_at: 'DESC', id: 'DESC' },
      skip: offset,
      take: pageSize,
    });
    return {
      items: rows.map((row) => presentSupportSession(row, now)),
      total,
      page,
      pageSize,
    };
  }

  // ---------------------------------------------------------------------------

  private async findWithRelations(id: number): Promise<SupportSession> {
    const session = await this.sessions.findOne({
      where: { id },
      relations: { store: true, platform_user: true },
      withDeleted: true,
    });
    if (!session)
      throw new NotFoundException(SUPPORT_SESSION_NOT_FOUND_MESSAGE);
    return session;
  }

  private async durationMinutes(): Promise<number> {
    const settings = await this.settings.findOne({
      where: { id: PLATFORM_SETTINGS_ID },
      select: { id: true, support_session_minutes: true },
    });
    return supportSessionMinutes(
      settings?.support_session_minutes ?? DEFAULT_SUPPORT_SESSION_MINUTES,
    );
  }

  private assertPlatformOperator(actor: AuthUser | null | undefined): void {
    if (!isSuperAdmin(actor)) {
      throw new ForbiddenException(PLATFORM_ONLY_MESSAGE);
    }
  }
}

// ---------------------------------------------------------------------------
// Encerramento pelo próprio token (sem o token do superpainel)
// ---------------------------------------------------------------------------

/** Como a sessão de suporte foi encerrada sem o superpainel. */
export type SupportSessionEndVia =
  /** POST /auth/logout com o token da própria sessão de suporte. */
  | 'logout'
  /** DELETE /auth/sessions/:id da sessão de acesso que carrega a sessão de suporte. */
  | 'session_revoke';

/**
 * Encerra uma sessão de suporte do PRÓPRIO operador (platform_user_id) sem exigir o token do superpainel:
 * usado pelo AuthModule no logout com o token de suporte e ao revogar a sessão de acesso dela. É uma função
 * (não um método do serviço) porque o AuthModule não importa o PlatformModule (que já importa o AuthModule).
 *
 * Idempotente: sessão de outra conta, inexistente ou já encerrada → false, sem nova auditoria.
 * Auditoria: platform.support_session.end (escopo PLATFORM) com metadata.via, como o encerramento pelo
 * superpainel.
 */
export async function endSupportSessionByOperator(
  sessions: Repository<SupportSession>,
  audit: AuditService,
  params: {
    sessionId: number;
    operatorId: number;
    via: SupportSessionEndVia;
    actor: AuditEntry['actor'];
    request?: Request | null;
    now?: Date;
  },
): Promise<boolean> {
  const now = params.now ?? new Date();
  const where = { id: params.sessionId, platform_user_id: params.operatorId };
  const session = await sessions.findOne({ where });
  if (!session || session.ended_at) return false;

  const result = await sessions.update(
    { ...where, ended_at: IsNull() },
    { ended_at: now },
  );
  // Encerrada por outra requisição neste meio-tempo
  if (!result.affected) return false;

  const startedAt = new Date(session.started_at).getTime();
  await audit.record({
    actor: params.actor,
    scope: 'PLATFORM',
    storeId: session.store_id,
    action: 'platform.support_session.end',
    targetType: 'support_session',
    targetId: session.id,
    metadata: {
      via: params.via,
      opened_by_user_id: session.platform_user_id ?? null,
      expired_before_end: new Date(session.expires_at) <= now,
      duration_minutes: Number.isNaN(startedAt)
        ? null
        : Math.max(0, Math.round((now.getTime() - startedAt) / 60_000)),
    },
    request: params.request,
  });
  return true;
}
