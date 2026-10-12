import React, { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import axios, { AxiosError } from 'axios';

import api from '../services/api';
import { STORAGE_KEYS } from '../config/brand';
import { isStaffRole, UserRole } from '../utils/roles';

// Exportando a interface User para poder usar em outras telas
export interface User {
  id: number;
  name: string;
  email: string;
  role: UserRole | string;
  phone?: string | null;
  avatar?: string | null;
}

export type LoginArea = 'cliente' | 'funcionario';

/** Aviso mostrado no login quando a sessão foi encerrada pelo app. */
export type SessionNotice = 'expired' | 'roleChanged';

/** Para onde levar o usuário quando a sessão termina (logout da equipe, sessão expirada ou perfil alterado). */
export type AuthRedirect =
  | { screen: 'Welcome' }
  | { screen: 'SignIn'; type: LoginArea; notice: SessionNotice };

/** Mensagem do perfil de acesso alterado (também substitui a do erro 403 que revelou a mudança). */
export const ROLE_CHANGED_MESSAGE = 'Seu perfil de acesso mudou. Entre novamente.';

/** Depois de um 403 com o perfil inalterado, espera este tempo antes de conferir de novo. */
const ROLE_CHECK_COOLDOWN_MS = 15_000;

interface AuthContextData {
  signed: boolean;
  user: User | null;
  loading: boolean;
  /** Perfis da equipe (ADMIN, EMPLOYEE, KITCHEN, COURIER) usam o painel em vez da loja. */
  isStaff: boolean;
  signIn: (email: string, password: string) => Promise<User>;
  signOut: () => Promise<void>;
  /** Atualiza o usuário logado (ex.: depois de editar o perfil). */
  updateUser: (data: Partial<User>) => Promise<void>;
  redirect: AuthRedirect | null;
  clearRedirect: () => void;
}

export const AuthContext = createContext<AuthContextData>({} as AuthContextData);

/** Garante que nenhum dado de senha seja guardado no aparelho. */
function sanitizeUser(data: unknown): User {
  const { password, password_hash, ...rest } = (data ?? {}) as Record<string, unknown>;
  return rest as unknown as User;
}

function setDefaultAuthHeader(token: string | null) {
  if (token) api.defaults.headers.common.Authorization = `Bearer ${token}`;
  else delete api.defaults.headers.common.Authorization;
}

/** Token enviado na requisição que falhou (o interceptor de request lê do AsyncStorage). */
function authorizationOf(error: AxiosError): string | undefined {
  const headers = error.config?.headers;
  const value = headers?.Authorization ?? headers?.get?.('Authorization');
  return typeof value === 'string' ? value : undefined;
}

/** Requisição ao próprio cadastro (/users/:id): é a que confere o perfil, então nunca dispara outra conferência. */
function isOwnProfileRequest(url: string | undefined, userId: number | undefined): boolean {
  if (!url || userId === undefined) return false;
  const path = url.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+/, '');
  return path === `users/${userId}` || path.startsWith(`users/${userId}/`) || path.startsWith(`users/${userId}?`);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [redirect, setRedirect] = useState<AuthRedirect | null>(null);

  // Refs para o interceptor (registrado uma vez) enxergar a sessão atual.
  const userRef = useRef<User | null>(null);
  const tokenRef = useRef<string | null>(null);
  const expiringRef = useRef(false);
  // Conferência do perfil após um 403: uma por vez e, se nada mudou, não repete logo em seguida
  const roleCheckRef = useRef<Promise<boolean> | null>(null);
  const lastRoleCheckRef = useRef(0);
  userRef.current = user;

  const clearSession = useCallback(async () => {
    tokenRef.current = null;
    setDefaultAuthHeader(null);
    // Remove só a sessão deste app: carrinho e tema continuam no aparelho.
    await AsyncStorage.multiRemove([STORAGE_KEYS.token, STORAGE_KEYS.user]);
  }, []);

  const persistUser = useCallback(async (next: User) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.user, JSON.stringify(next));
    } catch {
      // Falha de armazenamento não deve derrubar a sessão em uso.
    }
  }, []);

  /**
   * Encerra a sessão e leva ao login com um aviso: sessão expirada (401) ou perfil de acesso alterado.
   * nextRole (perfil novo) escolhe a área de login; sem ele vale o perfil da sessão encerrada.
   */
  const endSession = useCallback(async (notice: SessionNotice, nextRole?: string) => {
    const current = userRef.current;
    if (!current || expiringRef.current) return;
    expiringRef.current = true;
    try {
      await clearSession();
    } catch {
      // Mesmo sem conseguir limpar o armazenamento, encerra a sessão em memória.
    } finally {
      const area: LoginArea = isStaffRole(nextRole ?? current.role) ? 'funcionario' : 'cliente';
      setRedirect({ screen: 'SignIn', type: area, notice });
      setUser(null);
      expiringRef.current = false;
    }
  }, [clearSession]);

  /**
   * Atualiza os dados do usuário a partir do backend. Se o perfil de acesso mudou desde o login
   * (ex.: Cozinha virou Entregador), as permissões são outras: a sessão termina e a pessoa entra
   * de novo. Retorna true quando encerrou a sessão.
   */
  const refreshFromServer = useCallback(async (id: number): Promise<boolean> => {
    try {
      const { data } = await api.get<Partial<User> | null>(`/users/${id}`);
      const current = userRef.current;
      if (!data || !current || current.id !== id) return false;
      if (typeof data.role === 'string' && data.role !== current.role) {
        await endSession('roleChanged', data.role);
        return true;
      }
      const fresh = sanitizeUser({ ...current, ...data });
      if (JSON.stringify(fresh) === JSON.stringify(current)) return false; // Nada mudou: não redesenha o app
      setUser(fresh);
      await persistUser(fresh);
      return false;
    } catch {
      // Sem rede: segue com os dados salvos. 401 é tratado pelo interceptor abaixo.
      return false;
    }
  }, [endSession, persistUser]);

  /** Depois de um 403: confere se o perfil mudou (uma conferência por vez, com intervalo mínimo). */
  const confirmRoleChange = useCallback((): Promise<boolean> => {
    const current = userRef.current;
    if (!current) return Promise.resolve(false);
    if (roleCheckRef.current) return roleCheckRef.current;
    if (Date.now() - lastRoleCheckRef.current < ROLE_CHECK_COOLDOWN_MS) return Promise.resolve(false);
    lastRoleCheckRef.current = Date.now();
    const check = refreshFromServer(current.id).finally(() => {
      roleCheckRef.current = null;
    });
    roleCheckRef.current = check;
    return check;
  }, [refreshFromServer]);

  // Ao voltar para o app, confere o perfil de novo: um perfil alterado encerra a sessão
  // e uma conta removida cai no 401 (sessão expirada).
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      const current = userRef.current;
      if (state === 'active' && current) refreshFromServer(current.id);
    });
    return () => subscription.remove();
  }, [refreshFromServer]);

  useEffect(() => {
    async function loadStorageData() {
      try {
        const [[, storedToken], [, storedUser]] = await AsyncStorage.multiGet([STORAGE_KEYS.token, STORAGE_KEYS.user]);
        if (storedToken && storedUser) {
          const restored = sanitizeUser(JSON.parse(storedUser));
          tokenRef.current = storedToken;
          setDefaultAuthHeader(storedToken);
          userRef.current = restored;
          setUser(restored);
          refreshFromServer(restored.id);
        }
      } catch {
        // Dados corrompidos: descarta apenas a sessão.
        await clearSession().catch(() => undefined);
      } finally {
        setLoading(false);
      }
    }

    loadStorageData();
  }, [clearSession, refreshFromServer]);

  // Erros de uma chamada feita com a sessão atual:
  // - 401 = sessão expirada/inválida: limpa a sessão e leva ao login certo;
  // - 403 = sem permissão. Pode ser o perfil alterado por um administrador: confere no servidor e,
  //   se mudou, encerra a sessão e troca a mensagem do erro pela do perfil alterado.
  useEffect(() => {
    const interceptorId = api.interceptors.response.use(undefined, async (error) => {
      if (
        axios.isAxiosError(error)
        && tokenRef.current
        && authorizationOf(error) === `Bearer ${tokenRef.current}`
      ) {
        const status = error.response?.status;
        if (status === 401 && !error.config?.url?.includes('/auth/login')) {
          await endSession('expired');
        } else if (
          status === 403
          && !isOwnProfileRequest(error.config?.url, userRef.current?.id)
          && await confirmRoleChange()
          && error.response
        ) {
          const body = error.response.data;
          error.response.data = { ...(body && typeof body === 'object' ? body : {}), message: ROLE_CHANGED_MESSAGE };
        }
      }
      return Promise.reject(error);
    });
    return () => api.interceptors.response.eject(interceptorId);
  }, [endSession, confirmRoleChange]);

  const signIn = useCallback(async (email: string, password: string): Promise<User> => {
    const response = await api.post('/auth/login', { email: email.trim(), password });
    const token: string | undefined = response.data?.access_token;
    if (!token || !response.data?.user) {
      throw new Error('Resposta de login inválida.');
    }

    const loggedUser = sanitizeUser(response.data.user);
    await AsyncStorage.multiSet([
      [STORAGE_KEYS.token, token],
      [STORAGE_KEYS.user, JSON.stringify(loggedUser)],
    ]);

    tokenRef.current = token;
    setDefaultAuthHeader(token);
    setRedirect(null);
    setUser(loggedUser);
    return loggedUser;
  }, []);

  const signOut = useCallback(async () => {
    const current = userRef.current;
    try {
      await clearSession();
    } catch {
      // Ignora falha de armazenamento: a sessão em memória é encerrada de qualquer forma.
    }
    // Equipe volta para a tela de acesso; cliente continua navegando pela loja.
    setRedirect(current && isStaffRole(current.role) ? { screen: 'Welcome' } : null);
    setUser(null);
  }, [clearSession]);

  const updateUser = useCallback(async (data: Partial<User>) => {
    const current = userRef.current;
    if (!current) return;
    const next = sanitizeUser({ ...current, ...data });
    setUser(next);
    await persistUser(next);
  }, [persistUser]);

  const clearRedirect = useCallback(() => setRedirect(null), []);

  const value = useMemo<AuthContextData>(() => ({
    signed: !!user,
    user,
    loading,
    isStaff: isStaffRole(user?.role),
    signIn,
    signOut,
    updateUser,
    redirect,
    clearRedirect,
  }), [user, loading, signIn, signOut, updateUser, redirect, clearRedirect]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
