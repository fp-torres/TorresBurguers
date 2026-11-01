import {
  Fragment, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { useNavigate, type NavigateFunction } from 'react-router-dom';
import toast from 'react-hot-toast';
import api, {
  SESSION_EXPIRED_EVENT, adoptCookieSession, clearStoredSession, clearStoredToken, ensureFreshSession, getApiErrorStatus,
  getSessionToken, getSessionTransport, readSessionMarker, readStoredToken, refreshSession, registerRefreshListener,
  registerSessionSync, setCookieSession, setSessionSwitching, setSessionToken, storedSessionKey, tabSessionKey, tokenClaims,
  writeSessionMarker, type RefreshedSession, type SessionExpiredDetail, type SessionTransport,
} from '../services/api';
import { authService, isAuthResponse, type AuthResponse } from '../services/authService';
import { BRAND, STORAGE_KEYS } from '../config/brand';
import { homePathForUser, isPlatformAdmin, isStaffRole, roleLabel, type PlatformRole, type UserRole } from '../utils/roles';
import { forgetLastStore } from '../utils/lastStore';
import { clearStoredCarts } from './cartStorage';
import type { SessionStore, StoreAccountStatus, SupportSessionInfo } from '../types/saas';

export interface User {
  id: number;
  name: string;
  email: string;
  role: UserRole;
  phone?: string;
  avatar?: string;
  /** Loja da equipe (null para clientes e para o superadministrador). */
  store_id: number | null;
  /** Papel global na plataforma ('SUPER_ADMIN') ou null. */
  platform_role: PlatformRole | null;
  /** Identidade e situação da loja da equipe (null para clientes e para a plataforma). */
  store: SessionStore | null;
  /** Presente só quando o token é de uma sessão de suporte (somente leitura, temporária). */
  support_session: SupportSessionInfo | null;
}

export interface SignOutOptions {
  /**
   * true: mantém os carrinhos e a última loja deste aparelho. Só quando a mesma pessoa continua no aparelho
   * (ex.: um cliente que entrou pelo login da equipe, ou quem acabou de redefinir a própria senha).
   * Padrão: sair apaga esses dados (aparelho compartilhado: a próxima pessoa não vê o carrinho de quem saiu).
   */
  keepLocalData?: boolean;
}

interface AuthContextData {
  user: User | null;
  isAuthenticated: boolean;
  /**
   * false enquanto a sessão restaurada do navegador ainda não foi conferida na API (primeira atualização).
   * Logins e sessões aplicadas nesta visita já nascem conferidos.
   */
  sessionChecked: boolean;
  signIn: (data: { email: string; password: string }) => Promise<User>;
  /**
   * Sai da conta neste navegador: sessão, carrinhos e última loja (o tema fica). No servidor (POST /auth/logout,
   * melhor esforço, sem esperar), o token deixa de valer; numa sessão de suporte, o suporte também é encerrado.
   */
  signOut: (options?: SignOutOptions) => void;
  updateUser: (user: User) => void;
  /** Busca o perfil atual na API (GET /auth/me) e aplica mudanças de nome, foto, perfil, loja ou papel global. */
  refreshUser: () => Promise<void>;
  /**
   * Aplica uma resposta { access_token, user } da API: grava o token e a sessão (por lista de campos permitidos).
   * Usada no login, depois de trocar a própria senha, ao aceitar um convite, ao redefinir a senha e ao cadastrar uma loja.
   * Lança erro se a resposta não tiver token ou usuário válidos.
   */
  applyAuthResponse: (data: AuthResponse) => User;
  /**
   * Superpainel: troca para o token de uma sessão de suporte (somente leitura no painel da loja).
   * Confere o token em GET /auth/me antes da troca e guarda a sessão do superpainel SÓ na memória desta aba
   * (nunca no armazenamento do navegador) para voltar depois.
   */
  beginSupportSession: (accessToken: string) => Promise<User>;
  /**
   * Encerra a sessão de suporte no servidor com o próprio token de suporte (POST /auth/logout) e volta para a
   * sessão do superpainel. Devolve false quando esta aba não tem mais a sessão do superpainel (página recarregada
   * ou suporte aberto em outra aba): a aba sai da conta e o superadministrador entra de novo pelo /login. Se a API
   * não confirmar o encerramento, ele é feito com o token do superpainel ou no próximo login do superadministrador.
   */
  endSupportSession: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextData>({} as AuthContextData);

// Áreas internas (painel da equipe e superpainel): sessão expirada nelas volta para /login;
// no resto (loja e conta do cliente), para o login da loja voltando à página atual.
const STAFF_AREA_PATHS = [
  '/dashboard', '/orders', '/products', '/users', '/trash', '/customers', '/settings', '/subscription', '/admin', '/platform',
];

// Ao voltar para a janela, o perfil é conferido no máximo uma vez a cada 15 s
const FOCUS_REFRESH_INTERVAL_MS = 15_000;

function isInStaffArea(pathname = window.location.pathname): boolean {
  return STAFF_AREA_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/** Login certo para quem teve a sessão encerrada: painel e superpainel → /login; loja e conta → /signin?redirect=. */
function expiredSessionPath(): string {
  const { pathname, search, hash } = window.location;
  if (isInStaffArea(pathname)) return '/login';
  return `/signin?redirect=${encodeURIComponent(`${pathname}${search}${hash}`)}`;
}

// --- LEITURA DA SESSÃO (sempre por lista de campos permitidos) ---

type RawRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Id positivo (número ou texto numérico) ou null. */
function toId(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

const ACCOUNT_STATUSES: readonly StoreAccountStatus[] = ['ACTIVE', 'SUSPENDED', 'INACTIVE'];

function toSessionStore(value: unknown): SessionStore | null {
  if (!isRecord(value)) return null;
  const id = toId(value.id);
  if (id === null || typeof value.slug !== 'string' || value.slug === '' || typeof value.name !== 'string') return null;
  return {
    id,
    slug: value.slug,
    name: value.name,
    logo: optionalText(value.logo) ?? null,
    primary_color: optionalText(value.primary_color) ?? null,
    // Sem a informação, a loja conta como ativa: quem decide o acesso é sempre a API
    account_status: ACCOUNT_STATUSES.find((status) => status === value.account_status) ?? 'ACTIVE',
  };
}

function toSupportSession(value: unknown): SupportSessionInfo | null {
  if (!isRecord(value)) return null;
  const id = toId(value.id);
  const storeId = toId(value.store_id);
  const expiresAt = optionalText(value.expires_at);
  if (id === null || storeId === null || !expiresAt) return null;
  return { id, store_id: storeId, expires_at: expiresAt };
}

/**
 * Usuário da sessão a partir da resposta da API (ou do que estava salvo). Só os campos abaixo são
 * guardados — nunca password_hash, token_version, blocked_reason ou outros dados da API.
 * Devolve null se faltar o id ou o perfil.
 */
function toSessionUser(data: unknown): User | null {
  if (!isRecord(data)) return null;
  const id = toId(data.id);
  if (id === null || typeof data.role !== 'string' || data.role === '') return null;

  const supportSession = toSupportSession(data.support_session);
  const store = toSessionStore(data.store);
  // Em uma sessão de suporte o superadmin age como Administrador da loja da sessão (mesma regra da API)
  const role = (supportSession && !isStaffRole(data.role) ? 'ADMIN' : data.role) as UserRole;
  const storeId = supportSession ? supportSession.store_id : toId(data.store_id) ?? store?.id ?? null;

  return {
    id,
    name: typeof data.name === 'string' ? data.name : '',
    email: typeof data.email === 'string' ? data.email : '',
    role,
    phone: optionalText(data.phone),
    avatar: optionalText(data.avatar),
    store_id: storeId,
    platform_role: data.platform_role === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : null,
    store: store && store.id === storeId ? store : null,
    support_session: supportSession,
  };
}

/** As sessões são montadas sempre na mesma ordem de campos por toSessionUser. */
function sameSessionUser(a: User, b: User): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Mesma conta no mesmo contexto (loja, papel global e sessão de suporte): só o token ou o perfil mudou. */
function sameContext(a: User, b: User): boolean {
  return a.id === b.id
    && a.store_id === b.store_id
    && a.platform_role === b.platform_role
    && (a.support_session?.id ?? null) === (b.support_session?.id ?? null);
}

interface StoredSession {
  /** bearer: o token está no navegador; cookie: só o marcador (o token de acesso vem da renovação). */
  transport: SessionTransport;
  /** Token bearer (null na sessão em cookie). */
  token: string | null;
  /** Sessão em cookie (jti), do marcador (null no bearer). */
  sid: string | null;
  user: User;
  /** Salva por uma versão anterior à multi-loja (sem store_id): loja e papel global chegam na primeira atualização. */
  legacy: boolean;
}

/** Identidade da sessão salva (mesmo formato de storedSessionKey/tabSessionKey do api.ts). */
function storedKeyOf(stored: StoredSession | null): string | null {
  if (!stored) return null;
  return stored.transport === 'bearer' ? `bearer:${stored.token}` : `cookie:${stored.sid}`;
}

/**
 * Lê a sessão salva sem alterar nada: o token (bearer) tem prioridade; sem ele, o marcador da sessão em cookie
 * da mesma conta do usuário salvo. null se faltar o token/marcador ou se o usuário estiver incompleto/corrompido.
 */
function parseStoredSession(): StoredSession | null {
  try {
    const token = localStorage.getItem(STORAGE_KEYS.token);
    const stored = localStorage.getItem(STORAGE_KEYS.user);
    if (!stored) return null;
    const parsed: unknown = JSON.parse(stored);
    const user = toSessionUser(parsed);
    if (!user) return null;
    const legacy = !isRecord(parsed) || !('store_id' in parsed);
    if (token) return { transport: 'bearer', token, sid: null, user, legacy };
    const marker = readSessionMarker();
    if (!marker || marker.uid !== user.id) return null;
    return { transport: 'cookie', token: null, sid: marker.sid, user, legacy };
  } catch {
    return null;
  }
}

/**
 * Restaura a sessão salva; dados incompletos ou corrompidos são descartados e campos fora da lista
 * permitida (ex.: gravados por outra versão) são removidos do navegador.
 */
function readStoredSession(): StoredSession | null {
  const stored = parseStoredSession();
  if (stored) {
    // Sessões antigas (sem store_id) são regravadas no formato atual depois da primeira conferência na API
    if (!stored.legacy) {
      try {
        const normalized = JSON.stringify(stored.user);
        if (localStorage.getItem(STORAGE_KEYS.user) !== normalized) localStorage.setItem(STORAGE_KEYS.user, normalized);
      } catch {
        // Armazenamento cheio ou bloqueado: a sessão em memória já está limpa
      }
    }
    return stored;
  }
  try {
    if (
      localStorage.getItem(STORAGE_KEYS.token)
      || localStorage.getItem(STORAGE_KEYS.session)
      || localStorage.getItem(STORAGE_KEYS.user)
    ) {
      clearStoredSession();
    }
  } catch {
    // Armazenamento bloqueado: segue sem sessão
  }
  return null;
}

/**
 * Grava a sessão bearer no navegador e passa esta aba a usá-la. O usuário é gravado ANTES do token: as outras
 * abas acompanham a troca do token e, quando ela chega, o usuário guardado já é o da sessão nova.
 * keepMarker: a sessão de suporte aberta a partir de uma sessão do superpainel em cookie mantém o marcador
 * dela (o token tem prioridade; ao encerrar o suporte, a aba volta à sessão em cookie pela renovação).
 */
function persistSession(token: string, user: User, keepMarker = false): void {
  localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(user));
  if (!keepMarker) localStorage.removeItem(STORAGE_KEYS.session);
  localStorage.setItem(STORAGE_KEYS.token, token);
  setSessionToken(token);
}

/**
 * Grava a sessão em cookie: o usuário e o marcador (sem segredo) no navegador; o token de acesso SÓ na memória
 * desta aba. Um token bearer que estava no navegador sai. O marcador é gravado por último (as outras abas
 * acompanham a troca por ele). Devolve false se o token não trouxer o id da sessão (jti).
 */
function persistCookieSession(token: string, expiresIn: number, user: User): boolean {
  const sid = tokenClaims(token)?.jti;
  if (typeof sid !== 'string' || sid === '') return false;
  localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(user));
  localStorage.removeItem(STORAGE_KEYS.token);
  localStorage.setItem(STORAGE_KEYS.session, JSON.stringify({ v: 1, sid, uid: user.id }));
  setCookieSession(token, expiresIn);
  return true;
}

/** Atualiza o perfil guardado só se o navegador ainda estiver com a sessão desta aba (outra aba pode ter trocado). */
function writeSessionUser(user: User): void {
  try {
    if (storedSessionKey() === tabSessionKey()) localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(user));
  } catch {
    // Armazenamento cheio ou bloqueado: a sessão segue em memória
  }
}

// --- SESSÃO DO SUPERPAINEL DURANTE UMA SESSÃO DE SUPORTE ---
// O token do superpainel fica SÓ na memória da aba que abriu o suporte, nunca no armazenamento do navegador:
// o painel da loja exibe conteúdo do lojista, e um script nesta origem não pode achar ali o token pleno do
// superadministrador. Recarregar a página (ou encerrar o suporte em outra aba) perde essa sessão: o
// superadministrador entra de novo.

interface PlatformStash {
  token: string;
  user: User;
}

/**
 * Versões anteriores guardavam a sessão do superpainel no localStorage: ela passa para a memória (se a sessão
 * atual for de suporte, ver AuthProvider) e sai do navegador. Lida uma vez, quando o app carrega.
 */
function takeStoredPlatformStash(): PlatformStash | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.platformSession);
    if (raw === null) return null;
    localStorage.removeItem(STORAGE_KEYS.platformSession);
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed.token !== 'string' || parsed.token === '') return null;
    const user = toSessionUser(parsed.user);
    // Só a sessão de um superadministrador (fora de suporte) pode ser restaurada
    return user && isPlatformAdmin(user) ? { token: parsed.token, user } : null;
  } catch {
    return null;
  }
}

