// Mesma política de senha da API: 9+ caracteres, uma letra maiúscula e um número ou símbolo,
// e no máximo 72 bytes em UTF-8 (o bcrypt ignora o que passar disso).

export const PASSWORD_MIN_LENGTH = 9;

/** Limite da API em bytes UTF-8: letras acentuadas ocupam 2 bytes; emojis, 4. */
export const PASSWORD_MAX_BYTES = 72;

export const PASSWORD_RULES_MESSAGE =
  'A senha precisa ter no mínimo 9 caracteres, uma letra maiúscula e um número ou símbolo.';

/** Mesmo texto da API para senhas acima do limite. */
export const PASSWORD_TOO_LONG_MESSAGE =
  `A senha pode ter no máximo ${PASSWORD_MAX_BYTES} caracteres (letras acentuadas e emojis contam como 2 ou mais).`;

/** A senha passa do limite de 72 bytes aceito pela API. */
export function isPasswordTooLong(password: string): boolean {
  return new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES;
}

export interface PasswordChecks {
  length: boolean;
  upper: boolean;
  numberOrSymbol: boolean;
}

export function checkPassword(password: string): PasswordChecks {
  return {
    length: password.length >= PASSWORD_MIN_LENGTH,
    upper: /[A-Z]/.test(password),
    // \W como na API: o sublinhado "_" não conta como símbolo
    numberOrSymbol: /\d/.test(password) || /\W/.test(password),
  };
}

/** Quantas regras a senha cumpre (0 a 3). */
export function passwordScore(password: string): number {
  return Object.values(checkPassword(password)).filter(Boolean).length;
}

export function isStrongPassword(password: string): boolean {
  return passwordScore(password) === 3;
}
