import { createContext, useContext } from 'react';
import type { StoreAccess, StoreFeatures } from '../../services/storeAccess';
import type { StoreSettings } from '../../services/storeSettingsService';
import type { StoreSubscriptionOverview } from '../../services/storeSubscriptionService';
import type { StoreAccountStatus } from '../../types/saas';

/**
 * Situação da loja no painel (só para o Administrador, que tem acesso às rotas): GET /store/settings
 * (access e recursos do plano) e GET /store/subscription (plano, limites e uso). Alimenta as faixas de
 * aviso do layout e as telas que mostram limites do plano (Equipe, Cardápio).
 */
export interface PanelStoreData {
  /** true quando o layout consulta a situação da loja (perfil Administrador). */
  enabled: boolean;
  /** Situação da loja (vender, alterar, cobrança) e o aviso para a equipe. */
  access: StoreAccess | null;
  /** Recursos do plano (pagamentos online, relatórios, identidade visual). */
  features: StoreFeatures | null;
  /** Plano, assinatura, limites × uso e faturas (null até a primeira resposta ou se a rota falhar). */
  subscription: StoreSubscriptionOverview | null;
  /** Fuso da loja (IANA), que define o "hoje" dos relatórios (null até a primeira resposta). */
  timeZone: string | null;
  /** Sessão de suporte da plataforma: o painel é somente leitura. */
  readOnly: boolean;
  /**
   * Alterações bloqueadas (cardápio, equipe, configurações, abrir/fechar a loja): sessão de suporte ou loja
   * que a API diz não poder ser alterada (access.canManage = false). Sem a situação detalhada (perfis que não
   * leem /store/settings), vale a situação cadastral da sessão (loja suspensa). A API continua decidindo.
   */
  locked: boolean;
  /** Motivo do bloqueio (dica dos botões e avisos das telas), ou null quando nada está bloqueado. */
  lockReason: string | null;
  /** Consulta de novo a situação e a assinatura (ex.: depois de pagar, cancelar ou mudar configurações). */
  refresh: () => Promise<void>;
  /** Aproveita uma resposta de GET/PATCH /store/settings recebida por uma tela (sem nova consulta). */
  applySettings: (settings: StoreSettings) => void;
  /** Aproveita uma resposta de GET /store/subscription recebida por uma tela (sem nova consulta). */
  applySubscription: (overview: StoreSubscriptionOverview) => void;
}

const NO_PANEL: PanelStoreData = {
  enabled: false,
  access: null,
  features: null,
  subscription: null,
  timeZone: null,
  readOnly: false,
  locked: false,
  lockReason: null,
  refresh: () => Promise.resolve(),
  applySettings: () => undefined,
  applySubscription: () => undefined,
};

export const PanelStoreContext = createContext<PanelStoreData>(NO_PANEL);

export const SUPPORT_READ_ONLY_REASON = 'Sessão de suporte: somente leitura.';
const SUSPENDED_REASON = 'Estabelecimento suspenso pela plataforma: alterações bloqueadas.';

/**
 * Motivo de as alterações estarem bloqueadas (null = liberadas), na mesma ordem da API: sessão de suporte
 * (somente leitura) e depois a situação da loja (access.canManage; sem ela, a situação cadastral da sessão).
 */
export function panelLockReason(
  readOnly: boolean,
  access: StoreAccess | null,
  accountStatus: StoreAccountStatus | null | undefined,
): string | null {
  if (readOnly) return SUPPORT_READ_ONLY_REASON;
  if (access) return access.canManage ? null : access.message ?? 'A loja não pode ser alterada agora.';
  return accountStatus === 'SUSPENDED' ? SUSPENDED_REASON : null;
}

/** Situação da loja do painel. Fora do painel (ou para perfis sem acesso), devolve valores vazios. */
export function usePanelStore(): PanelStoreData {
  return useContext(PanelStoreContext);
}
