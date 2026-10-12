import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import api, { SESSION_EXPIRED_EVENT, clearStoredSession } from '../services/api';
import { STORAGE_KEYS } from '../config/brand';
import { homePathForRole, roleLabel, type UserRole } from '../utils/roles';

export interface User {
  id: number;
  name: string;
  email: string;
  role: UserRole;
  phone?: string;
  avatar?: string;
}

interface AuthContextData {
  user: User | null;
  isAuthenticated: boolean;
  signIn: (data: { email: string; password: string }) => Promise<User>;
  signOut: () => void;
  updateUser: (user: User) => void;
  /** Busca o perfil atual na API (GET /users/:id) e aplica mudanças de nome, foto ou perfil de acesso. */
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextData>({} as AuthContextData);

// Rotas do painel da equipe: sessão expirada nelas volta para /login; no resto, para o login da loja.
const STAFF_AREA_PATHS = ['/dashboard', '/orders', '/products', '/users', '/trash', '/admin'];

// Ao voltar para a janela, o perfil é conferido no máximo uma vez a cada 15 s
const FOCUS_REFRESH_INTERVAL_MS = 15_000;

function isInStaffArea(): boolean {
  return STAFF_AREA_PATHS.some((path) => window.location.pathname.startsWith(path));
}

/** Guarda na sessão só os campos públicos do usuário (nunca password_hash ou outros dados da API). */
function toSessionUser(data: Partial<User> & { phone?: string | null; avatar?: string | null }): User {
  return {
    id: Number(data.id),
    name: data.name ?? '',
    email: data.email ?? '',
    role: data.role as UserRole,
    phone: data.phone ?? undefined,
    avatar: data.avatar ?? undefined,
  };
}

function sameSessionUser(a: User, b: User): boolean {
  return a.id === b.id && a.name === b.name && a.email === b.email && a.role === b.role
    && a.phone === b.phone && a.avatar === b.avatar;
}

/** Lê a sessão salva sem alterar nada: null se faltar o token ou se o usuário estiver incompleto/corrompido. */
function parseStoredUser(): User | null {
  const token = localStorage.getItem(STORAGE_KEYS.token);
  const stored = localStorage.getItem(STORAGE_KEYS.user);
  if (!token || !stored) return null;

  try {
    const parsed = JSON.parse(stored) as Partial<User> | null;
    return parsed?.id && parsed.role ? toSessionUser(parsed) : null;
  } catch {
    return null;
  }
}

/** Restaura a sessão salva; dados incompletos ou corrompidos são descartados. */
function readStoredUser(): User | null {
  const stored = parseStoredUser();
  if (stored) return stored;

  if (localStorage.getItem(STORAGE_KEYS.token) || localStorage.getItem(STORAGE_KEYS.user)) clearStoredSession();
  return null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(readStoredUser);
  const navigate = useNavigate();
  const lastRefresh = useRef(0);

  // useNavigate muda a cada troca de página; a atualização do perfil usa sempre a versão mais recente
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  // O token vai em todas as requisições pelo interceptor do api.ts (lido do localStorage).
  const signIn = useCallback(async ({ email, password }: { email: string; password: string }) => {
    const { data } = await api.post('/auth/login', { email: email.trim(), password });
    if (!data?.access_token || !data?.user) throw new Error('Resposta de login inválida.');

    const sessionUser = toSessionUser(data.user);
    localStorage.setItem(STORAGE_KEYS.token, data.access_token);
    localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(sessionUser));
    lastRefresh.current = Date.now();
    setUser(sessionUser);

    return sessionUser;
  }, []);

  // Sair remove apenas token e usuário: carrinho e tema continuam salvos.
  const signOut = useCallback(() => {
    clearStoredSession();
    setUser(null);
  }, []);

  const updateUser = useCallback((updatedUser: User) => {
    const sessionUser = toSessionUser({ ...user, ...updatedUser });
    localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(sessionUser));
    setUser(sessionUser);
  }, [user]);

  // Perfil alterado em outro lugar (ex.: um Administrador mudou o cargo): a sessão acompanha a API.
  // Um 401 aqui não encerra a sessão sozinho; a próxima ação do usuário com o token inválido encerra.
  const refreshUser = useCallback((): Promise<void> => {
    const token = localStorage.getItem(STORAGE_KEYS.token);
    const current = parseStoredUser();
    if (!token || !current) return Promise.resolve();
    lastRefresh.current = Date.now();

    return api.get<User>(`/users/${current.id}`, { keepSessionOn401: true })
      .then(({ data }) => {
        if (!data?.id || !data.role) return;
        const fresh = toSessionUser(data);

        // Saiu ou trocou de conta enquanto a consulta estava em andamento
        if (localStorage.getItem(STORAGE_KEYS.token) !== token || fresh.id !== current.id) return;
        if (sameSessionUser(fresh, current)) return;

        localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(fresh));
        setUser(fresh);

        if (fresh.role !== current.role) {
          toast(`Seu perfil de acesso agora é ${roleLabel(fresh.role)}.`, { icon: '🔄', id: 'role-changed', duration: 6000 });
          // No painel, vai para a página inicial do novo perfil (cliente volta para a loja)
          if (isInStaffArea()) navigateRef.current(homePathForRole(fresh.role), { replace: true });
        }
      })
      .catch(() => {
        // Sem conexão ou sessão inválida: segue com o que está salvo
      });
  }, []);

  // Ao abrir o app e ao voltar para a janela, confere o perfil na API
  useEffect(() => {
    void refreshUser();

    function handleFocus() {
      if (Date.now() - lastRefresh.current >= FOCUS_REFRESH_INTERVAL_MS) void refreshUser();
    }
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [refreshUser]);

  // 401 numa chamada autenticada (token expirado, inválido ou conta removida): encerra a sessão
  // e leva para o login da área em que o usuário estava.
  useEffect(() => {
    function handleSessionExpired() {
      setUser(null);
      toast.error('Sua sessão expirou. Faça login novamente.', { id: 'session-expired' });
      navigate(isInStaffArea() ? '/login' : '/signin', { replace: true });
    }

    window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
  }, [navigate]);

  const value = useMemo(
    () => ({ user, isAuthenticated: !!user, signIn, signOut, updateUser, refreshUser }),
    [user, signIn, signOut, updateUser, refreshUser],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  return useContext(AuthContext);
}
