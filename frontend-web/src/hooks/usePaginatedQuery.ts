import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, getApiErrorMessage, normalizePaginated, type Paginated, type QueryValue,
} from '../services/api';

/** Filtros de uma lista: viram parâmetros da query string (use toQuery no fetcher). */
export type QueryFilters = Record<string, QueryValue>;

export interface PaginatedFetchParams<F extends QueryFilters> {
  page: number;
  pageSize: number;
  /** Termo de busca sem espaços nas pontas ('' = sem busca). */
  search: string;
  filters: F;
  /** Repasse para o axios ({ signal }): a requisição é cancelada quando fica velha ou a tela fecha. */
  signal: AbortSignal;
}

export interface UsePaginatedQueryOptions<T, F extends QueryFilters> {
  /**
   * Busca uma página. Ex.:
   * ({ page, pageSize, search, filters, signal }) =>
   *   api.get<Paginated<Loja>>(`/platform/stores${toQuery({ page, pageSize, search, ...filters })}`, { signal }).then((r) => r.data)
   * Sempre a versão mais recente é usada; mudar a função não dispara uma nova busca (use reload).
   * A resposta é conferida (normalizePaginated): campos ausentes ou inválidos viram valores seguros.
   */
  fetcher: (params: PaginatedFetchParams<F>) => Promise<Paginated<T>>;
  initialFilters?: F;
  initialPage?: number;
  initialPageSize?: number;
  initialSearch?: string;
  /** Mensagem quando a API não explica o erro. */
  errorMessage?: string;
  /** false não busca (ex.: falta um parâmetro da rota). */
  enabled?: boolean;
}

export interface ReloadOptions {
  /** true: atualiza sem indicar carregamento (ex.: atualização automática); os dados atuais continuam na tela. */
  silent?: boolean;
}

export interface PaginatedQuery<T, F extends QueryFilters> {
  /** Itens da página atual (durante a troca de página/filtro, os da consulta anterior continuam até a nova chegar). */
  items: T[];
  total: number;
  totalPages: number;
  page: number;
  pageSize: number;
  /** Busca como digitada (passe para o SearchInput); a consulta usa o texto sem espaços nas pontas. */
  search: string;
  filters: F;
  /** Carregando dados para a página/busca/filtros atuais (primeira carga, troca ou recarga não silenciosa). */
  loading: boolean;
  /** Recarga silenciosa em andamento (os dados na tela são da mesma consulta). */
  refreshing: boolean;
  /** Erro da última consulta destes parâmetros (null durante um novo carregamento). */
  error: string | null;
  setPage: (page: number) => void;
  /** Muda o tamanho da página e volta para a primeira. */
  setPageSize: (pageSize: number) => void;
  /** Muda a busca; se o termo mudou, volta para a primeira página. */
  setSearch: (search: string) => void;
  /** Muda um filtro e volta para a primeira página. */
  setFilter: <K extends keyof F>(key: K, value: F[K]) => void;
  /** Troca todos os filtros e volta para a primeira página. */
  setFilters: (filters: F) => void;
  /** Volta aos filtros iniciais, sem busca, na primeira página. */
  reset: () => void;
  /** Busca de novo com os mesmos parâmetros; a Promise termina quando a resposta chega. */
  reload: (options?: ReloadOptions) => Promise<void>;
}

function clampPage(page: number): number {
  return Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
}

function clampPageSize(pageSize: number): number {
  return Number.isFinite(pageSize) ? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize))) : DEFAULT_PAGE_SIZE;
}

interface SettledRequest {
  requestKey: string;
  paramsKey: string;
  error: string | null;
}

/**
 * Lista paginada da API ({ items, total, page, pageSize }) com página, tamanho, busca e filtros.
 * - Só a resposta da consulta atual é aplicada: trocar de página/busca/filtro cancela a anterior
 *   (AbortSignal) e respostas velhas são descartadas.
 * - Se a página atual deixar de existir (ex.: itens excluídos), vai para a última página com itens.
 * - reload() refaz a consulta; com { silent: true } não pisca o carregamento (bom para usePolling).
 */
