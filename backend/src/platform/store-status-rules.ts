/**
 * Regras puras da situação de um estabelecimento na plataforma (stores.account_status), decidida pelo
 * superadministrador. Nenhuma transição apaga dados: suspender bloqueia novos pedidos e alterações,
 * desativar tira a loja do ar e do painel; reativar/restaurar devolve tudo como estava.
 * Cobertas por store-status-rules.spec.ts.
 *
 *   suspend    ACTIVE             → SUSPENDED   (motivo obrigatório)
 *   reactivate SUSPENDED          → ACTIVE
 *   deactivate ACTIVE | SUSPENDED → INACTIVE    (motivo obrigatório)
 *   restore    INACTIVE           → ACTIVE
 */
import { StoreAccountStatus } from '../store/entities/store.entity';

export type StoreStatusAction =
  | 'suspend'
  | 'reactivate'
  | 'deactivate'
  | 'restore';

export interface StoreStatusTransition {
  from: readonly StoreAccountStatus[];
  to: StoreAccountStatus;
  /** O motivo vai para stores.status_reason (exibido à equipe) e para a auditoria. */
  requiresReason: boolean;
  auditAction: string;
}

export const STORE_STATUS_TRANSITIONS: Readonly<
  Record<StoreStatusAction, StoreStatusTransition>
> = {
  suspend: {
    from: [StoreAccountStatus.ACTIVE],
    to: StoreAccountStatus.SUSPENDED,
    requiresReason: true,
    auditAction: 'platform.store.suspend',
  },
  reactivate: {
    from: [StoreAccountStatus.SUSPENDED],
    to: StoreAccountStatus.ACTIVE,
    requiresReason: false,
    auditAction: 'platform.store.reactivate',
  },
  deactivate: {
    from: [StoreAccountStatus.ACTIVE, StoreAccountStatus.SUSPENDED],
    to: StoreAccountStatus.INACTIVE,
    requiresReason: true,
    auditAction: 'platform.store.deactivate',
  },
  restore: {
    from: [StoreAccountStatus.INACTIVE],
    to: StoreAccountStatus.ACTIVE,
    requiresReason: false,
    auditAction: 'platform.store.restore',
  },
};

export const STORE_STATUS_ACTIONS = Object.keys(
  STORE_STATUS_TRANSITIONS,
) as StoreStatusAction[];

export const STORE_ACCOUNT_STATUS_LABELS: Readonly<
  Record<StoreAccountStatus, string>
> = {
  [StoreAccountStatus.ACTIVE]: 'Ativa',
  [StoreAccountStatus.SUSPENDED]: 'Suspensa',
  [StoreAccountStatus.INACTIVE]: 'Desativada',
};

export const STATUS_REASON_MAX_LENGTH = 300;
export const STATUS_REASON_REQUIRED_MESSAGE =
  'Informe o motivo (ele aparece para a equipe da loja e fica na auditoria).';

/** Explicação de uma transição que não vale a partir da situação atual. */
const INVALID_TRANSITION_MESSAGES: Record<
  StoreStatusAction,
  Partial<Record<StoreAccountStatus, string>>
> = {
  suspend: {
    [StoreAccountStatus.SUSPENDED]: 'A loja já está suspensa.',
    [StoreAccountStatus.INACTIVE]:
      'A loja está desativada. Restaure-a antes de suspendê-la.',
  },
  reactivate: {
    [StoreAccountStatus.ACTIVE]: 'A loja já está ativa.',
    [StoreAccountStatus.INACTIVE]:
      'A loja está desativada, não suspensa: use "restaurar" para reativá-la.',
  },
  deactivate: {
    [StoreAccountStatus.INACTIVE]: 'A loja já está desativada.',
  },
  restore: {
    [StoreAccountStatus.ACTIVE]: 'A loja já está ativa.',
    [StoreAccountStatus.SUSPENDED]:
      'A loja está suspensa, não desativada: use "reativar".',
  },
};

export type StoreStatusPlan =
  | {
      ok: true;
      action: StoreStatusAction;
      from: StoreAccountStatus;
      to: StoreAccountStatus;
      /** Novo stores.status_reason: o motivo ao suspender/desativar; null ao reativar/restaurar. */
      statusReason: string | null;
    }
  | { ok: false; message: string };

/** Confere a transição pedida a partir da situação atual e prepara a gravação. */
export function planStoreStatusChange(
  current: StoreAccountStatus,
  action: StoreStatusAction,
  reason?: string | null,
): StoreStatusPlan {
  const transition = STORE_STATUS_TRANSITIONS[action] as
    | StoreStatusTransition
    | undefined;
  if (!transition) {
    return { ok: false, message: 'Ação inválida para a situação da loja.' };
  }
  if (!transition.from.includes(current)) {
    return {
      ok: false,
      message:
        INVALID_TRANSITION_MESSAGES[action][current] ??
        `A loja não pode passar de "${STORE_ACCOUNT_STATUS_LABELS[current] ?? current}" para "${STORE_ACCOUNT_STATUS_LABELS[transition.to]}".`,
    };
  }
  const text = reason?.trim().slice(0, STATUS_REASON_MAX_LENGTH) || null;
  if (transition.requiresReason && !text) {
    return { ok: false, message: STATUS_REASON_REQUIRED_MESSAGE };
  }
  return {
    ok: true,
    action,
    from: current,
    to: transition.to,
    statusReason: transition.requiresReason ? text : null,
  };
}

export const DEFAULT_STORE_DEACTIVATED_WARNING =
  'Esta é a loja padrão: as rotas antigas sem o endereço da loja (app mobile e integrações da versão de loja única) passam a responder 404 até a loja ser restaurada ou outra loja padrão ser escolhida em Configurações da plataforma.';
export const DEFAULT_STORE_SUSPENDED_WARNING =
  'Esta é a loja padrão: as rotas antigas continuam respondendo, mas sem aceitar novos pedidos enquanto a loja estiver suspensa.';

/** Avisos da mudança (nunca bloqueiam): hoje, os efeitos sobre a loja padrão das rotas antigas. */
export function storeStatusWarnings(
  action: StoreStatusAction,
  context: { isDefaultStore: boolean },
): string[] {
  if (!context.isDefaultStore) return [];
  if (action === 'deactivate') return [DEFAULT_STORE_DEACTIVATED_WARNING];
  if (action === 'suspend') return [DEFAULT_STORE_SUSPENDED_WARNING];
  return [];
}
