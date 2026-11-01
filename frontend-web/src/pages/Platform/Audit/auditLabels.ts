import type { StatusTone } from '../../../components/ui';
import type { AuditActorScope, AuditLogEntry, AuditResult } from '../../../services/platform/auditService';

// Rótulos da trilha de auditoria e dos eventos de autenticação (ações gravadas pelo backend com
// AuditService.record). Ação desconhecida aparece com o código como veio: nada é escondido.

const ACTION_LABELS: Record<string, string> = {
  'auth.login.success': 'Login realizado',
  'auth.login.failure': 'Falha no login',
  'auth.logout': 'Saída (logout)',
  'auth.logout_all': 'Saída de todos os dispositivos',
  'auth.session.revoke': 'Sessão encerrada pelo titular',
  'auth.password_reset.request': 'Pedido de redefinição de senha',
  'auth.password_reset.complete': 'Senha redefinida',
  'auth.email_change.request': 'Pedido de troca de e-mail',
  'auth.email_change.cancel': 'Troca de e-mail cancelada',
  'auth.email_change.confirm': 'Troca de e-mail confirmada',
  'auth.email_change.revert': 'Troca de e-mail desfeita ("Não fui eu")',
  'auth.email_verification.request': 'Pedido de confirmação do e-mail',
  'auth.email_verification.confirm': 'E-mail confirmado',
  'auth.refresh.reuse': 'Reuso de sessão detectado',
  'account.credentials.change': 'E-mail ou senha alterados pelo titular',
  'account.delete': 'Conta excluída pelo titular',
  'user.block': 'Conta bloqueada',
  'user.unblock': 'Conta desbloqueada',
  'user.revoke_sessions': 'Sessões da conta encerradas',
  'user.password_reset_link': 'Link de redefinição de senha gerado',
  'platform.store.create': 'Estabelecimento criado',
  'platform.store.update': 'Estabelecimento editado',
  'platform.store.suspend': 'Estabelecimento suspenso',
  'platform.store.reactivate': 'Estabelecimento reativado',
  'platform.store.deactivate': 'Estabelecimento desativado',
  'platform.store.restore': 'Estabelecimento restaurado',
  'platform.store.self_signup': 'Cadastro pelo autoatendimento',
  'platform.support_session.start': 'Sessão de suporte iniciada',
  'platform.support_session.end': 'Sessão de suporte encerrada',
  'platform.superadmin.grant': 'Acesso de superadministrador concedido',
  'platform.superadmin.revoke': 'Acesso de superadministrador revogado',
  'platform.superadmin.reset_password': 'Senha de superadministrador redefinida (comando)',
  'platform.users.list': 'Lista de contas consultada',
  'platform.users.view': 'Conta consultada',
  'platform.store.team.view': 'Equipe do estabelecimento consultada',
  'platform.settings.update': 'Configurações da plataforma alteradas',
  'platform.settings.test_email': 'E-mail de teste enviado',
  'platform.maintenance.optimize_images': 'Otimização de imagens',
  'platform.maintenance.optimize_images.finish': 'Otimização de imagens concluída',
  'platform.maintenance.cleanup_uploads': 'Limpeza de arquivos sem uso',
  'platform.maintenance.cleanup_uploads.finish': 'Limpeza de arquivos sem uso concluída',
  'platform.maintenance.reencrypt_credentials': 'Credenciais de pagamento regravadas',
  'platform.migration.initial_store': 'Migração para a loja inicial',
  'plan.create': 'Plano criado',
  'plan.update': 'Plano alterado',
  'subscription.create': 'Assinatura criada',
  'subscription.change_plan': 'Troca de plano',
  'subscription.cancel': 'Assinatura cancelada',
  'subscription.cancel_scheduled': 'Cancelamento agendado',
  'subscription.resume': 'Cancelamento desfeito',
  'subscription.suspend': 'Assinatura suspensa',
  'subscription.reactivate': 'Assinatura reativada',
  'subscription.checkout': 'Link de pagamento da assinatura',
  'subscription.provider_sync': 'Sincronização com o provedor de cobrança',
  'subscription.provider_payment_review': 'Pagamento para conferência',
  'subscription.invoice.create': 'Fatura criada',
  'subscription.invoice.mark_paid': 'Fatura paga',
  'subscription.invoice.mark_failed': 'Fatura recusada',
  'subscription.invoice.void': 'Fatura anulada',
  'subscription.lifecycle.activated': 'Rotina: assinatura ativada',
  'subscription.lifecycle.canceled': 'Rotina: assinatura cancelada',
  'subscription.lifecycle.renewed': 'Rotina: renovação do período',
  'subscription.lifecycle.past_due': 'Rotina: assinatura em atraso',
  'subscription.lifecycle.suspended': 'Rotina: assinatura suspensa',
  'subscription.lifecycle.restored': 'Rotina: assinatura reativada',
  'subscription.lifecycle.provider_canceled': 'Rotina: cancelada no provedor de cobrança',
  'store.status.update': 'Loja aberta ou fechada',
  'store.settings.update': 'Configurações da loja alteradas',
  'store.payments.update': 'Credenciais de pagamento salvas',
  'store.payments.remove': 'Credenciais de pagamento removidas',
  'store.logo.update': 'Logo alterada',
  'store.logo.remove': 'Logo removida',
  'store.staff.create': 'Membro da equipe cadastrado',
  'store.staff.update': 'Membro da equipe editado',
  'store.staff.delete': 'Membro enviado à lixeira',
  'store.staff.restore': 'Membro restaurado',
  'store.staff.purge': 'Membro excluído definitivamente',
  'store.customer.block': 'Cliente bloqueado pela loja',
  'store.customer.unblock': 'Cliente desbloqueado pela loja',
  'invitation.create': 'Convite criado',
  'invitation.revoke': 'Convite revogado',
  'invitation.accept': 'Convite aceito',
  'order.cancel': 'Pedido cancelado',
  'payment.refund': 'Estorno de pagamento',
  'payment.updated': 'Pagamento atualizado',
  'payment.order_not_created': 'Pagamento sem pedido criado',
  'payment.cancel': 'Pagamento cancelado (loja sem vender)',
  'payment.reversed': 'Pagamento desfeito no Mercado Pago (estorno/contestação)',
  'catalog.product.delete_permanent': 'Produto excluído definitivamente',
};

