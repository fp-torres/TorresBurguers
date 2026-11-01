import { useCallback, useEffect, useRef, useState } from 'react';
import { getApiErrorMessage, getApiErrorStatus } from '../services/api';

export interface ReloadResourceOptions {
  /** true: atualiza sem indicar carregamento (ex.: atualização automática); os dados atuais continuam na tela. */
  silent?: boolean;
}

export interface ResourceState<T> {
  /** Último resultado com sucesso (continua disponível durante novas consultas e depois de um erro). */
  data: T | null;
  /** Carregando para os parâmetros atuais (primeira carga, troca de chave ou recarga não silenciosa). */
  loading: boolean;
  /** Recarga silenciosa em andamento. */
  refreshing: boolean;
  /** Os dados exibidos são de outra chave ou de antes da última recarga (ex.: período anterior). */
  stale: boolean;
  /** Mensagem do erro da última consulta (null durante um novo carregamento). */
  error: string | null;
  /** Status HTTP do último erro (ex.: 403 = recurso fora do plano; undefined sem resposta da API). */
  errorStatus: number | undefined;
  /** Consulta de novo; a Promise termina quando a resposta chega. */
  reload: (options?: ReloadResourceOptions) => Promise<void>;
  /** Substitui os dados (ex.: com a resposta de um PATCH), sem nova consulta. */
  setData: (updater: T | ((current: T | null) => T)) => void;
}

export interface UseResourceOptions {
  /** Muda a consulta (ex.: período do relatório). Mudar a chave busca de novo. */
  key?: string;
  /** false não busca. */
  enabled?: boolean;
  /** Mensagem quando a API não explica o erro. */
  errorMessage?: string;
}

interface Settled<T> {
  requestKey: string;
  data: T | null;
  error: string | null;
  status: number | undefined;
}

/**
 * Carrega um recurso da API (objeto único, não paginado) com cancelamento das consultas velhas,
 * estados de carregando/erro e recarga silenciosa (boa para usePolling). Usado pelo painel da loja,
 * pelo superpainel e pelas telas de conta (listas paginadas usam usePaginatedQuery).
 * Só a resposta da consulta atual é aplicada; a função `load` mais recente é sempre a usada.
 */
export function useResource<T>(load: (signal: AbortSignal) => Promise<T>, options: UseResourceOptions = {}): ResourceState<T> {
  const { key = '', enabled = true, errorMessage = 'Não foi possível carregar os dados.' } = options;
  const [reloadState, setReloadState] = useState({ token: 0, silent: false });
  const [settled, setSettled] = useState<Settled<T>>({ requestKey: '', data: null, error: null, status: undefined });

  const loadRef = useRef(load);
  const errorMessageRef = useRef(errorMessage);
  useEffect(() => {
    loadRef.current = load;
    errorMessageRef.current = errorMessage;
  });

  const pendingReloads = useRef<Array<() => void>>([]);
  const requestKey = `${key}#${reloadState.token}`;

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let active = true;

    // Promise.resolve().then: um erro lançado direto por `load` também vira estado de erro
    Promise.resolve()
      .then(() => loadRef.current(controller.signal))
      .then((data) => {
        if (active) setSettled({ requestKey, data, error: null, status: undefined });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setSettled((previous) => ({
          requestKey,
          data: previous.data,
          error: getApiErrorMessage(error, errorMessageRef.current),
          status: getApiErrorStatus(error),
        }));
      })
      .finally(() => {
        if (active) pendingReloads.current.splice(0).forEach((resolve) => resolve());
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [enabled, requestKey]);

  // Saiu da tela: ninguém fica esperando um reload que não vai acontecer
  useEffect(() => {
    const pending = pendingReloads.current;
    return () => {
      pending.splice(0).forEach((resolve) => resolve());
    };
  }, []);

  const reload = useCallback((reloadOptions?: ReloadResourceOptions) => new Promise<void>((resolve) => {
    if (!enabled) {
      resolve();
      return;
    }
    pendingReloads.current.push(resolve);
    setReloadState((previous) => ({ token: previous.token + 1, silent: !!reloadOptions?.silent }));
  }), [enabled]);

  const setData = useCallback((updater: T | ((current: T | null) => T)) => {
    setSettled((previous) => ({
      ...previous,
      data: typeof updater === 'function' ? (updater as (current: T | null) => T)(previous.data) : updater,
    }));
  }, []);

  const settledKey = settled.requestKey.slice(0, settled.requestKey.lastIndexOf('#'));
  const pending = enabled && settled.requestKey !== requestKey;
  // Recarga silenciosa da MESMA chave não mostra carregamento
  const loading = pending && !(reloadState.silent && settledKey === key && settled.requestKey !== '');
  const refreshing = pending && !loading;

  return {
    data: settled.data,
    loading,
    refreshing,
    stale: pending,
    error: loading ? null : settled.error,
    errorStatus: loading ? undefined : settled.status,
    reload,
    setData,
  };
}
