import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { Repository } from 'typeorm';
import type { AuthUser } from '../auth/auth-user';
import { requestMeta } from '../common/request-meta';
import { sanitizeForAudit } from './audit-sanitize';
import {
  AuditLog,
  type AuditActorScope,
  type AuditResult,
} from './entities/audit-log.entity';

export interface AuditEntry {
  /** Quem fez (null/undefined = sistema ou anônimo). */
  actor?: Pick<
    AuthUser,
    'id' | 'email' | 'platformRole' | 'storeId' | 'supportSession'
  > | null;
  /** Força o escopo; padrão: PLATFORM para superadmin, STORE para equipe, ANONYMOUS sem ator. */
  scope?: AuditActorScope;
  /** E-mail do ator quando não há sessão (ex.: tentativa de login). */
  actorEmail?: string | null;
  /** Estabelecimento afetado. */
  storeId?: number | null;
  action: string;
  targetType?: string | null;
  targetId?: string | number | null;
  result?: AuditResult;
  metadata?: Record<string, unknown> | null;
  request?: Request | null;
}

/**
 * Trilha de auditoria. Nunca lança erro (uma falha de auditoria não derruba a operação, só vai para o
 * log) e nunca grava senhas, tokens ou segredos (sanitizeForAudit).
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly logs: Repository<AuditLog>,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      const { ip, userAgent } = requestMeta(entry.request);
      const actor = entry.actor ?? null;
      const scope: AuditActorScope =
        entry.scope ??
        (actor
          ? actor.platformRole && !actor.supportSession
            ? 'PLATFORM'
            : 'STORE'
          : 'ANONYMOUS');

      await this.logs.save(
        this.logs.create({
          actor_user_id: actor?.id ?? null,
          actor_email:
            (actor?.email ?? entry.actorEmail ?? null)?.slice(0, 160) ?? null,
          actor_scope: scope,
          store_id: entry.storeId ?? null,
          action: entry.action.slice(0, 80),
          target_type: entry.targetType?.slice(0, 40) ?? null,
          target_id:
            entry.targetId === undefined || entry.targetId === null
              ? null
              : String(entry.targetId).slice(0, 64),
          result: entry.result ?? 'SUCCESS',
          ip,
          user_agent: userAgent,
          metadata: entry.metadata
            ? (sanitizeForAudit({
                ...entry.metadata,
                ...(actor?.supportSession
                  ? { support_session_id: actor.supportSession.id }
                  : {}),
              }) as Record<string, unknown>)
            : actor?.supportSession
              ? { support_session_id: actor.supportSession.id }
              : null,
        }),
      );
    } catch (error) {
      this.logger.error(
        `Falha ao gravar auditoria (${entry.action}): ${(error as Error).message}`,
      );
    }
  }
}
