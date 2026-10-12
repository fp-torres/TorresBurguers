import axios from 'axios';
import { API_URL } from '../services/api';

/** Status HTTP de um erro do axios (undefined quando não houve resposta). */
export function getErrorStatus(error: unknown): number | undefined {
  return axios.isAxiosError(error) ? error.response?.status : undefined;
}

/**
 * Mensagem amigável para exibir ao usuário.
 * O backend (NestJS) responde {statusCode, message: string | string[], error};
 * falhas de rede e erros 5xx usam textos próprios em português.
 */
export function getErrorMessage(error: unknown, fallback = 'Algo deu errado. Tente novamente.'): string {
  if (!axios.isAxiosError(error)) return fallback;

  if (!error.response) {
    if (error.code === 'ECONNABORTED') return 'O servidor demorou para responder. Tente novamente.';
    return `Não foi possível conectar ao servidor (${API_URL}). Verifique sua conexão e se a API está no ar.`;
  }

  if (error.response.status >= 500) return fallback;

  const message = (error.response.data as { message?: unknown } | undefined)?.message;
  if (Array.isArray(message) && message.length > 0) return message.map(String).join('\n');
  if (typeof message === 'string' && message.trim()) return message;
  return fallback;
}
