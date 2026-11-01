import axios, { type AxiosRequestConfig, type InternalAxiosRequestConfig } from 'axios';
import { BRAND, STORAGE_KEYS } from '../config/brand';

declare module 'axios' {
  interface AxiosRequestConfig {
    /**
     * true: um 401 nesta chamada não encerra a sessão (ex.: atualização do perfil em segundo plano).
     * A próxima ação do usuário com o token inválido encerra a sessão normalmente.
     */
    keepSessionOn401?: boolean;
    /**
     * true: a chamada sai sem a sessão desta aba (sem Authorization, sem renovação e sem conferir as outras
     * abas). Usado nas rotas que ABREM uma sessão sem estar logado (login, aceite de convite, cadastro de loja).
     */
    skipSessionAuth?: boolean;
    /** Interno: a chamada já foi repetida uma vez depois de renovar a sessão em cookie. */
    sessionRetried?: boolean;
  }
}

/** Endereço do backend (configurável via VITE_API_URL no .env). */
export const API_URL = ((import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:3000').replace(/\/+$/, '');

const api = axios.create({
  baseURL: API_URL,
});

// Cliente sem interceptadores: renovação e saída da sessão do site em cookie (/auth/web/*). Nunca leva
// Authorization e nunca dispara a própria renovação.
const authClient = axios.create({ baseURL: API_URL });

// --- TRANSPORTE DA SESSÃO ---
// cookie (padrão, VITE_AUTH_TRANSPORT=auto): o login devolve um token de acesso curto (15 min), guardado SÓ na
//   memória da aba, e a API grava o refresh num cookie HttpOnly (um script da página não o lê). O
//   localStorage guarda só um marcador sem segredo ({ v, sid, uid }) e o usuário, para as abas se
//   acompanharem. Cada aba renova o próprio token (POST /auth/web/refresh): na subida, a 80% da validade,
//   antes de uma chamada quando faltar menos de 30 s e depois de um 401 (uma vez, repetindo a chamada).
// bearer: o token de 7 dias no localStorage, como antes. Vale para sessões antigas (até expirarem), para a
//   sessão de suporte, para a API que respondeu session_transport 'bearer' (ex.: site e API em sites
//   diferentes) e para VITE_AUTH_TRANSPORT=bearer (kill switch, exige um build novo).

export type SessionTransport = 'cookie' | 'bearer';

/** auto: pede a sessão em cookie nas emissões; bearer: nunca pede (comportamento anterior). */
export const AUTH_TRANSPORT_MODE: 'auto' | 'bearer' =
  String(import.meta.env.VITE_AUTH_TRANSPORT ?? '').trim().toLowerCase() === 'bearer' ? 'bearer' : 'auto';

/** Cabeçalho que pede a sessão em cookie (o app mobile nunca envia). */
export const AUTH_TRANSPORT_HEADER = 'X-Auth-Transport';

/**
 * Configuração das rotas que abrem uma sessão sem estar logado (login, aceite de convite, cadastro de loja):
 * pede a sessão em cookie (cabeçalho + credenciais) e sai sem a sessão desta aba. No modo bearer, só o
 * skipSessionAuth.
 */
export function cookieAuthConfig(): AxiosRequestConfig {
  if (AUTH_TRANSPORT_MODE !== 'auto') return { skipSessionAuth: true };
  return { skipSessionAuth: true, withCredentials: true, headers: { [AUTH_TRANSPORT_HEADER]: 'cookie' } };
}

/**
 * Emissões feitas DE DENTRO de uma sessão (troca da própria senha, PATCH /users/:id da própria conta): pedem o
 * cookie só quando a sessão desta aba já é em cookie, para não converter sessões bearer (antigas, de suporte
 * ou dos testes). Mantém o Authorization desta aba.
 */
export function sessionEmissionConfig(): AxiosRequestConfig {
  if (AUTH_TRANSPORT_MODE !== 'auto' || tabTransport !== 'cookie') return {};
  return { withCredentials: true, headers: { [AUTH_TRANSPORT_HEADER]: 'cookie' } };
}

// --- SESSÃO DESTA ABA ---
// O localStorage é um só para todas as abas. Cada aba envia o token da sessão que ELA exibe (guardado em
// memória), e não o que estiver gravado no momento: se outra aba sair ou entrar com outra conta, esta aba
// nunca age com uma conta que não está mostrando. Ela adota a sessão nova pelo AuthContext (evento
// "storage" ou, se o aviso se perdeu, a próxima chamada, que é conferida abaixo). A sessão gravada é o token
// (bearer) ou, sem ele, o marcador da sessão em cookie: o token tem prioridade (ex.: a sessão de suporte
// aberta a partir de uma sessão do superpainel em cookie).

/** Marcador da sessão em cookie no localStorage: sem segredo (o id da sessão e da conta). */
export interface SessionMarker {
  v: 1;
  /** Sessão (claim "jti" do token): não muda nas renovações. */
  sid: string;
  uid: number;
}

/** Token gravado no navegador agora (null se não houver ou se o armazenamento estiver bloqueado). */
export function readStoredToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEYS.token) || null;
  } catch {
    return null;
  }
}

