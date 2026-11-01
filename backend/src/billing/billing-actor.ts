import type { Request } from 'express';
import type { AuditActorScope } from '../audit/entities/audit-log.entity';
import type { AuthUser } from '../auth/auth-user';

/** Quem pediu a operação de cobrança e a requisição (para a auditoria: IP e navegador). */
export interface BillingActor {
  /** null = sistema (rotina de cobrança ou notificação do provedor). */
  user: AuthUser | null;
  request?: Request | null;
}

/** Rotina automática e notificações do provedor. */
export const SYSTEM_ACTOR: BillingActor = Object.freeze({ user: null });

/** Escopo da auditoria: o do usuário (PLATFORM/STORE, decidido pelo AuditService) ou SYSTEM. */
export function auditScopeOf(actor: BillingActor): AuditActorScope | undefined {
  return actor.user ? undefined : 'SYSTEM';
}