const bootPlatformStash = takeStoredPlatformStash();

// Sessão de suporte que não pôde ser encerrada no servidor (a API não confirmou o logout com o token de suporte e
// esta aba não tem o token do superpainel): guarda só o id (nunca um token) e encerra no próximo login do
// superadministrador neste navegador.
const SUPPORT_SESSION_TO_END_KEY = `${BRAND.slug}.supportSessionToEnd`;

function rememberSupportSessionToEnd(session: SupportSessionInfo): void {
  try {
    localStorage.setItem(SUPPORT_SESSION_TO_END_KEY, JSON.stringify({ id: session.id, expires_at: session.expires_at }));
  } catch {
    // Armazenamento bloqueado: a sessão de suporte expira sozinha
  }
}

/** Id da sessão de suporte pendente (ainda no prazo), removendo o registro. */
function takeSupportSessionToEnd(): number | null {
  try {
    const raw = localStorage.getItem(SUPPORT_SESSION_TO_END_KEY);
    if (raw === null) return null;
    localStorage.removeItem(SUPPORT_SESSION_TO_END_KEY);
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const id = toId(parsed.id);
    const expiresAt = typeof parsed.expires_at === 'string' ? Date.parse(parsed.expires_at) : Number.NaN;
    return id !== null && (Number.isNaN(expiresAt) || expiresAt > Date.now()) ? id : null;
  } catch {
    return null;
  }
}

