import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { storeService, type StoreStatus } from '../services/storeService';

interface StoreStatusContextData {
  /** Último status recebido da API (null até a primeira resposta). */
  status: StoreStatus | null;
  /** true só quando a API confirmou que a loja está fechada (sem resposta, a API valida no pedido). */
  isClosed: boolean;
  loading: boolean;
  /** Busca o status de novo (ex.: ao abrir o carrinho). */
  refresh: () => Promise<StoreStatus | null>;
  /** Abre ou fecha a loja (Administrador ou Atendente). Repassa o erro da API. */
  setOpen: (isOpen: boolean) => Promise<StoreStatus>;
}

const StoreStatusContext = createContext<StoreStatusContextData>({} as StoreStatusContextData);

// Mudanças feitas no painel chegam à vitrine na próxima consulta
const POLL_INTERVAL_MS = 30_000;

/** Status da loja compartilhado: selos do cabeçalho, vitrine, carrinho e controles da equipe. */
export function StoreStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<StoreStatus | null>(null);
  const [loading, setLoading] = useState(true);

  // Último status aplicado (para quem chama refresh/setOpen receber o valor atual sem depender do render)
  const statusRef = useRef<StoreStatus | null>(null);
  // Cada consulta recebe um número; uma resposta mais antiga que a última aplicada é descartada
  const lastReadId = useRef(0);
  const appliedReadId = useRef(0);
  const readsInFlight = useRef(0);
  // Muda no início e no fim de cada PATCH: consultas iniciadas antes disso trariam o status anterior
  const writeVersion = useRef(0);

  const applyStatus = useCallback((next: StoreStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const refresh = useCallback(async () => {
    const readId = ++lastReadId.current;
    const versionAtStart = writeVersion.current;
    readsInFlight.current += 1;
    try {
      const data = await storeService.getStatus();
      // Resposta velha: começou antes do último PATCH ou chegou depois de uma consulta mais nova
      if (versionAtStart !== writeVersion.current || readId < appliedReadId.current) return statusRef.current;
      appliedReadId.current = readId;
      applyStatus(data);
      return data;
    } catch {
      // Sem conexão com a API: mantém o último status conhecido
      return null;
    } finally {
      readsInFlight.current -= 1;
      setLoading(false);
    }
  }, [applyStatus]);

  useEffect(() => {
    refresh();
    // A consulta automática não se acumula: se a anterior ainda não respondeu, espera a próxima rodada
    const poll = () => {
      if (readsInFlight.current === 0) refresh();
    };
    const interval = window.setInterval(poll, POLL_INTERVAL_MS);
    // Ao voltar para a aba, atualiza na hora
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [refresh]);

  const setOpen = useCallback(async (isOpen: boolean) => {
    writeVersion.current += 1;
    try {
      const data = await storeService.updateStatus({ is_open: isOpen });
      const next: StoreStatus = typeof data?.is_open === 'boolean' ? data : { ...(statusRef.current ?? {}), is_open: isOpen };
      applyStatus(next);
      return next;
    } finally {
      writeVersion.current += 1;
    }
  }, [applyStatus]);

  const value = useMemo(
    () => ({ status, isClosed: status?.is_open === false, loading, refresh, setOpen }),
    [status, loading, refresh, setOpen],
  );

  return <StoreStatusContext.Provider value={value}>{children}</StoreStatusContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useStoreStatus() {
  return useContext(StoreStatusContext);
}