/** Marcador da sessão em cookie gravado agora (null se não houver, inválido ou armazenamento bloqueado). */
export function readSessionMarker(): SessionMarker | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.session);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionMarker> | null;
    if (!parsed || parsed.v !== 1 || typeof parsed.sid !== 'string' || parsed.sid === '') return null;
    const uid = Number(parsed.uid);
    return Number.isInteger(uid) && uid > 0 ? { v: 1, sid: parsed.sid, uid } : null;
  } catch {
    return null;
  }
}

/** Grava o marcador (mudança que as outras abas acompanham). */
export function writeSessionMarker(marker: SessionMarker): void {
  localStorage.setItem(STORAGE_KEYS.session, JSON.stringify(marker));
}

/** Identidade da sessão gravada no navegador: "bearer:<token>", "cookie:<sid>" ou null. */
export function storedSessionKey(): string | null {
  const token = readStoredToken();
  if (token) return `bearer:${token}`;
  const marker = readSessionMarker();
  return marker ? `cookie:${marker.sid}` : null;
}

/** Claims de um JWT sem conferir a assinatura (só para ler o jti da própria sessão). */
export function tokenClaims(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

let tabTransport: SessionTransport | null = null;
let sessionToken: string | null = null;
/** Sessão em cookie desta aba (jti), mesmo enquanto o token ainda não foi renovado. */
let tabSid: string | null = null;
/** Validade do token em cookie, no relógio local (calculada pelo expires_in relativo: imune a relógio errado). */
let accessExpiresAt = 0;
let accessTtlMs = 0;
let refreshTimer: number | undefined;

/** Identidade da sessão desta aba (mesmo formato de storedSessionKey). */
export function tabSessionKey(): string | null {
  if (tabTransport === 'bearer' && sessionToken) return `bearer:${sessionToken}`;
  if (tabTransport === 'cookie' && tabSid) return `cookie:${tabSid}`;
  return null;
}

/** Token da sessão exibida por esta aba (o que vai nas requisições). */
export function getSessionToken(): string | null {
  return sessionToken;
}

/** Transporte da sessão desta aba (null sem sessão). */
export function getSessionTransport(): SessionTransport | null {
  return tabTransport;
}

/** Id (jti) da sessão em cookie desta aba. */
export function getSessionId(): string | null {
  return tabSid;
}

function stopRefreshTimer(): void {
  if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
  refreshTimer = undefined;
}

/** Passa esta aba para uma sessão bearer (o AuthContext grava ou apaga o navegador e chama aqui). */
export function setSessionToken(token: string | null): void {
  stopRefreshTimer();
  sessionToken = token || null;
  tabTransport = sessionToken ? 'bearer' : null;
  tabSid = null;
  accessExpiresAt = 0;
}

/**
 * Passa esta aba para a sessão em cookie `sid` sem token ainda: a próxima chamada (ou refreshSession) renova
 * antes de sair. Usado na subida com o marcador e quando outra aba entrou.
 */
export function adoptCookieSession(sid: string): void {
  stopRefreshTimer();
  tabTransport = 'cookie';
  tabSid = sid;
  sessionToken = null;
  accessExpiresAt = 0;
}

/** Token de acesso novo da sessão em cookie (login ou renovação): guarda em memória e agenda a renovação. */
export function setCookieSession(token: string, expiresInSeconds: number): void {
  const jti = tokenClaims(token)?.jti;
  stopRefreshTimer();
  tabTransport = 'cookie';
  tabSid = typeof jti === 'string' && jti ? jti : tabSid;
  sessionToken = token;
  accessTtlMs = Math.max(expiresInSeconds, 1) * 1000;
  accessExpiresAt = Date.now() + accessTtlMs;
  // Renovação proativa a 80% da validade (no mínimo 5 s)
  refreshTimer = window.setTimeout(() => {
    refreshTimer = undefined;
    void refreshSession().then(handleBackgroundOutcome);
  }, Math.max(accessTtlMs * 0.8, 5_000));
}

/** Renova antes de uma chamada quando faltar menos que isto da validade do token. */
const REFRESH_MARGIN_MS = 30_000;

/** O token em cookie desta aba precisa ser renovado antes de uma chamada (falta pouco ou não há token)? */
function cookieTokenStale(marginMs = REFRESH_MARGIN_MS): boolean {
  return tabTransport === 'cookie' && (!sessionToken || accessExpiresAt - Date.now() < marginMs);
}

/**
 * Ao voltar para a aba (foco, visibilidade, rede): renova se o token em cookie já passou da renovação
 * proativa (os timers de abas em segundo plano atrasam) ou não existe.
 */
export function ensureFreshSession(): void {
  if (tabTransport !== 'cookie') return;
  if (!cookieTokenStale(Math.max(accessTtlMs * 0.2, REFRESH_MARGIN_MS))) return;
  void refreshSession().then(handleBackgroundOutcome);
}

/**
 * Adota a sessão gravada no navegador (registrado pelo AuthContext). Devolve true se a aba continua com a
 * mesma conta e o mesmo contexto (loja e sessão de suporte), ou seja, só o token mudou.
 */
type SessionSync = () => boolean;
let sessionSync: SessionSync | null = null;
// Entre a troca de conta e a tela nova aparecer, chamadas pedidas pela tela antiga não saem
let switchingSession = false;

export function registerSessionSync(sync: SessionSync | null): void {
  sessionSync = sync;
}

/** Marca o início (true) e o fim (false, quando a tela da sessão nova já foi montada) de uma troca de conta. */
export function setSessionSwitching(switching: boolean): void {
  switchingSession = switching;
}

/** Mensagem das chamadas canceladas porque a sessão do navegador mudou em outra aba. */
export const SESSION_CHANGED_MESSAGE = 'A sessão deste navegador mudou em outra aba. Confira a conta em uso e tente de novo.';

/** Chamada cancelada porque a sessão mudou em outra aba (não é falha de conexão nem da API). */
export function isSessionChangedError(error: unknown): boolean {
  return axios.isCancel(error) && (error as { message?: unknown }).message === SESSION_CHANGED_MESSAGE;
}

/** Adota a sessão gravada sem o AuthContext (antes de ele montar). */
function adoptStoredSession(): void {
  const token = readStoredToken();
  if (token) {
    setSessionToken(token);
    return;
  }
  const marker = readSessionMarker();
  if (marker) adoptCookieSession(marker.sid);
  else setSessionToken(null);
}

// --- RENOVAÇÃO DA SESSÃO EM COOKIE ---

/** Resposta de POST /auth/web/refresh (200). */
export interface RefreshedSession {
  access_token: string;
  expires_in: number;
  user: unknown;
}

/**
 * Resultado da renovação: ok; expired (401/403: a sessão acabou ou o cookie não vale mais); support (409:
 * há um suporte aberto a partir desta sessão); failed (sem conexão, 5xx ou 429: a sessão continua).
 */
export type RefreshOutcome =
  | { status: 'ok'; session: RefreshedSession }
  | { status: 'expired' | 'support' | 'failed' };

type RefreshListener = (session: RefreshedSession) => void;
let refreshListener: RefreshListener | null = null;

/** AuthContext: recebe o usuário atualizado de cada renovação bem-sucedida (perfil, loja, papel). */
export function registerRefreshListener(listener: RefreshListener | null): void {
  refreshListener = listener;
}

const REFRESH_TIMEOUT_MS = 15_000;
const REFRESH_LOCK = `${BRAND.slug}:refresh`;
let refreshPromise: Promise<RefreshOutcome> | null = null;

/**
 * Renova a sessão em cookie desta aba: uma promessa única por aba e, entre abas, o Web Lock
 * "comestra:refresh" (sem Web Locks, como em http num IP da rede local, a tolerância do servidor cobre a corrida).
 */
export function refreshSession(): Promise<RefreshOutcome> {
  if (AUTH_TRANSPORT_MODE !== 'auto') return Promise.resolve({ status: 'expired' });
  refreshPromise ??= runRefresh().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function runRefresh(): Promise<RefreshOutcome> {
  const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  try {
    if (locks && typeof locks.request === 'function') {
      return await locks.request(REFRESH_LOCK, () => postRefresh());
    }
  } catch {
    // Web Locks indisponível ou recusado: segue sem ele
  }
  return postRefresh();
}

async function postRefresh(): Promise<RefreshOutcome> {
  try {
    const { data } = await authClient.post<unknown>('/auth/web/refresh', undefined, {
      withCredentials: true,
      headers: { [AUTH_TRANSPORT_HEADER]: 'cookie' },
      timeout: REFRESH_TIMEOUT_MS,
    });
    const raw = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    const token = typeof raw.access_token === 'string' ? raw.access_token : '';
    const expiresIn = Number(raw.expires_in);
    if (!token || !Number.isFinite(expiresIn) || expiresIn <= 0 || !raw.user || typeof raw.user !== 'object') {
      return { status: 'failed' };
    }
    const session: RefreshedSession = { access_token: token, expires_in: expiresIn, user: raw.user };
    setCookieSession(token, expiresIn);
    refreshListener?.(session);
    return { status: 'ok', session };
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    if (status === 401 || status === 403) return { status: 'expired' };
    if (status === 409) return { status: 'support' };
    return { status: 'failed' };
  }
}

/**
 * Evento disparado quando uma chamada autenticada recebe 401 (token expirado, inválido ou usuário removido) ou
 * quando a renovação da sessão em cookie é recusada. detail.quiet = true: nenhuma chamada foi recusada (a
 * renovação falhou na subida, no timer, no foco ou antes de uma chamada): na vitrine a aba só fica sem login.
 */
export const SESSION_EXPIRED_EVENT = `${BRAND.slug}:session-expired`;

export interface SessionExpiredDetail {
  quiet: boolean;
}

/** Renovação em segundo plano (timer, foco): a sessão acabou → encerra sem uma chamada recusada (quiet). */
function handleBackgroundOutcome(outcome: RefreshOutcome): void {
  if (outcome.status === 'expired') expireTabSession(true);
}

/**
 * A sessão desta aba acabou (401 ou renovação recusada): apaga o navegador se ele ainda guarda ESTA sessão
 * (outra aba pode já estar com outra conta) e avisa o AuthContext. Numa sessão bearer aberta a partir de uma
 * sessão em cookie (suporte), só o token sai: o AuthContext tenta voltar à sessão em cookie.
 */
function expireTabSession(quiet = false): void {
  const key = tabSessionKey();
  if (!key) return;
  if (storedSessionKey() === key) {
    if (tabTransport === 'bearer' && readSessionMarker()) clearStoredToken();
    else clearStoredSession();
  } else {
    setSessionToken(null);
  }
  window.dispatchEvent(new CustomEvent<SessionExpiredDetail>(SESSION_EXPIRED_EVENT, { detail: { quiet } }));
}

/**
 * Apaga só o token bearer do navegador e desta aba (sessão de suporte aberta a partir de uma sessão do
 * superpainel em cookie): o marcador e o usuário ficam, e as abas voltam à sessão em cookie pela renovação.
 */
export function clearStoredToken(): void {
  setSessionToken(null);
  try {
    localStorage.removeItem(STORAGE_KEYS.token);
  } catch {
    // Armazenamento bloqueado: esta aba já saiu
  }
}

/**
 * Apaga a sessão deste app (token, marcador e usuário) do navegador e desta aba. O token e o marcador saem
 * primeiro: são as mudanças que as outras abas acompanham. Carrinho e tema não são tocados aqui.
 */
export function clearStoredSession(): void {
  setSessionToken(null);
  try {
    localStorage.removeItem(STORAGE_KEYS.token);
    localStorage.removeItem(STORAGE_KEYS.session);
    localStorage.removeItem(STORAGE_KEYS.user);
  } catch {
    // Armazenamento bloqueado: esta aba já saiu
  }
}

/**
 * POST /auth/web/logout (melhor esforço, 5 s): encerra no servidor a sessão do cookie deste navegador e apaga o
 * cookie. Funciona mesmo com o token de acesso vencido. true = 204.
 */
export async function webLogout(timeout = 5_000): Promise<boolean> {
  if (AUTH_TRANSPORT_MODE !== 'auto') return false;
  try {
    await authClient.post('/auth/web/logout', undefined, {
      withCredentials: true,
      headers: { [AUTH_TRANSPORT_HEADER]: 'cookie' },
      timeout,
    });
    return true;
  } catch {
    return false;
  }
}

// Interceptor: O "Porteiro" das requisições
api.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  // Rotas que abrem uma sessão sem estar logado: sem a sessão desta aba
  if (config.skipSessionAuth) return config;
  // Uma chamada que já traz o próprio cabeçalho é mantida como veio (ex.: conferir o token de uma sessão
  // de suporte antes de trocar a sessão, ou encerrar o suporte com o token do superpainel).
  if (config.headers.Authorization) return config;

  if (switchingSession) throw new axios.CanceledError(SESSION_CHANGED_MESSAGE);

  if (storedSessionKey() !== tabSessionKey()) {
    // Outra aba saiu, entrou ou trocou de conta e esta ainda não percebeu (aviso a caminho ou perdido)
    const hadSession = tabSessionKey() !== null;
    let sameAccount = true;
    if (sessionSync) sameAccount = sessionSync();
    else adoptStoredSession();
    // A chamada foi pedida pela tela da sessão anterior: não sai com outra conta nem depois da saída
    if (hadSession && !sameAccount) throw new axios.CanceledError(SESSION_CHANGED_MESSAGE);
  }

  // Sessão em cookie: renova antes quando falta pouco (uma rota com login opcional trataria como anônimo)
  if (cookieTokenStale()) {
    const outcome = await refreshSession();
    // A sessão acabou antes de a chamada sair: ela segue sem login (rotas públicas respondem como visitante)
    if (outcome.status === 'expired') expireTabSession(true);
  }

  if (sessionToken) config.headers.Authorization = `Bearer ${sessionToken}`;
  return config;
});

