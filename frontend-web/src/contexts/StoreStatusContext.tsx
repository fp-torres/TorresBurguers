import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { storeService, type StoreStatus } from '../services/storeService';
import { usePolling } from '../hooks/usePolling';

interface StoreStatusContextData {
  /** Último status recebido da API (null até a primeira resposta). */
  status: StoreStatus | null;
  /** true só quando a API confirmou que a loja está fechada (sem resposta, a API valida no pedido). */
  isClosed: boolean;
  /** Primeira consulta ainda sem resposta. */
  loading: boolean;
  /** Busca o status de novo (ex.: depois de salvar as mensagens da loja). */
  refresh: () => Promise<StoreStatus | null>;
  /** Abre ou fecha a loja (Administrador ou Atendente). Repassa o erro da API. */
  setOpen: (isOpen: boolean) => Promise<StoreStatus>;
}

/** Fora de um StoreStatusProvider: sem status, sem consultas e sem quebrar quem lê o contexto. */
const NO_PROVIDER: StoreStatusContextData = {
  status: null,
  isClosed: false,
  loading: false,
  refresh: () => Promise.resolve(null),
  setOpen: () => Promise.reject(new Error('O status da loja só pode ser alterado pelo painel da equipe.')),
};

const StoreStatusContext = createContext<StoreStatusContextData>(NO_PROVIDER);

// Mudanças feitas por outra pessoa da equipe chegam na próxima consulta
const POLL_INTERVAL_MS = 30_000;

interface StoreStatusProviderProps {
  children: ReactNode;
  /** Intervalo da atualização automática em ms (padrão: 30 s). Pausa com a aba oculta. */
  pollIntervalMs?: number;
}

/**
 * Status da loja do PAINEL (montado no DefaultLayout): GET /store/status com o token da equipe responde
 * a loja do usuário; PATCH /store/status abre/fecha a própria loja. Usado pelo StoreToggle (Dashboard,
 * Pedidos e Configurações). A vitrine de cada loja tem o próprio status (rota com o slug da loja).
 */
export function StoreStatusProvider({ children, pollIntervalMs = POLL_INTERVAL_MS }: StoreStatusProviderProps) {
  const [status, setStatus] = useState<StoreStatus | null>(null);
  const [loading, setLoading] = useState(true);

  // Último status aplicado (para quem chama refresh/setOpen receber o valor atual sem depender do render)
  const statusRef = useRef<StoreStatus | null>(null);
  // Cada consulta recebe um número; uma resposta mais antiga que a última aplicada é descartada
  const lastReadId = useRef(0);
  const appliedReadId = useRef(0);
  // Muda no início e no fim de cada PATCH: consultas iniciadas antes disso trariam o status anterior
  const writeVersion = useRef(0);

  const applyStatus = useCallback((next: StoreStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const refresh = useCallback(async () => {
    const readId = ++lastReadId.current;
    const versionAtStart = writeVersion.current;
    try {
      const data = await storeService.getStatus();
      // Resposta velha: começou antes do último PATCH ou chegou depois de uma consulta mais nova
      if (versionAtStart !== writeVersion.current || readId < appliedReadId.current) return statusRef.current;
      if (!data || typeof data.is_open !== 'boolean') return statusRef.current;
      appliedReadId.current = readId;
      applyStatus(data);
      return data;
    } catch {
      // Sem conexão com a API: mantém o último status conhecido
      return null;
    } finally {
      setLoading(false);
    }
  }, [applyStatus]);

  // Consulta ao montar e a cada intervalo; pausa com a aba oculta e atualiza na hora ao voltar.
  // A próxima consulta automática só é agendada quando a anterior termina (não acumula).
  usePolling(refresh, pollIntervalMs, { immediate: true });

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
