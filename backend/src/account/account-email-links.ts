import { appLink } from '../notifications/links';

/** Validade dos links enviados por e-mail (ações da conta). */
export const EMAIL_VERIFICATION_TTL_HOURS = 48;
export const EMAIL_CHANGE_TTL_HOURS = 24;
export const EMAIL_REVERT_TTL_DAYS = 7;

const HOUR_MS = 60 * 60_000;

export function hoursFrom(now: Date, hours: number): Date {
  return new Date(now.getTime() + hours * HOUR_MS);
}

/** Páginas públicas do site que recebem os links (frontend web, rotas da SPA). */
export function emailVerificationUrl(token: string): string {
  return appLink(`/verificar-email/${token}`);
}

export function emailChangeUrl(token: string): string {
  return appLink(`/confirmar-email/${token}`);
}

export function emailRevertUrl(token: string): string {
  return appLink(`/desfazer-troca-de-email/${token}`);
}

/** "Esqueci minha senha" (atalho do aviso de senha alterada). */
export function forgotPasswordUrl(): string {
  return appLink('/esqueci-senha');
}