// Interceptor de resposta: um 401 numa chamada feita com o token desta aba encerra a sessão
// (o AuthContext escuta o evento e leva o usuário para a tela de login certa). Na sessão em cookie, antes
// disso renova uma vez e repete a chamada; só se a renovação for recusada a sessão termina (sem conexão, a
// sessão continua e a chamada falha como antes).
// O próprio login é ignorado (senha errada não derruba quem já está logado),
// assim como respostas atrasadas de uma sessão anterior e chamadas marcadas com keepSessionOn401.
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 401 &&
      error.config &&
      !error.config.keepSessionOn401 &&
      !error.config.skipSessionAuth &&
      !error.config.url?.includes('/auth/login')
    ) {
      const config = error.config;
      const sentAuthorization = String(config.headers?.Authorization ?? '');
      if (sessionToken && sentAuthorization === `Bearer ${sessionToken}`) {
        if (tabTransport === 'cookie' && !config.sessionRetried) {
          const outcome = await refreshSession();
          if (outcome.status === 'ok' && sessionToken) {
            config.sessionRetried = true;
            config.headers.Authorization = `Bearer ${sessionToken}`;
            return api.request(config);
          }
          // Sem conexão (a sessão continua) ou suporte aberto a partir desta sessão (outra aba já está nele)
          if (outcome.status !== 'expired') return Promise.reject(error);
        }
        expireTabSession();
      }
    }
    return Promise.reject(error);
  },
);

