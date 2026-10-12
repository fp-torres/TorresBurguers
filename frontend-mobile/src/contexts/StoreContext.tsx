import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState } from 'react-native';

import api from '../services/api';
import { getErrorMessage } from '../utils/errors';

export interface StoreStatus {
  id?: number;
  is_open: boolean;
  opening_message?: string | null;
  closing_message?: string | null;
}

interface StoreContextData {
  /** null enquanto não carregou (ou se a API estiver fora do ar). */
  status: StoreStatus | null;
  /** Loja aberta. Status desconhecido não bloqueia: o backend valida de novo ao criar o pedido. */
  isOpen: boolean;
  /** Mensagem para exibir com a loja fechada (closing_message ou texto padrão). */
  closedMessage: string;
  refresh: () => Promise<StoreStatus | null>;
  /** Abre/fecha a loja (ADMIN e EMPLOYEE). */
  setOpen: (open: boolean) => Promise<StoreStatus>;
}

const DEFAULT_CLOSED_MESSAGE = 'Estamos fechados no momento. Volte mais tarde!';
const REFRESH_INTERVAL_MS = 60_000;

export const StoreContext = createContext<StoreContextData>({} as StoreContextData);

/** Status da loja (GET /store/status) compartilhado entre a vitrine, o carrinho e o painel. */
export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<StoreStatus | null>(null);
  const mounted = useRef(true);
  // Ordem das respostas: cada GET recebe um número ao sair e a alteração (PATCH) ao voltar,
  // e só se aplica uma resposta mais nova que a última aplicada. Assim um GET que saiu antes
  // de o PATCH terminar não desfaz na tela a abertura/fechamento da loja.
  const lastRequest = useRef(0);
  const lastApplied = useRef(0);

  const apply = useCallback((requestId: number, next: StoreStatus | null) => {
    if (!mounted.current || requestId < lastApplied.current) return;
    lastApplied.current = requestId;
    setStatus(next);
  }, []);

  const refresh = useCallback(async () => {
    const requestId = ++lastRequest.current;
    try {
      const { data } = await api.get<StoreStatus | null>('/store/status');
      const next = data && typeof data.is_open === 'boolean' ? data : null;
      apply(requestId, next);
      return next;
    } catch {
      return null;
    }
  }, [apply]);

  const setOpen = useCallback(async (open: boolean) => {
    const { data } = await api.patch<StoreStatus>('/store/status', { is_open: open });
    const next: StoreStatus = data && typeof data.is_open === 'boolean' ? data : { ...(status ?? {}), is_open: open };
    apply(++lastRequest.current, next);
    return next;
  }, [status, apply]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const interval = setInterval(refresh, REFRESH_INTERVAL_MS);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => {
      mounted.current = false;
      clearInterval(interval);
      subscription.remove();
    };
  }, [refresh]);

  const value = useMemo<StoreContextData>(() => ({
    status,
    isOpen: status ? status.is_open : true,
    closedMessage: status?.closing_message?.trim() || DEFAULT_CLOSED_MESSAGE,
    refresh,
    setOpen,
  }), [status, refresh, setOpen]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

/**
 * Abrir/fechar a loja pelo painel, sempre com confirmação (um toque sem querer não fecha a loja).
 * Usado pelo card da loja no Dashboard e pelo botão do quadro de pedidos.
 */
export function useStoreToggle() {
  const { isOpen, setOpen } = useContext(StoreContext);
  const [toggling, setToggling] = useState(false);
  const busyRef = useRef(false);

  const requestToggle = useCallback(() => {
    if (busyRef.current) return;
    const next = !isOpen;
    Alert.alert(
      next ? 'Abrir a loja?' : 'Fechar a loja?',
      next ? 'Os clientes voltarão a fazer pedidos.' : 'Os clientes não conseguirão fazer novos pedidos até a loja ser aberta.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: next ? 'Abrir' : 'Fechar',
          style: next ? 'default' : 'destructive',
          onPress: async () => {
            if (busyRef.current) return;
            busyRef.current = true;
            setToggling(true);
            try {
              await setOpen(next);
            } catch (error) {
              Alert.alert('Erro', getErrorMessage(error, 'Não foi possível alterar o status da loja.'));
            } finally {
              busyRef.current = false;
              setToggling(false);
            }
          },
        },
      ],
    );
  }, [isOpen, setOpen]);

  return { isOpen, toggling, requestToggle };
}
