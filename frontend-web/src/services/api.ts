import axios from 'axios';
import { BRAND, STORAGE_KEYS } from '../config/brand';

declare module 'axios' {
  interface AxiosRequestConfig {
    /**
     * true: um 401 nesta chamada não encerra a sessão (ex.: atualização do perfil em segundo plano).
     * A próxima ação do usuário com o token inválido encerra a sessão normalmente.
     */
    keepSessionOn401?: boolean;
  }
}

/** Endereço do backend (configurável via VITE_API_URL no .env). */
export const API_URL = ((import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:3000').replace(/\/+$/, '');

const api = axios.create({
  baseURL: API_URL,
});

// Interceptor: O "Porteiro" das requisições
api.interceptors.request.use((config) => {
  // Tenta recuperar o token salvo no LocalStorage do navegador
  const token = localStorage.getItem(STORAGE_KEYS.token);

  if (token) {
    // Se tiver token, anexa no cabeçalho Authorization
    config.headers.Authorization = `Bearer ${token}`;
  }

  return config;
});

/** Evento disparado quando uma chamada autenticada recebe 401 (token expirado, inválido ou usuário removido). */
export const SESSION_EXPIRED_EVENT = `${BRAND.slug}:session-expired`;

/** Apaga só a sessão deste app (token e usuário); carrinho e tema continuam salvos. */
export function clearStoredSession(): void {
  localStorage.removeItem(STORAGE_KEYS.token);
  localStorage.removeItem(STORAGE_KEYS.user);
}

// Interceptor de resposta: um 401 numa chamada feita com o token atual encerra a sessão
// (o AuthContext escuta o evento e leva o usuário para a tela de login certa).
// O próprio login é ignorado (senha errada não derruba quem já está logado),
// assim como respostas atrasadas de uma sessão anterior e chamadas marcadas com keepSessionOn401.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 401 &&
      !error.config?.keepSessionOn401 &&
      !error.config?.url?.includes('/auth/login')
    ) {
      const sentAuthorization = String(error.config?.headers?.Authorization ?? '');
      const currentToken = localStorage.getItem(STORAGE_KEYS.token);
      if (currentToken && sentAuthorization === `Bearer ${currentToken}`) {
        clearStoredSession();
        window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
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

export default api;