// Mensagens padrão do NestJS (em inglês) que não devem chegar ao usuário.
const GENERIC_API_MESSAGES = new Set(['Unauthorized', 'Forbidden', 'Forbidden resource', 'Internal server error', 'Bad Request', 'Not Found']);

/**
 * Converte um erro de requisição em texto para toast.
 * Ordem: texto fixo para o status (byStatus), mensagem do backend ({ message: string | string[] }), texto padrão.
 */
export function getApiErrorMessage(error: unknown, fallback: string, byStatus: Record<number, string> = {}): string {
  if (isSessionChangedError(error)) return SESSION_CHANGED_MESSAGE;
  if (!axios.isAxiosError(error)) return fallback;
  if (!error.response) return 'Não foi possível conectar ao servidor. Verifique se a API está em execução.';
  if (byStatus[error.response.status]) return byStatus[error.response.status];

  const raw = (error.response.data as { message?: unknown } | undefined)?.message;
  const messages = (Array.isArray(raw) ? raw : [raw]).filter(
    (m): m is string => typeof m === 'string' && m.trim() !== '' && !GENERIC_API_MESSAGES.has(m),
  );
  if (messages.length > 0) return messages.join(' • ');
  if (error.response.status === 403) return 'Seu perfil não tem permissão para esta ação.';
  return fallback;
}