/** Encerra a sessão de suporte no servidor com o token do superpainel (melhor esforço: ela também expira sozinha). */
function endSupportSessionOnServer(sessionId: number, platformToken: string): Promise<void> {
  return api
    .post(`/platform/support-sessions/${sessionId}/end`, undefined, {
      headers: { Authorization: `Bearer ${platformToken}` },
      keepSessionOn401: true,
    })
    .then(() => undefined, () => undefined);
}

/**
 * Encerra no servidor a sessão de suporte que esta aba deixou, com o PRÓPRIO token de suporte (POST /auth/logout,
 * sem depender do token do superpainel). Se a API não confirmar (sem conexão ou API antiga), usa o token do
 * superpainel guardado nesta aba ou, sem ele, encerra no próximo login do superadministrador neste navegador.
 */
async function endSupportOnServer(support: SupportSessionInfo, supportToken: string | null, platformToken: string | null): Promise<void> {
  if (supportToken && (await authService.logout(supportToken))) return;
  if (platformToken) await endSupportSessionOnServer(support.id, platformToken);
  else rememberSupportSessionToEnd(support);
}

/**
 * Sair (melhor esforço, a tela não espera): o token da sessão que esta aba deixou deixa de valer no servidor; numa
 * sessão de suporte, o suporte também é encerrado; a sessão do superpainel guardada nesta aba é encerrada depois
 * (ela pode ser necessária para encerrar o suporte).
 */
