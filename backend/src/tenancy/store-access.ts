/**
 * Regras puras de acesso de uma loja (sem banco, sem Nest). Cobertas por store-access.spec.ts.
 *
 * A loja pode vender e ser administrada conforme DUAS situações independentes:
 * - a situação da conta na plataforma (stores.account_status), decidida pelo superadministrador;
 * - a assinatura SaaS (subscriptions.status), que segue a cobrança.
 */
import { StoreAccountStatus } from '../store/entities/store.entity';
import {
  SubscriptionStatus,
  type SuspensionSource,
} from '../billing/entities/subscription.entity';

/**
 * O que uma requisição da equipe precisa poder fazer:
 * - read: consultar dados do painel (pedidos, cardápio, relatórios, configurações);
 * - operate: andar com os pedidos que já existem (status, entregador, cancelamento/estorno);
 * - manage: alterar cardápio, equipe, configurações e abrir a loja;
 * - billing: consultar e regularizar a assinatura.
 */
export type StoreCapability = 'read' | 'operate' | 'manage' | 'billing';

export type StoreAvailability =
  | 'OPERATIONAL'
  | 'PAST_DUE'
  | 'SUSPENDED'
  | 'SUBSCRIPTION_SUSPENDED'
  | 'SUBSCRIPTION_CANCELED'
  | 'NO_SUBSCRIPTION'
  | 'INACTIVE';

export interface StoreAccessState {
  availability: StoreAvailability;
  /** Aceita pedidos e pagamentos novos pela vitrine. */
  canSell: boolean;
  canRead: boolean;
  canOperate: boolean;
  canManage: boolean;
  canManageBilling: boolean;
  /** A vitrine abre (mesmo sem vender). Loja desativada não aparece. */
  publicVisible: boolean;
  /**
   * Aviso para a equipe (painel). Pode trazer o motivo interno (ex.: o texto da suspensão): o cliente
   * que tenta comprar recebe sempre STORE_UNAVAILABLE_MESSAGE (TenantService.assertCanSell).
   */
  message: string | null;
}

export interface StoreAccessInput {
  account_status: StoreAccountStatus;
  status_reason?: string | null;
}

export interface SubscriptionAccessInput {
  status: SubscriptionStatus;
  current_period_end?: Date | string | null;
  cancel_at_period_end?: boolean;
  grace_period_ends_at?: Date | string | null;
  /**
   * Quem suspendeu (subscriptions.suspended_by): PLATFORM (superadmin; só a reativação desfaz) ou
   * BILLING (fim da tolerância de uma cobrança vencida). Ausente/null → a causa é inferida pelas datas.
   */
  suspended_by?: SuspensionSource | null;
}

export const STORE_UNAVAILABLE_MESSAGE =
  'Esta loja está temporariamente indisponível para novos pedidos.';

/** Assinatura suspensa porque a tolerância de uma cobrança vencida acabou (causa conhecida). */
export const SUBSCRIPTION_UNPAID_MESSAGE =
  'A assinatura está suspensa por falta de pagamento. Regularize a cobrança para voltar a vender.';

/** Assinatura suspensa pela plataforma (suspended_by = PLATFORM) ou sem causa conhecida: mensagem neutra. */
export const SUBSCRIPTION_SUSPENDED_MESSAGE =
  'A assinatura da loja está suspensa. Fale com o suporte da plataforma para regularizar e voltar a vender.';