export function actionLabel(action: string): string {
  return Object.hasOwn(ACTION_LABELS, action) ? ACTION_LABELS[action] : action || 'Ação';
}

/**
 * Grupos do filtro de ação. A API respeita os segmentos do nome: "plan" traz plan e plan.* (nunca platform.*),
 * "auth.login" traz auth.login.success e auth.login.failure, e um nome terminado em ponto ("plan.") traz só as
 * ações do grupo. Os grupos prontos terminam em ponto: são sempre grupos, nunca uma ação com o mesmo nome.
 */
export const ACTION_GROUPS: { value: string; label: string }[] = [
  { value: 'auth.', label: 'Autenticação (login, senha)' },
  { value: 'user.', label: 'Contas: bloqueio, sessões e links' },
  { value: 'account.', label: 'Conta alterada pelo titular' },
  { value: 'platform.store.', label: 'Estabelecimentos (superpainel)' },
  { value: 'platform.support_session.', label: 'Sessões de suporte' },
  { value: 'platform.settings.', label: 'Configurações da plataforma' },
  { value: 'platform.superadmin.', label: 'Superadministradores' },
  { value: 'platform.maintenance.', label: 'Manutenção' },
  { value: 'plan.', label: 'Planos' },
  { value: 'subscription.', label: 'Assinaturas e faturas' },
  { value: 'subscription.invoice.', label: 'Só faturas' },
  { value: 'store.', label: 'Painel da loja' },
  { value: 'store.staff.', label: 'Equipe da loja' },
  { value: 'invitation.', label: 'Convites' },
  { value: 'order.', label: 'Pedidos' },
  { value: 'payment.', label: 'Pagamentos' },
  { value: 'catalog.', label: 'Cardápio' },
];

