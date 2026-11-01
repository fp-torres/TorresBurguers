import type { AuditActorScope } from '../audit/entities/audit-log.entity';
import type { AuditEntry } from '../audit/audit.service';
import type { User } from './entities/user.entity';

type AccountRef = Pick<User, 'id' | 'email' | 'store_id' | 'platform_role'>;

/**
 * A própria conta como ator da auditoria, em eventos sem sessão aberta (login, redefinição de
 * senha, aceite de convite): o ator vem do banco, nunca do que o cliente enviou.
 */
export function accountActor(
  user: AccountRef,
): NonNullable<AuditEntry['actor']> {
  return {
    id: user.id,
    email: user.email,
    platformRole: user.platform_role ?? null,
    storeId: user.store_id ?? null,
    supportSession: null,
  };
}

/** Escopo do evento de conta: superadmin → PLATFORM; equipe → STORE; cliente (sem loja) → ANONYMOUS. */
export function accountScope(user: AccountRef): AuditActorScope {
  if (user.platform_role) return 'PLATFORM';
  return user.store_id !== null && user.store_id !== undefined
    ? 'STORE'
    : 'ANONYMOUS';
}