async function endSessionsOnServer(
  token: string | null,
  support: SupportSessionInfo | null,
  stash: PlatformStash | null,
  bearer: boolean,
  cookieSession: boolean,
): Promise<void> {
  if (support) await endSupportOnServer(support, token, stash?.token ?? null);
  else if (token && bearer) await authService.logout(token);
  // Sessão em cookie (inclusive a do superpainel durante um suporte): POST /auth/web/logout encerra a sessão do
  // cookie e apaga o cookie, mesmo com o token de acesso vencido
  if (cookieSession) await authService.webLogout();
  if (stash) await authService.logout(stash.token);
}

/** Apaga os dados de compra deste aparelho (carrinhos de todas as lojas e a última loja visitada). */
function clearShoppingData(): void {
  forgetLastStore();
  clearStoredCarts();
}

/**
 * Perfil atual na API: GET /auth/me; numa API sem essa rota (404), GET /users/:id (compatibilidade).
 * Um 401 aqui não encerra a sessão (keepSessionOn401): a próxima ação do usuário com o token inválido encerra.
 */
async function fetchSessionUser(current: User): Promise<User | null> {
  try {
    return toSessionUser(await authService.me({ keepSessionOn401: true }));
  } catch (error) {
    // Sessão de suporte só existe com /auth/me: não há rota antiga equivalente
    if (getApiErrorStatus(error) !== 404 || current.support_session) throw error;
  }

  const { data } = await api.get<unknown>(`/users/${current.id}`, { keepSessionOn401: true });
  const fresh = toSessionUser(data);
  // A rota antiga não traz a loja: mantém a que já estava na sessão se o vínculo continua o mesmo
  if (fresh && !fresh.store && current.store && fresh.store_id === current.store_id) return { ...fresh, store: current.store };
  return fresh;
}

/** Perfil, loja ou papel global mudou: avisa e, numa área interna, leva à página inicial do novo acesso. */
function announceAccessChange(previous: User, next: User, legacy: boolean, navigate: NavigateFunction): void {
  const roleChanged = next.role !== previous.role;
  // Sessões salvas antes da multi-loja não tinham loja nem papel global: preencher não é mudança
  const storeChanged = !legacy && next.store_id !== previous.store_id;
  const platformChanged = !legacy && next.platform_role !== previous.platform_role;
  if (!roleChanged && !storeChanged && !platformChanged) return;

  const options = { icon: '🔄', id: 'access-changed', duration: 6000 };
  if (platformChanged) {
    toast(next.platform_role ? 'Seu acesso ao superpainel foi liberado.' : 'Seu acesso ao superpainel foi removido.', options);
  } else if (storeChanged) {
    toast(next.store ? `Sua conta agora está vinculada a ${next.store.name}.` : 'Sua conta não está mais vinculada a este estabelecimento.', options);
  } else {
    toast(`Seu perfil de acesso agora é ${roleLabel(next.role)}.`, options);
  }

  if (isInStaffArea()) navigate(homePathForUser(next), { replace: true });
}

// Outra aba trocou a sessão: espera as gravações em sequência (ex.: sair e restaurar o superpainel) assentarem
const SESSION_SYNC_DELAY_MS = 50;
// Se a tela da sessão nova não for montada por algum motivo, as chamadas voltam a sair depois deste prazo
const SESSION_SWITCH_TIMEOUT_MS = 2_000;