export const AUDIT_RESULT_META: Record<AuditResult, { label: string; tone: StatusTone }> = {
  SUCCESS: { label: 'Sucesso', tone: 'success' },
  FAILURE: { label: 'Falha', tone: 'danger' },
  DENIED: { label: 'Negado', tone: 'warning' },
};

export function resultMeta(result: string): { label: string; tone: StatusTone } {
  return Object.hasOwn(AUDIT_RESULT_META, result) ? AUDIT_RESULT_META[result as AuditResult] : { label: result || '—', tone: 'neutral' };
}

export const ACTOR_SCOPE_LABELS: Record<AuditActorScope, string> = {
  PLATFORM: 'Superpainel',
  STORE: 'Equipe da loja',
  SYSTEM: 'Sistema',
  ANONYMOUS: 'Anônimo',
};

export function scopeLabel(scope: string): string {
  return Object.hasOwn(ACTOR_SCOPE_LABELS, scope) ? ACTOR_SCOPE_LABELS[scope as AuditActorScope] : scope || '—';
}

const TARGET_LABELS: Record<string, string> = {
  user: 'Conta',
  store: 'Loja',
  subscription: 'Assinatura',
  subscription_invoice: 'Fatura',
  plan: 'Plano',
  invitation: 'Convite',
  order: 'Pedido',
  payment: 'Pagamento',
  product: 'Produto',
  platform_settings: 'Configurações da plataforma',
  support_session: 'Sessão de suporte',
  uploads: 'Arquivos enviados',
};

/** Nome do tipo de alvo ("Conta", "Fatura"...); tipo desconhecido aparece como veio. */
export function targetTypeLabel(type: string): string {
  return Object.hasOwn(TARGET_LABELS, type) ? TARGET_LABELS[type] : type;
}

/** "Conta #12", "Fatura #9", "Configurações da plataforma"; null sem alvo. */
export function targetLabel(entry: Pick<AuditLogEntry, 'target_type' | 'target_id'>): string | null {
  if (!entry.target_type) return entry.target_id ? `#${entry.target_id}` : null;
  const name = targetTypeLabel(entry.target_type);
  if (!entry.target_id || entry.target_type === 'platform_settings') return name;
  return `${name} #${entry.target_id}`;
}

/** Texto do filtro de alvo da auditoria: "Alvo: Conta #12" ou, só com o tipo, "Tipo do alvo: Conta". */
export function targetFilterLabel(type: string, id: string): string {
  return id ? `Alvo: ${targetLabel({ target_type: type, target_id: id })}` : `Tipo do alvo: ${targetTypeLabel(type)}`;
}

/** Link interno do alvo (conta, loja ou assinatura), quando o superpainel tem a página. */
export function targetPath(entry: Pick<AuditLogEntry, 'target_type' | 'target_id'>): string | null {
  if (!entry.target_id || !/^\d+$/.test(entry.target_id)) return null;
  if (entry.target_type === 'user') return `/platform/users?usuario=${entry.target_id}`;
  if (entry.target_type === 'store') return `/platform/stores/${entry.target_id}`;
  if (entry.target_type === 'subscription') return `/platform/subscriptions?subscription=${entry.target_id}`;
  return null;
}

const REASON_LABELS: Record<string, string> = {
  invalid_credentials: 'e-mail ou senha incorretos',
  blocked: 'conta bloqueada',
  store_inactive: 'loja desativada',
  unknown_account: 'nenhuma conta com este e-mail',
  recipient_limit: 'limite de links do destinatário (3 em 24 h)',
  email_in_use: 'e-mail já usado por outra conta',
  email_reserved: 'e-mail reservado por uma troca recente de outra conta',
  mail_not_delivered: 'o e-mail não foi enviado',
  owner_invitation_pending: 'e-mail com convite pendente para assumir a loja',
  replaced: 'sessão substituída por um novo login no mesmo navegador',
};