export function usePaginatedQuery<T, F extends QueryFilters = QueryFilters>(
  options: UsePaginatedQueryOptions<T, F>,
): PaginatedQuery<T, F> {
  const { enabled = true, errorMessage = 'Não foi possível carregar a lista.' } = options;

  const [initialFilters] = useState<F>(() => options.initialFilters ?? ({} as F));
  const [page, setPageState] = useState(() => clampPage(options.initialPage ?? 1));
  const [pageSize, setPageSizeState] = useState(() => clampPageSize(options.initialPageSize ?? DEFAULT_PAGE_SIZE));
  const [search, setSearchState] = useState(options.initialSearch ?? '');
  const [filters, setFiltersState] = useState<F>(initialFilters);
  const [reloadState, setReloadState] = useState({ token: 0, silent: false });

  // Último resultado com sucesso (com os parâmetros que o geraram) e a última consulta concluída (sucesso ou erro)
  const [data, setData] = useState<{ paramsKey: string; result: Paginated<T> } | null>(null);
  const [settled, setSettled] = useState<SettledRequest | null>(null);

  const fetcherRef = useRef(options.fetcher);
  const errorMessageRef = useRef(errorMessage);
  useEffect(() => {
    fetcherRef.current = options.fetcher;
    errorMessageRef.current = errorMessage;
  });

  // Quem chamou reload() espera a próxima resposta
  const pendingReloads = useRef<Array<() => void>>([]);

  const searchTerm = search.trim();
  const paramsKey = useMemo(() => JSON.stringify([page, pageSize, searchTerm, filters]), [page, pageSize, searchTerm, filters]);
  const requestKey = `${paramsKey}#${reloadState.token}`;

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let active = true;

    // Promise.resolve().then: um erro lançado direto pelo fetcher também vira estado de erro (não quebra a tela)
    Promise.resolve()
      .then(() => fetcherRef.current({ page, pageSize, search: searchTerm, filters, signal: controller.signal }))
      .then((response) => {
        if (!active) return;
        const result = normalizePaginated<T>(response, page, pageSize);
        setData({ paramsKey, result });
        setSettled({ requestKey, paramsKey, error: null });
        // A página pedida não existe mais: vai para a última com itens
        const lastPage = Math.max(1, Math.ceil(result.total / pageSize));
        if (result.items.length === 0 && page > lastPage) setPageState(lastPage);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setSettled({ requestKey, paramsKey, error: getApiErrorMessage(error, errorMessageRef.current) });
      })
      .finally(() => {
        if (active) pendingReloads.current.splice(0).forEach((resolve) => resolve());
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [enabled, page, pageSize, searchTerm, filters, paramsKey, requestKey]);

  // Saiu da tela: ninguém fica esperando um reload que não vai acontecer
  useEffect(() => {
    const pending = pendingReloads.current;
    return () => {
      pending.splice(0).forEach((resolve) => resolve());
    };
  }, []);

  const setPage = useCallback((next: number) => setPageState(clampPage(next)), []);

  const setPageSize = useCallback((next: number) => {
    setPageSizeState(clampPageSize(next));
    setPageState(1);
  }, []);

  const setSearch = useCallback((next: string) => {
    if (next === search) return;
    setSearchState(next);
    if (next.trim() !== search.trim()) setPageState(1);
  }, [search]);

  const setFilter = useCallback(<K extends keyof F>(key: K, value: F[K]) => {
    setFiltersState((previous) => (Object.is(previous[key], value) ? previous : { ...previous, [key]: value }));
    setPageState(1);
  }, []);

  const setFilters = useCallback((next: F) => {
    setFiltersState(next);
    setPageState(1);
  }, []);

  const reset = useCallback(() => {
    setFiltersState(initialFilters);
    setSearchState('');
    setPageState(1);
  }, [initialFilters]);

  const reload = useCallback((reloadOptions?: ReloadOptions) => new Promise<void>((resolve) => {
    if (!enabled) {
      resolve();
      return;
    }
    pendingReloads.current.push(resolve);
    setReloadState((previous) => ({ token: previous.token + 1, silent: !!reloadOptions?.silent }));
  }), [enabled]);

  // Estados derivados: sem setState durante a troca de parâmetros
  const settledHere = settled !== null && settled.paramsKey === paramsKey;
  const loading = enabled && (!settledHere || (settled.requestKey !== requestKey && !reloadState.silent));
  const refreshing = enabled && !loading && settled?.requestKey !== requestKey;
  const error = !loading && settledHere ? settled.error : null;
  // Durante o carregamento, os itens anteriores continuam na tela; depois de um erro com outros parâmetros, não
  const current = data && (data.paramsKey === paramsKey || loading) ? data.result : null;
  const total = current?.total ?? 0;

  return {
    items: current?.items ?? [],
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    page,
    pageSize,
    search,
    filters,
    loading,
    refreshing,
    error,
    setPage,
    setPageSize,
    setSearch,
    setFilter,
    setFilters,
    reset,
    reload,
  };
}