/** Lê a sessão salva ao abrir o app e passa esta aba a usá-la (idempotente: o StrictMode chama duas vezes). */
function initialSessionState(): StoredSession | null {
  const stored = readStoredSession();
  adoptStored(stored);
  return stored;
}

/** Passa esta aba para a sessão salva: bearer (o token), em cookie (renova antes da próxima chamada) ou nenhuma. */
function adoptStored(stored: StoredSession | null): void {
  if (stored?.transport === 'cookie' && stored.sid) adoptCookieSession(stored.sid);
  else setSessionToken(stored?.token ?? null);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [initialSession] = useState(initialSessionState);
  const [user, setUser] = useState<User | null>(initialSession?.user ?? null);
  const [sessionChecked, setSessionChecked] = useState(!initialSession);
  // Muda quando outra aba troca a conta/contexto deste navegador: a tela da sessão anterior é desmontada
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const navigate = useNavigate();
  const lastRefresh = useRef(0);
  // Usuário exibido por esta aba (lido pelos callbacks sem depender de re-renderização)
  const userRef = useRef<User | null>(initialSession?.user ?? null);
  // Sessão salva por uma versão anterior à multi-loja: a primeira conferência na API completa a loja
  const legacyRef = useRef(initialSession?.legacy ?? false);
  // Sessão do superpainel guardada (só em memória) durante uma sessão de suporte aberta nesta aba
  const stashRef = useRef<PlatformStash | null>(initialSession?.user.support_session ? bootPlatformStash : null);
  const switchTimer = useRef<number | undefined>(undefined);

  // useNavigate muda a cada troca de página; a atualização do perfil usa sempre a versão mais recente
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  const showUser = useCallback((next: User | null) => {
    userRef.current = next;
    setUser(next);
  }, []);

  // Fluxo desta aba que troca a sessão pela renovação (encerrar o suporte, voltar ao superpainel): a renovação
  // só aplica o usuário, sem o aviso de "a sessão mudou em outra aba"
  const quietSwitchRef = useRef(false);

  /**
   * Esta aba passa a exibir outra conta ou outro contexto (outra aba entrou, saiu, trocou de conta, abriu ou
   * encerrou um suporte): a tela da sessão anterior é desmontada e, até a nova aparecer, nenhuma chamada pedida
   * por ela sai com a conta nova.
   */
  const switchToUser = useCallback((next: User | null, announce: boolean) => {
    const current = userRef.current;
    stashRef.current = null;
    showUser(next);
    if (current) {
      setSessionSwitching(true);
      window.clearTimeout(switchTimer.current);
      switchTimer.current = window.setTimeout(() => setSessionSwitching(false), SESSION_SWITCH_TIMEOUT_MS);
      setSessionEpoch((epoch) => epoch + 1);
      if (announce) {
        toast(
          next ? `A sessão mudou em outra aba: agora você está como ${next.name || next.email}.` : 'Você saiu da conta em outra aba.',
          { id: 'session-changed', icon: '🔄', duration: 6000 },
        );
      }
    }
    if (isInStaffArea()) navigateRef.current(next ? homePathForUser(next) : '/login', { replace: true });
  }, [showUser]);

  // O token vai em todas as requisições pelo interceptor do api.ts (o da sessão desta aba).
  const applyAuthResponse = useCallback((data: AuthResponse): User => {
    const token = typeof data?.access_token === 'string' ? data.access_token : '';
    const sessionUser = token ? toSessionUser(data.user) : null;
    if (!token || !sessionUser) throw new Error('Resposta de autenticação inválida.');

    // Nova sessão: a do superpainel guardada durante um suporte deixa de valer
    stashRef.current = null;
    const expiresIn = Number(data.expires_in);
    const cookie = data.session_transport === 'cookie'
      && Number.isFinite(expiresIn)
      && expiresIn > 0
      && persistCookieSession(token, expiresIn, sessionUser);
    if (!cookie) persistSession(token, sessionUser);
    legacyRef.current = false;
    lastRefresh.current = Date.now();
    setSessionChecked(true);
    showUser(sessionUser);

    // Sessão de suporte que ficou aberta (encerrada sem a sessão do superpainel nesta aba): encerra agora
    if (isPlatformAdmin(sessionUser)) {
      const pendingSupport = takeSupportSessionToEnd();
      if (pendingSupport !== null) void endSupportSessionOnServer(pendingSupport, token);
    }
    return sessionUser;
  }, [showUser]);

  const signIn = useCallback(async ({ email, password }: { email: string; password: string }) => {
    const data = await authService.login(email.trim(), password);
    if (!isAuthResponse(data)) throw new Error('Resposta de login inválida.');
    return applyAuthResponse(data);
  }, [applyAuthResponse]);

  // Sair remove a sessão (token, marcador, usuário e a sessão do superpainel guardada) e, salvo keepLocalData, os
  // carrinhos e a última loja deste aparelho. O tema continua salvo. No servidor (sem a tela esperar): o token
  // bearer deixa de valer (POST /auth/logout), a sessão em cookie é encerrada (POST /auth/web/logout) e, durante o
  // suporte, a sessão de suporte também.
  const signOut = useCallback((options: SignOutOptions = {}) => {
    const token = getSessionToken();
    const bearer = getSessionTransport() === 'bearer';
    const cookieSession = getSessionTransport() === 'cookie' || readSessionMarker() !== null;
    const support = userRef.current?.support_session ?? null;
    const stash = stashRef.current;
    stashRef.current = null;
    clearStoredSession();
    if (!options.keepLocalData) clearShoppingData();
    showUser(null);
    void endSessionsOnServer(token, support, stash, bearer, cookieSession);
  }, [showUser]);

  const updateUser = useCallback((updatedUser: User) => {
    const sessionUser = toSessionUser({ ...userRef.current, ...updatedUser });
    if (!sessionUser) return;
    writeSessionUser(sessionUser);
    showUser(sessionUser);
  }, [showUser]);

  /**
   * Adota a sessão gravada no navegador quando ela não é mais a desta aba (outra aba entrou, saiu, trocou de
   * conta ou abriu/encerrou um suporte). Devolve true se a aba continua com a mesma conta e o mesmo contexto.
   * Sessão em cookie de outra aba: esta descarta o token em memória e renova (o cookie é do navegador).
   */
  const syncWithStorage = useCallback((): boolean => {
    const stored = parseStoredSession();
    const current = userRef.current;

    if (storedKeyOf(stored) === tabSessionKey()) {
      // Mesma sessão: acompanha o perfil atualizado por outra aba (mesma conta e mesmo contexto)
      if (stored && current && !sameSessionUser(stored.user, current) && sameContext(stored.user, current)) {
        showUser(stored.user);
        announceAccessChange(current, stored.user, false, navigateRef.current);
      }
      return true;
    }

    adoptStored(stored);
    if (stored?.transport === 'cookie') void refreshSession();
    lastRefresh.current = Date.now();
    legacyRef.current = false;
    setSessionChecked(true);

    if (stored && current && sameContext(stored.user, current)) {
      // Mesma conta e contexto (ex.: entrou de novo ou trocou a senha em outra aba): só o token mudou
      if (!sameSessionUser(stored.user, current)) showUser(stored.user);
      return true;
    }

    // Outra conta, outra loja, início ou fim de um suporte, ou saída: esta aba passa para a sessão atual
    switchToUser(stored?.user ?? null, true);
    return false;
  }, [showUser, switchToUser]);

  // A tela da sessão nova foi montada: as chamadas voltam a sair (antes dos efeitos que carregam os dados)
  useLayoutEffect(() => {
    window.clearTimeout(switchTimer.current);
    setSessionSwitching(false);
  }, [sessionEpoch]);

  /**
   * Renovação bem-sucedida da sessão em cookie (qualquer origem: subida, timer, antes de uma chamada, depois de um
   * 401): aplica o perfil atual. Se o cookie do navegador já for de outra conta (outra aba entrou e esta ainda não
   * percebeu), a aba passa para ela.
   */
  const applyRefreshed = useCallback((session: RefreshedSession) => {
    const fresh = toSessionUser(session.user);
    if (!fresh) return;
    const current = userRef.current;
    lastRefresh.current = Date.now();
    legacyRef.current = false;
    setSessionChecked(true);
    try {
      // O marcador acompanha a sessão do cookie (ex.: renovada depois de entrar em outra aba)
      const marker = readSessionMarker();
      const sid = tokenClaims(session.access_token)?.jti;
      if (!readStoredToken() && typeof sid === 'string' && (marker?.sid !== sid || marker.uid !== fresh.id)) {
        localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(fresh));
        writeSessionMarker({ v: 1, sid, uid: fresh.id });
      } else {
        writeSessionUser(fresh);
      }
    } catch {
      // Armazenamento bloqueado: a sessão segue em memória
    }
    if (quietSwitchRef.current || !current) {
      showUser(fresh);
      return;
    }
    if (!sameContext(fresh, current)) {
      switchToUser(fresh, true);
      return;
    }
    if (!sameSessionUser(fresh, current)) {
      showUser(fresh);
      announceAccessChange(current, fresh, false, navigateRef.current);
    }
  }, [showUser, switchToUser]);

  useEffect(() => {
    registerRefreshListener(applyRefreshed);
    return () => registerRefreshListener(null);
  }, [applyRefreshed]);

  // Perfil alterado em outro lugar (ex.: um Administrador mudou o cargo ou a plataforma mudou a loja):
  // a sessão acompanha a API. A comparação é com o usuário que esta aba exibe.
  const refreshUser = useCallback((): Promise<void> => Promise.resolve().then(async () => {
    // Outra aba pode ter trocado a sessão sem esta perceber (ex.: aba congelada): adota a gravada antes
    syncWithStorage();
    const current = userRef.current;

    // Sessão em cookie sem token (subida) ou perto de vencer: a renovação já traz o perfil atual
    if (current && getSessionTransport() === 'cookie' && !getSessionToken()) {
      const outcome = await refreshSession();
      if (outcome.status === 'expired' && getSessionTransport() === 'cookie' && !getSessionToken()) {
        // A sessão do navegador acabou (vencida, encerrada em outro aparelho): o carrinho fica; no painel, /login
        clearStoredSession();
        showUser(null);
        if (isInStaffArea()) {
          toast.error('Sua sessão expirou. Faça login novamente.', { id: 'session-expired' });
          navigateRef.current('/login', { replace: true });
        }
      }
      setSessionChecked(true);
      return;
    }

    const token = getSessionToken();
    if (!current || !token) {
      setSessionChecked(true);
      return;
    }
    const legacy = legacyRef.current;
    lastRefresh.current = Date.now();

    return fetchSessionUser(current)
      .then((fresh) => {
        const latest = userRef.current;
        // Saiu ou trocou de conta/sessão enquanto a consulta estava em andamento
        if (!fresh || !latest || getSessionToken() !== token || fresh.id !== latest.id) return;
        legacyRef.current = false;
        if (sameSessionUser(fresh, latest)) {
          // Sessão salva por uma versão anterior: passa para o formato atual sem mudança visível
          if (legacy) writeSessionUser(fresh);
          return;
        }

        writeSessionUser(fresh);
        showUser(fresh);
        announceAccessChange(latest, fresh, legacy, navigateRef.current);
      })
      .catch(() => {
        // Sem conexão ou sessão inválida: segue com o que está salvo
      })
      .finally(() => setSessionChecked(true));
  }), [showUser, syncWithStorage]);

  const beginSupportSession = useCallback(async (accessToken: string): Promise<User> => {
    const platformUser = userRef.current;
    const platformToken = getSessionToken();
    const cookiePlatform = getSessionTransport() === 'cookie';
    if (!platformUser || !platformToken || !isPlatformAdmin(platformUser)) {
      throw new Error('Somente o superadministrador pode iniciar uma sessão de suporte.');
    }
    if (!accessToken) throw new Error('A API não devolveu o acesso da sessão de suporte.');

    // Confere o token de suporte antes de trocar a sessão: se algo falhar, nada muda
    const supportUser = toSessionUser(
      await authService.me({ headers: { Authorization: `Bearer ${accessToken}` }, keepSessionOn401: true }),
    );
    if (!supportUser?.support_session) throw new Error('O acesso recebido não é de uma sessão de suporte.');
    if (getSessionToken() !== platformToken) throw new Error('A sessão deste navegador mudou durante a troca. Tente de novo.');

    // Sessão do superpainel em cookie: nada fica guardado nesta aba (a API suspende o refresh dela enquanto o
    // suporte estiver aberto, e o marcador fica para voltar depois, inclusive depois de recarregar a página).
    // Sessão bearer (antiga): o token do superpainel fica SÓ na memória desta aba, como antes.
    stashRef.current = cookiePlatform ? null : { token: platformToken, user: platformUser };
    persistSession(accessToken, supportUser, cookiePlatform);
    lastRefresh.current = Date.now();
    setSessionChecked(true);
    showUser(supportUser);
    return supportUser;
  }, [showUser]);

  /**
   * Volta da sessão de suporte para a sessão do superpainel em cookie: encerra o suporte no servidor com o token
   * de suporte (POST /auth/logout, sem o cabeçalho do cookie), tira o token de suporte do navegador e renova a
   * sessão do cookie (a API libera assim que o suporte fecha). Devolve o usuário do superpainel ou null.
   */
  const returnToCookiePlatform = useCallback(async (
    support: SupportSessionInfo | null,
    supportToken: string | null,
    sid: string,
  ): Promise<User | null> => {
    quietSwitchRef.current = true;
    setSessionSwitching(true);
    try {
      // Respostas atrasadas da tela do suporte (401) não são mais desta sessão
      setSessionToken(null);
      const ended = support && supportToken ? await authService.logout(supportToken) : !support;
      clearStoredToken();
      adoptCookieSession(sid);
      const outcome = await refreshSession();
      if (outcome.status === 'ok') {
        const platformUser = toSessionUser(outcome.session.user);
        if (platformUser) {
          writeSessionUser(platformUser);
          showUser(platformUser);
          return platformUser;
        }
      }
      if (support && !ended) rememberSupportSessionToEnd(support);
      clearStoredSession();
      showUser(null);
      return null;
    } finally {
      quietSwitchRef.current = false;
      setSessionSwitching(false);
    }
  }, [showUser]);

  const endSupportSession = useCallback(async (): Promise<boolean> => {
    const support = userRef.current?.support_session ?? null;
    const supportToken = support ? getSessionToken() : null;
    const stash = stashRef.current;
    stashRef.current = null;

    // Sessão do superpainel em cookie (marcador): volta a ela sem novo login, mesmo depois de recarregar a página
    const marker = readSessionMarker();
    if (!stash && marker) {
      lastRefresh.current = Date.now();
      return (await returnToCookiePlatform(support, supportToken, marker.sid)) !== null;
    }

    // A aba troca de sessão ANTES de falar com a API: uma resposta 401 atrasada da tela do suporte não é mais
    // desta sessão e não derruba a troca
    if (stash) {
      persistSession(stash.token, stash.user);
      lastRefresh.current = 0;
      showUser(stash.user);
    } else {
      // Sem a sessão do superpainel nesta aba (página recarregada ou suporte aberto em outra aba): sai, e o
      // superadministrador entra de novo
      clearStoredSession();
      showUser(null);
    }
    // Encerra no servidor com o próprio token de suporte (melhor esforço: a sessão também expira sozinha)
    if (support) await endSupportOnServer(support, supportToken, stash?.token ?? null);
    return !!stash;
  }, [returnToCookiePlatform, showUser]);

  // Ao abrir o app e ao voltar para a janela, confere o perfil na API (e a sessão gravada pelas outras abas).
  // Na sessão em cookie, também renova o token se ele já devia ter sido renovado (timers de abas em segundo
  // plano atrasam) ou ao voltar a conexão.
  useEffect(() => {
    void refreshUser();

    function handleFocus() {
      ensureFreshSession();
      if (Date.now() - lastRefresh.current >= FOCUS_REFRESH_INTERVAL_MS) void refreshUser();
      else syncWithStorage();
    }
    function handleOnline() {
      ensureFreshSession();
    }
    window.addEventListener('focus', handleFocus);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('online', handleOnline);
    };
  }, [refreshUser, syncWithStorage]);

  // Sessão compartilhada pelas abas: login, saída ou troca de conta em outra aba chegam pelo evento "storage";
  // a aba que volta do segundo plano (ou do cache de navegação) confere a sessão gravada. O interceptor do
  // api.ts também confere antes de cada chamada.
  useEffect(() => {
    registerSessionSync(syncWithStorage);
    let timer: number | undefined;
    const watched: string[] = [STORAGE_KEYS.token, STORAGE_KEYS.user, STORAGE_KEYS.session];

    function handleStorage(event: StorageEvent) {
      if (event.storageArea && event.storageArea !== window.localStorage) return;
      if (event.key !== null && !watched.includes(event.key)) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(syncWithStorage, SESSION_SYNC_DELAY_MS);
    }
    function handleVisibility() {
      if (document.visibilityState === 'visible') {
        syncWithStorage();
        ensureFreshSession();
      }
    }
    function handlePageShow(event: PageTransitionEvent) {
      if (event.persisted) syncWithStorage();
    }

    window.addEventListener('storage', handleStorage);
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pageshow', handlePageShow);
    return () => {
      registerSessionSync(null);
      window.clearTimeout(timer);
      window.removeEventListener('storage', handleStorage);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pageshow', handlePageShow);
    };
  }, [syncWithStorage]);

  // 401 numa chamada autenticada (token expirado, inválido, conta bloqueada ou removida) ou renovação recusada:
  // encerra a sessão e leva para o login da área em que o usuário estava.
  useEffect(() => {
    async function handleSessionExpired(quiet: boolean) {
      // Sessão de suporte encerrada ou expirada: volta para a sessão do superpainel guardada nesta aba
      const stash = stashRef.current;
      stashRef.current = null;
      if (stash) {
        persistSession(stash.token, stash.user);
        lastRefresh.current = 0;
        showUser(stash.user);
        toast('A sessão de suporte terminou. Você voltou ao superpainel.', { icon: '🛟', id: 'support-ended', duration: 6000 });
        navigate('/platform', { replace: true });
        return;
      }

      // Suporte aberto a partir de uma sessão do superpainel em cookie: tenta voltar a ela pela renovação
      const support = userRef.current?.support_session ?? null;
      const marker = readSessionMarker();
      if (support && marker && !readStoredToken()) {
        const platformUser = await returnToCookiePlatform(support, null, marker.sid);
        if (platformUser) {
          toast('A sessão de suporte terminou. Você voltou ao superpainel.', { icon: '🛟', id: 'support-ended', duration: 6000 });
          navigate('/platform', { replace: true });
          return;
        }
      }

      showUser(null);
      // Renovação recusada sem nenhuma chamada recusada (subida, timer, foco): na vitrine e na conta do cliente a
      // aba só fica sem login (o carrinho fica; as páginas protegidas levam ao login); no painel, /login com aviso
      if (quiet && !isInStaffArea()) return;
      toast.error('Sua sessão expirou. Faça login novamente.', { id: 'session-expired' });
      navigate(expiredSessionPath(), { replace: true });
    }
    function onSessionExpired(event: Event) {
      const detail = (event as CustomEvent<SessionExpiredDetail | undefined>).detail;
      void handleSessionExpired(detail?.quiet === true);
    }

    window.addEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
  }, [navigate, returnToCookiePlatform, showUser]);

  const value = useMemo(
    () => ({
      user,
      isAuthenticated: !!user,
      sessionChecked,
      signIn,
      signOut,
      updateUser,
      refreshUser,
      applyAuthResponse,
      beginSupportSession,
      endSupportSession,
    }),
    [user, sessionChecked, signIn, signOut, updateUser, refreshUser, applyAuthResponse, beginSupportSession, endSupportSession],
  );

  return (
    <AuthContext.Provider value={value}>
      {/* key: troca de conta feita em outra aba remonta as telas, sem dados da sessão anterior */}
      <Fragment key={sessionEpoch}>{children}</Fragment>
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  return useContext(AuthContext);
}
