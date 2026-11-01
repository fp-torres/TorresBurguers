import type { AxiosRequestConfig } from 'axios';
import api, { sessionEmissionConfig } from './api';
import { isAuthResponse, type AuthResponse } from './authService';
import { asRecord, readBoolean, readDate, readNullableText, readText } from './panelParsers';

// Segurança da própria conta (backend: account/account.controller.ts, plano email-verification fase 1a):
// troca de senha com a senha atual, troca de e-mail confirmada no endereço novo ("Não fui eu" no antigo) e
// verificação do e-mail. As rotas antigas (PATCH /users/:id) continuam valendo para o app mobile.

export type AccountSecurityMode = 'compat' | 'strict';

/** Troca de e-mail aguardando a confirmação no endereço novo. */
export interface PendingEmailChange {
  email: string;
  requested_at: string | null;
  expires_at: string | null;
}

/** GET /account/security */
export interface AccountSecurity {
  email: string;
  email_verified: boolean;
  email_verified_at: string | null;
  email_change: PendingEmailChange | null;
  account_security_mode: AccountSecurityMode;
}

/** Links públicos (conferência pelo GET): dados mascarados e a validade. */
export interface VerificationLinkInfo {
  email_masked: string;
  expires_at: string | null;
}

export interface EmailChangeLinkInfo {
  current_email_masked: string;
  new_email_masked: string;
  expires_at: string | null;
}

export interface EmailRevertLinkInfo {
  restored_email_masked: string;
  replaced_email_masked: string;
  expires_at: string | null;
}

function parsePending(value: unknown): PendingEmailChange | null {
  const raw = asRecord(value);
  const email = readText(raw.email);
  if (!email) return null;
  return { email, requested_at: readDate(raw.requested_at), expires_at: readDate(raw.expires_at) };
}

export function parseAccountSecurity(value: unknown): AccountSecurity {
  const raw = asRecord(value);
  return {
    email: readText(raw.email),
    email_verified: readBoolean(raw.email_verified, false),
    email_verified_at: readDate(raw.email_verified_at),
    email_change: parsePending(raw.email_change),
    account_security_mode: raw.account_security_mode === 'strict' ? 'strict' : 'compat',
  };
}

/** Mensagem da API ({ message }) ou '' quando ela não mandar. */
function messageOf(value: unknown): string {
  return readText(asRecord(value).message);
}

export const accountService = {
  /** GET /account/security (também na sessão de suporte, por ser leitura). */
  getSecurity: async (config?: AxiosRequestConfig): Promise<AccountSecurity> => {
    const { data } = await api.get<unknown>('/account/security', config);
    return parseAccountSecurity(data);
  },

  /**
   * POST /account/password → { access_token, user }: as outras sessões caem; esta continua com o token novo
   * (aplicado pelo AuthContext, applyAuthResponse).
   */
  changePassword: async (currentPassword: string, password: string): Promise<AuthResponse> => {
    // Na sessão em cookie, a sessão nova também vem em cookie (o token antigo e o refresh antigo caem)
    const { data } = await api.post<unknown>('/account/password', { current_password: currentPassword, password }, sessionEmissionConfig());
    if (!isAuthResponse(data)) throw new Error('Resposta inválida da troca de senha.');
    return data;
  },

  /**
   * POST /account/email-change → 202 { message, email_change }: a mesma resposta para qualquer endereço; o
   * e-mail da conta só muda depois da confirmação no endereço novo.
   */
  requestEmailChange: async (email: string, currentPassword: string): Promise<{ message: string; pending: PendingEmailChange | null }> => {
    const { data } = await api.post<unknown>('/account/email-change', { email, current_password: currentPassword });
    return { message: messageOf(data), pending: parsePending(asRecord(data).email_change) };
  },

  /** DELETE /account/email-change (204, idempotente). */
  cancelEmailChange: async (): Promise<void> => {
    await api.delete('/account/email-change');
  },

  /** POST /account/email-verification → 202 (link enviado) ou 200 { email_verified: true } (já confirmado). */
  resendVerification: async (): Promise<{ message: string; alreadyVerified: boolean }> => {
    const { data } = await api.post<unknown>('/account/email-verification');
    return { message: messageOf(data), alreadyVerified: readBoolean(asRecord(data).email_verified, false) };
  },

  // Páginas públicas dos links (o GET só confere; a ação exige o clique → POST)

  inspectVerification: async (token: string): Promise<VerificationLinkInfo> => {
    const { data } = await api.get<unknown>(`/account/email-verification/${encodeURIComponent(token)}`);
    const raw = asRecord(data);
    return { email_masked: readText(raw.email_masked), expires_at: readDate(raw.expires_at) };
  },

  confirmVerification: async (token: string): Promise<{ message: string; email_masked: string }> => {
    const { data } = await api.post<unknown>('/account/email-verification/confirm', { token });
    return { message: messageOf(data), email_masked: readText(asRecord(data).email_masked) };
  },

  inspectEmailChange: async (token: string): Promise<EmailChangeLinkInfo> => {
    const { data } = await api.get<unknown>(`/account/email-change/${encodeURIComponent(token)}`);
    const raw = asRecord(data);
    return {
      current_email_masked: readText(raw.current_email_masked),
      new_email_masked: readText(raw.new_email_masked),
      expires_at: readDate(raw.expires_at),
    };
  },

  confirmEmailChange: async (token: string): Promise<{ message: string; email: string | null }> => {
    const { data } = await api.post<unknown>('/account/email-change/confirm', { token });
    return { message: messageOf(data), email: readNullableText(asRecord(data).email) };
  },

  inspectEmailRevert: async (token: string): Promise<EmailRevertLinkInfo> => {
    const { data } = await api.get<unknown>(`/account/email-revert/${encodeURIComponent(token)}`);
    const raw = asRecord(data);
    return {
      restored_email_masked: readText(raw.restored_email_masked),
      replaced_email_masked: readText(raw.replaced_email_masked),
      expires_at: readDate(raw.expires_at),
    };
  },

  revertEmailChange: async (token: string, password: string): Promise<{ message: string; email_masked: string }> => {
    const { data } = await api.post<unknown>('/account/email-revert', { token, password });
    return { message: messageOf(data), email_masked: readText(asRecord(data).email_masked) };
  },
};

/**
 * O e-mail mascarado pela API ("jo***@email.com": até 2 letras + domínio) bate com o e-mail da sessão aberta
 * neste navegador? Usado para encerrar aqui a sessão que a troca ou o "Não fui eu" invalidou (mesmo critério do
 * ResetPassword).
 */
export function maskedEmailMatches(masked: string, email: string | undefined | null): boolean {
  const match = /^(.*)\*\*\*@(.+)$/.exec(masked.trim().toLowerCase());
  if (!match || !email) return false;
  const [, prefix, domain] = match;
  const [local, emailDomain] = email.trim().toLowerCase().split('@');
  return !!local && emailDomain === domain && local.startsWith(prefix);
}