/** Status HTTP de um erro de requisição (undefined sem resposta da API, ex.: sem conexão). */
export function getApiErrorStatus(error: unknown): number | undefined {
  return axios.isAxiosError(error) ? error.response?.status : undefined;
}

/**
 * Monta a URL pública de uma imagem servida pelo backend.
 * Aceita URL absoluta, caminho "/uploads/arquivo.webp" ou apenas o nome do arquivo.
 */
export function assetUrl(path?: string | null): string | undefined {
  if (!path) return undefined;
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  const clean = path.replace(/^\/+/, '');
  return `${API_URL}/${clean.startsWith('uploads/') ? clean : `uploads/${clean}`}`;
}

/** Host dos ícones prontos de avatar (os únicos endereços externos que a API aceita em users.avatar). */
export const AVATAR_ICON_HOST = 'cdn-icons-png.flaticon.com';

/**
 * URL da foto de perfil, só de fontes conhecidas: arquivo enviado (/uploads/... ou o nome do arquivo)
 * ou um ícone pronto (https://cdn-icons-png.flaticon.com/...). Qualquer outro endereço — avatares
 * externos antigos ainda no banco, http://, data: — não é carregado (a tela mostra as iniciais/ícone):
 * a imagem de terceiros revelaria a quem a hospeda quem abriu o painel.
 */
