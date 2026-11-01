import { QueryFailedError } from 'typeorm';

/** Códigos de erro do PostgreSQL (https://www.postgresql.org/docs/current/errcodes-appendix.html). */
export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_CHECK_VIOLATION = '23514';

function postgresErrorCode(error: unknown): string | undefined {
  if (!(error instanceof QueryFailedError)) return undefined;
  const { driverError } = error as QueryFailedError<Error & { code?: string }>;
  return driverError?.code;
}

/** O registro ainda é referenciado por outra tabela (ex.: produto presente em pedidos). */
export function isForeignKeyViolation(error: unknown): boolean {
  return postgresErrorCode(error) === PG_FOREIGN_KEY_VIOLATION;
}

/** Violação de UNIQUE (ex.: e-mail já cadastrado). */
export function isUniqueViolation(error: unknown): boolean {
  return postgresErrorCode(error) === PG_UNIQUE_VIOLATION;
}

/**
 * Violação de CHECK. Também é o código das triggers de consistência entre lojas
 * (ex.: adicional de outra loja num produto, loja de um registro alterada): ver a migration
 * MultiTenantFoundation. Para o cliente, vira 400 — os dados enviados não combinam com a loja.
 */
export function isCheckViolation(error: unknown): boolean {
  return postgresErrorCode(error) === PG_CHECK_VIOLATION;
}
