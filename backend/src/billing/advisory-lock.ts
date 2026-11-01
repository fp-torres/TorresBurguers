import { ConflictException } from '@nestjs/common';
import { QueryFailedError, type EntityManager } from 'typeorm';

/**
 * Trava consultiva do PostgreSQL pela chave em texto (hashtextextended, 64 bits), solta sozinha no fim
 * da transação. Serializa, entre requisições e instâncias da API, uma conferência seguida de gravação
 * que não tem uma linha para travar (ex.: "ainda cabe no plano?" antes de criar o produto) ou que
 * envolve uma chamada externa (o checkout da assinatura no provedor).
 */
export const ADVISORY_XACT_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`;
/** Mesma trava sem esperar: true = obtida (até o fim da transação); false = outra transação a tem. */
export const TRY_ADVISORY_XACT_LOCK_SQL = `SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS locked`;

/**
 * Espera máxima pela trava (lock_timeout só durante a espera). Quem espera já ocupa uma conexão do
 * pool: sem um teto, uma fila de requisições paradas na mesma trava esgotaria as conexões de todas as
 * lojas. As transações que seguram estas travas são curtas (contar e gravar).
 */
export const ADVISORY_LOCK_WAIT_MS = 5_000;
export const ADVISORY_LOCK_BUSY_MESSAGE =
  'Outra alteração da loja está em andamento. Tente de novo em instantes.';

/** lock_timeout do PostgreSQL esgotado (lock_not_available). */
const PG_LOCK_NOT_AVAILABLE = '55P03';

function isLockTimeout(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const { driverError } = error as QueryFailedError<Error & { code?: string }>;
  return driverError?.code === PG_LOCK_NOT_AVAILABLE;
}

/**
 * Precisa rodar DENTRO de uma transação (fora dela a trava se soltaria na hora). Espera no máximo
 * waitMs (0 = sem teto); esgotado → 409 (a transação de quem chama é desfeita).
 */
export async function advisoryXactLock(
  manager: Pick<EntityManager, 'query'>,
  key: string,
  waitMs: number = ADVISORY_LOCK_WAIT_MS,
): Promise<void> {
  if (waitMs <= 0) {
    await manager.query(ADVISORY_XACT_LOCK_SQL, [key]);
    return;
  }
  // SET LOCAL só durante a espera: o restante da transação de quem chama segue com o lock_timeout padrão
  await manager.query(`SELECT set_config('lock_timeout', $1, true)`, [
    `${Math.ceil(waitMs)}ms`,
  ]);
  try {
    await manager.query(ADVISORY_XACT_LOCK_SQL, [key]);
  } catch (error) {
    if (isLockTimeout(error)) {
      throw new ConflictException(ADVISORY_LOCK_BUSY_MESSAGE);
    }
    throw error;
  }
  await manager.query(`SET LOCAL lock_timeout TO DEFAULT`);
}

/**
 * Tenta a trava sem esperar (dentro de uma transação). Para quem não pode segurar uma conexão do pool
 * parada na fila da trava: com ela ocupada, a transação termina e quem chama decide (esperar FORA da
 * transação e tentar de novo, ou 409).
 */
export async function tryAdvisoryXactLock(
  manager: Pick<EntityManager, 'query'>,
  key: string,
): Promise<boolean> {
  const rows: unknown = await manager.query(TRY_ADVISORY_XACT_LOCK_SQL, [key]);
  const first = Array.isArray(rows)
    ? (rows[0] as { locked?: unknown } | undefined)
    : undefined;
  return first?.locked === true;
}
