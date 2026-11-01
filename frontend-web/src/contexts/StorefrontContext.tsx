import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getApiErrorMessage, getApiErrorStatus } from '../services/api';
import { publicStoreService, type PublicStoreProfile } from '../services/publicStoreService';
import type { StoreStatus } from '../services/storeService';
import { usePolling } from '../hooks/usePolling';

/** loading: primeira carga · ready: loja aberta na vitrine · not_found: 404 · error: falha (com nova tentativa). */
export type StorefrontLoadState = 'loading' | 'ready' | 'not_found' | 'error';

export interface StorefrontContextValue {
  /** Slug da rota (/loja/:slug): é ele que identifica a loja nas chamadas da compra. */
  slug: string;
  loadState: StorefrontLoadState;
  /** Perfil público (null até carregar, e em not_found/error). */
  store: PublicStoreProfile | null;
  /** Motivo da falha da primeira carga (loadState 'error'). */
  loadError: string | null;
  /** Último status conhecido (do perfil ou de GET /stores/:slug/status). */
  status: StoreStatus | null;
  /** true só quando a API confirmou que a loja está fechada agora. */
  isClosed: boolean;
  /** false: a loja não pode vender (suspensa ou sem assinatura) — cardápio só para consulta. */
  orderingAvailable: boolean;
  /** Pode adicionar itens e finalizar pedidos agora (vende e está aberta). */
  canOrder: boolean;
  /** Mensagem da loja indisponível (unavailable_message ou um texto padrão). */
  unavailableMessage: string;
  /** Busca o status de novo (ex.: ao abrir o carrinho). */
  refreshStatus: () => Promise<StoreStatus | null>;
  /** Busca o perfil de novo sem indicar carregamento (pagamentos, entrega, disponibilidade). */
  refreshStore: () => Promise<void>;
  /** Nova tentativa depois de uma falha da primeira carga. */
  retry: () => void;
}

/** Pronto para a vitrine: o perfil da loja está carregado. */
export type ReadyStorefront = StorefrontContextValue & { loadState: 'ready'; store: PublicStoreProfile };

const StorefrontContext = createContext<StorefrontContextValue | null>(null);

// Mudanças feitas no painel (abrir/fechar) chegam à vitrine na próxima consulta
const STATUS_POLL_MS = 30_000;
// Perfil (pagamentos, entrega, situação da assinatura) muda pouco: conferido a cada 5 min e ao voltar para a aba
const PROFILE_POLL_MS = 5 * 60_000;

const DEFAULT_UNAVAILABLE_MESSAGE = 'Esta loja não está recebendo pedidos pelo site no momento.';

function statusFromProfile(profile: PublicStoreProfile): StoreStatus {
  return {
    id: profile.id,
    is_open: profile.is_open,
    opening_message: profile.opening_message,
    closing_message: profile.closing_message,
  };
}

/**
 * Loja da vitrine (/loja/:slug), montada pelo StoreLayout com key = slug:
 * - perfil público: GET /stores/:slug (404 → not_found);
 * - status: GET /stores/:slug/status a cada 30 s e ao voltar para a aba (usePolling: sem acumular consultas);
 * - controle de corrida: cada leitura (perfil ou status) recebe um número e uma resposta mais antiga que a
 *   última aplicada é descartada — um status (ou perfil) velho nunca sobrescreve um mais novo.
 */