const VIA_LABELS: Record<string, string> = {
  platform_link: 'link gerado no superpainel',
  email: 'link enviado por e-mail',
  cookie: 'sessão do site (cookie)',
  account_password: 'Minha conta (senha atual)',
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Mesmo critério do backend (sanitizeForAudit): chaves de senhas, tokens, segredos e dados de cartão. */
const SENSITIVE_KEY =
  /pass(word)?|senha|token|secret|segredo|authorization|cookie|cvv|card(_?number)?|cartao|access[_-]?key|api[_-]?key|private[_-]?key|credential/i;

/**
 * Cópia dos metadados para exibição. A API já grava sem segredos; por garantia, valores de chaves
 * sensíveis que porventura cheguem aparecem como "[oculto]".
 */
export function maskSensitive(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[…]';
  if (Array.isArray(value)) return value.map((item) => maskSensitive(item, depth + 1));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) && item !== null && item !== '[removido]' ? '[oculto]' : maskSensitive(item, depth + 1),
      ]),
    );
  }
  return value;
}

function shortValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > 60 ? `${value.slice(0, 59)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** Resumo de uma linha dos metadados (motivo, campos alterados ou os primeiros valores simples). */
export function metadataSummary(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  const masked = maskSensitive(metadata) as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof masked.reason === 'string' && masked.reason.trim()) {
    const reason = masked.reason.trim();
    parts.push(`Motivo: ${REASON_LABELS[reason] ?? reason}`);
  }
  if (typeof masked.via === 'string') parts.push(`Via ${VIA_LABELS[masked.via] ?? masked.via}`);
  if (masked.mail_skipped === 'recipient_mail_limit') parts.push('Convite criado sem e-mail: limite do destinatário');
  if (isPlainObject(masked.changes)) {
    const fields = Object.keys(masked.changes);
    if (fields.length) parts.push(`Alterou: ${fields.slice(0, 4).join(', ')}${fields.length > 4 ? '…' : ''}`);
  }
  if (Array.isArray(masked.fields) && masked.fields.length) {
    const fields = masked.fields.filter((field): field is string => typeof field === 'string');
    if (fields.length) parts.push(`Campos: ${fields.slice(0, 4).join(', ')}${fields.length > 4 ? '…' : ''}`);
  }
  if (parts.length === 0) {
    // Sem campos conhecidos: os dois primeiros valores simples (ex.: "email: ana@x.com · role: ADMIN")
    const simple = Object.entries(masked)
      .map(([key, value]) => {
        const text = shortValue(value);
        return text === null ? null : `${key}: ${text}`;
      })
      .filter((item): item is string => item !== null);
    parts.push(...simple.slice(0, 2));
  }
  const summary = parts.join(' · ');
  return summary ? (summary.length > 140 ? `${summary.slice(0, 139)}…` : summary) : null;
}

/** Navegador e sistema resumidos do user-agent (ex.: "Chrome · Windows"); null sem informação. */
export function userAgentSummary(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const browser = /Edg\//.test(userAgent) ? 'Edge'
    : /OPR\/|Opera/.test(userAgent) ? 'Opera'
      : /Firefox\//.test(userAgent) ? 'Firefox'
        : /Chrome\//.test(userAgent) ? 'Chrome'
          : /Safari\//.test(userAgent) ? 'Safari'
            : /okhttp|Dart|Expo|ReactNative/i.test(userAgent) ? 'App'
              : null;
  const system = /Windows/.test(userAgent) ? 'Windows'
    : /Android/.test(userAgent) ? 'Android'
      : /iPhone|iPad|iOS/.test(userAgent) ? 'iOS'
        : /Mac OS X|Macintosh/.test(userAgent) ? 'macOS'
          : /Linux/.test(userAgent) ? 'Linux'
            : null;
  const parts = [browser, system].filter(Boolean);
  return parts.length ? parts.join(' · ') : userAgent.slice(0, 40);
}