export function avatarUrl(avatar?: string | null): string | undefined {
  const value = avatar?.trim();
  if (!value) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === AVATAR_ICON_HOST && !url.username && !url.password && !url.port
        ? url.href
        : undefined;
    } catch {
      return undefined;
    }
  }
  const file = value.replace(/^\/+/, '').replace(/^uploads\//, '');
  return /^[A-Za-z0-9._-]+$/.test(file) && !file.startsWith('.') ? `${API_URL}/uploads/${file}` : undefined;
}

// --- LISTAS PAGINADAS (rotas novas da API) ---

/** Lista paginada das rotas novas: { items, total, page, pageSize }, pedida com ?page=1&pageSize=20. */
export type Paginated<T> = { items: T[]; total: number; page: number; pageSize: number };

/** Tamanho de página padrão das listas e o máximo aceito pela API. */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * Lê uma resposta paginada sem confiar no formato: campos ausentes ou inválidos viram valores seguros.
 * Uma lista simples (rota antiga, sem paginação) vira uma página única.
 */
export function normalizePaginated<T>(data: unknown, page = 1, pageSize = DEFAULT_PAGE_SIZE): Paginated<T> {
  if (Array.isArray(data)) {
    return { items: data as T[], total: data.length, page: 1, pageSize: Math.max(pageSize, data.length) };
  }
  const raw = (data && typeof data === 'object' ? data : {}) as Partial<Record<keyof Paginated<T>, unknown>>;
  const items = Array.isArray(raw.items) ? (raw.items as T[]) : [];
  const total = Number(raw.total);
  return {
    items,
    total: Number.isFinite(total) && total >= 0 ? Math.floor(total) : items.length,
    page: Number(raw.page) > 0 ? Math.floor(Number(raw.page)) : page,
    pageSize: Number(raw.pageSize) > 0 ? Math.floor(Number(raw.pageSize)) : pageSize,
  };
}

/** Valor aceito em uma query string; listas viram a mesma chave repetida (?status=A&status=B). */
export type QueryValue = string | number | boolean | null | undefined | Array<string | number | boolean>;

/**
 * Monta a query string (com "?") ignorando valores vazios: undefined, null, texto vazio (ou só espaços),
 * números inválidos e listas vazias. Textos são enviados sem espaços nas pontas.
 * Ex.: toQuery({ page: 2, search: ' pizza ', status: undefined }) → "?page=2&search=pizza".
 */
export function toQuery(params: Record<string, QueryValue>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item === undefined || item === null) continue;
      if (typeof item === 'number' && !Number.isFinite(item)) continue;
      const text = String(item).trim();
      if (text !== '') query.append(key, text);
    }
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}

/**
 * Valida um destino de redirecionamento (ex.: ?redirect=) para que ele nunca leve a outro site.
 * Aceita só caminhos internos: começam com "/", sem "//" (outro domínio), sem "\" (alguns navegadores
 * o tratam como "/") e sem caracteres de controle. Fora disso devolve o fallback (padrão: null).
 */
export function safeRedirect(path: unknown): string | null;
export function safeRedirect(path: unknown, fallback: string): string;
export function safeRedirect(path: unknown, fallback: string | null = null): string | null {
  if (typeof path !== 'string') return fallback;
  const value = path.trim();
  if (!value.startsWith('/') || value.includes('//') || value.includes('\\')) return fallback;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return fallback;
  }
  return value;
}

export default api;