export function StorefrontProvider({ slug, children }: { slug: string; children: ReactNode }) {
  const [store, setStore] = useState<PublicStoreProfile | null>(null);
  const [loadState, setLoadState] = useState<StorefrontLoadState>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<StoreStatus | null>(null);
  const [attempt, setAttempt] = useState(0);

  const statusRef = useRef<StoreStatus | null>(null);
  const lastReadId = useRef(0);
  // Última leitura aplicada ao status (perfil ou status) e ao perfil (só perfis)
  const appliedReadId = useRef(0);
  const appliedProfileReadId = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Aplica o status se a leitura for mais nova que a última aplicada. Devolve o status em vigor. */
  const applyStatus = useCallback((readId: number, next: StoreStatus): StoreStatus => {
    if (readId < appliedReadId.current) return statusRef.current ?? next;
    appliedReadId.current = readId;
    statusRef.current = next;
    setStatus(next);
    return next;
  }, []);

  const applyProfile = useCallback((readId: number, profile: PublicStoreProfile) => {
    // Perfil mais antigo que o último aplicado (duas atualizações ao mesmo tempo): descartado
    if (readId < appliedProfileReadId.current) return;
    appliedProfileReadId.current = readId;
    // Mesmo conteúdo: mantém o objeto (quem depende do perfil não renderiza à toa)
    setStore((current) => (current && JSON.stringify(current) === JSON.stringify(profile) ? current : profile));
    applyStatus(readId, statusFromProfile(profile));
  }, [applyStatus]);

  const markNotFound = useCallback(() => {
    setStore(null);
    setLoadState('not_found');
  }, []);

  // Primeira carga (e cada nova tentativa)
  useEffect(() => {
    const controller = new AbortController();
    const readId = ++lastReadId.current;
    publicStoreService.get(slug, controller.signal)
      .then((profile) => {
        applyProfile(readId, profile);
        setLoadError(null);
        setLoadState('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (getApiErrorStatus(error) === 404) {
          markNotFound();
          return;
        }
        setLoadError(getApiErrorMessage(error, 'Não foi possível abrir esta loja agora.'));
        setLoadState('error');
      });
    return () => controller.abort();
  }, [slug, attempt, applyProfile, markNotFound]);

  const refreshStatus = useCallback(async (): Promise<StoreStatus | null> => {
    const readId = ++lastReadId.current;
    try {
      const data = await publicStoreService.getStatus(slug);
      if (!alive.current) return null;
      return applyStatus(readId, data);
    } catch (error) {
      // Loja desativada enquanto a vitrine estava aberta; demais falhas mantêm o último status
      if (alive.current && getApiErrorStatus(error) === 404) markNotFound();
      return null;
    }
  }, [slug, applyStatus, markNotFound]);

  const refreshStore = useCallback(async (): Promise<void> => {
    const readId = ++lastReadId.current;
    try {
      const profile = await publicStoreService.get(slug);
      if (alive.current) applyProfile(readId, profile);
    } catch (error) {
      if (alive.current && getApiErrorStatus(error) === 404) markNotFound();
    }
  }, [slug, applyProfile, markNotFound]);

  const retry = useCallback(() => {
    setLoadError(null);
    setLoadState('loading');
    setAttempt((value) => value + 1);
  }, []);

  const ready = loadState === 'ready';
  usePolling(refreshStatus, STATUS_POLL_MS, { enabled: ready });
  usePolling(refreshStore, PROFILE_POLL_MS, { enabled: ready });

  const value = useMemo<StorefrontContextValue>(() => {
    const orderingAvailable = store?.ordering_available ?? true;
    const isClosed = status?.is_open === false;
    return {
      slug,
      loadState,
      store,
      loadError,
      status,
      isClosed,
      orderingAvailable,
      canOrder: !!store && orderingAvailable && !isClosed,
      unavailableMessage: store?.unavailable_message || DEFAULT_UNAVAILABLE_MESSAGE,
      refreshStatus,
      refreshStore,
      retry,
    };
  }, [slug, loadState, store, loadError, status, refreshStatus, refreshStore, retry]);

  return <StorefrontContext.Provider value={value}>{children}</StorefrontContext.Provider>;
}

/** Loja da vitrine, ou null fora de /loja/:slug (ex.: Meus Pedidos usa o layout da plataforma). */
// eslint-disable-next-line react-refresh/only-export-components
export function useOptionalStorefront(): StorefrontContextValue | null {
  return useContext(StorefrontContext);
}

/**
 * Loja da vitrine já carregada: as páginas da loja (cardápio, carrinho, confirmação) só são exibidas
 * pelo StoreLayout depois que o perfil chega, então aqui ele sempre existe.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useStorefront(): ReadyStorefront {
  const context = useContext(StorefrontContext);
  if (!context || context.loadState !== 'ready' || !context.store) {
    throw new Error('useStorefront deve ser usado nas páginas de uma loja já carregada (StoreLayout).');
  }
  return context as ReadyStorefront;
}