function time(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function state(
  availability: StoreAvailability,
  flags: Omit<StoreAccessState, 'availability'>,
): StoreAccessState {
  return { availability, ...flags };
}

/** Bloqueio de vendas que ainda deixa a equipe consultar, concluir pedidos e regularizar a cobrança. */
function blocked(
  availability: StoreAvailability,
  message: string,
): StoreAccessState {
  return state(availability, {
    canSell: false,
    canRead: true,
    canOperate: true,
    canManage: false,
    canManageBilling: true,
    publicVisible: true,
    message,
  });
}

/**
 * Situação efetiva da loja agora. A assinatura é avaliada pelas datas também, para não depender
 * de a rotina de cobrança já ter rodado (ex.: tolerância vencida há minutos = já suspensa).
 */
export function storeAccessState(
  store: StoreAccessInput,
  subscription: SubscriptionAccessInput | null,
  now: Date = new Date(),
): StoreAccessState {
  if (store.account_status === StoreAccountStatus.INACTIVE) {
    return state('INACTIVE', {
      canSell: false,
      canRead: false,
      canOperate: false,
      canManage: false,
      canManageBilling: false,
      publicVisible: false,
      message: 'Esta loja foi desativada na plataforma.',
    });
  }

  if (store.account_status === StoreAccountStatus.SUSPENDED) {
    const reason = store.status_reason?.trim();
    return blocked(
      'SUSPENDED',
      `Loja suspensa pela plataforma${reason ? `: ${reason}` : ''}. Novos pedidos estão bloqueados; os dados e o histórico continuam disponíveis.`,
    );
  }

  if (!subscription) {
    return blocked(
      'NO_SUBSCRIPTION',
      'A loja não tem uma assinatura ativa. Fale com o suporte da plataforma para escolher um plano.',
    );
  }

  const nowMs = now.getTime();
  const periodEnd = time(subscription.current_period_end);

  switch (subscription.status) {
    case SubscriptionStatus.TRIALING:
    case SubscriptionStatus.ACTIVE: {
      // Cancelamento agendado que já passou do fim do período (a rotina ainda vai marcar CANCELED)
      if (
        subscription.cancel_at_period_end &&
        periodEnd !== null &&
        periodEnd <= nowMs
      ) {
        return blocked(
          'SUBSCRIPTION_CANCELED',
          'A assinatura da loja foi cancelada. Contrate um plano para voltar a vender.',
        );
      }
      return state('OPERATIONAL', {
        canSell: true,
        canRead: true,
        canOperate: true,
        canManage: true,
        canManageBilling: true,
        publicVisible: true,
        message: null,
      });
    }
    case SubscriptionStatus.PAST_DUE: {
      const graceEnd = time(subscription.grace_period_ends_at);
      if (graceEnd !== null && graceEnd <= nowMs) {
        return blocked('SUBSCRIPTION_SUSPENDED', SUBSCRIPTION_UNPAID_MESSAGE);
      }
      return state('PAST_DUE', {
        canSell: true,
        canRead: true,
        canOperate: true,
        canManage: true,
        canManageBilling: true,
        publicVisible: true,
        message:
          'Há uma cobrança da assinatura em aberto. Regularize antes do fim da tolerância para evitar a suspensão da loja.',
      });
    }
    case SubscriptionStatus.SUSPENDED: {
      // A causa gravada decide: a suspensão pela plataforma pode ter outro motivo (e pagar não reativa),
      // então a mensagem é neutra, sem afirmar inadimplência, mesmo com uma cobrança vencida.
      // Sem a causa (registro anterior ou consulta que não a traz): a rotina suspende quando a
      // tolerância de uma cobrança vencida acaba (a data fica gravada).
      if (subscription.suspended_by === 'PLATFORM')
        return blocked(
          'SUBSCRIPTION_SUSPENDED',
          SUBSCRIPTION_SUSPENDED_MESSAGE,
        );
      if (subscription.suspended_by === 'BILLING')
        return blocked('SUBSCRIPTION_SUSPENDED', SUBSCRIPTION_UNPAID_MESSAGE);
      const graceEnd = time(subscription.grace_period_ends_at);
      return blocked(
        'SUBSCRIPTION_SUSPENDED',
        graceEnd !== null && graceEnd <= nowMs
          ? SUBSCRIPTION_UNPAID_MESSAGE
          : SUBSCRIPTION_SUSPENDED_MESSAGE,
      );
    }
    case SubscriptionStatus.CANCELED:
    default:
      return blocked(
        'SUBSCRIPTION_CANCELED',
        'A assinatura da loja foi cancelada. Contrate um plano para voltar a vender.',
      );
  }
}

export function hasCapability(
  access: StoreAccessState,
  capability: StoreCapability,
): boolean {
  switch (capability) {
    case 'read':
      return access.canRead;
    case 'operate':
      return access.canOperate;
    case 'manage':
      return access.canManage;
    case 'billing':
      return access.canManageBilling;
    default:
      return false;
  }
}

/** Mensagem do 403 quando a loja não permite a ação pedida. */
export function capabilityDeniedMessage(
  access: StoreAccessState,
  capability: StoreCapability,
): string {
  if (access.availability === 'INACTIVE') {
    return 'Esta loja foi desativada na plataforma. Fale com o suporte.';
  }
  if (capability === 'manage') {
    return `${access.message ?? 'A loja não pode ser alterada agora.'} Alterações no cardápio, na equipe e nas configurações estão bloqueadas.`;
  }
  return access.message ?? 'A loja não permite esta ação agora.';
}
