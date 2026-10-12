import { Raw } from 'typeorm';

/** E-mails são gravados e comparados sem espaços nas pontas e em minúsculas. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Condição de busca por e-mail sem diferenciar maiúsculas/minúsculas.
 * Mantém funcionando as contas antigas gravadas com letras maiúsculas.
 */
export function emailEquals(email: string) {
  return Raw((column) => `LOWER(${column}) = :normalizedEmail`, {
    normalizedEmail: normalizeEmail(email),
  });
}
