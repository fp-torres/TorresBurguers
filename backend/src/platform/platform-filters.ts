/**
 * Filtros das listas do superpainel em funções puras (sem banco): intervalo de datas da auditoria e
 * dos eventos de autenticação e o prefixo de ação. Cobertos por platform-filters.spec.ts.
 */
import { addDaysToKey, startOfDayInZone } from '../orders/order-rules';
import { isDateKey } from './metrics';

/** Data AAAA-MM-DD (dia inteiro no fuso da plataforma) ou data e hora ISO 8601 COM fuso (Z ou ±hh:mm). */
export const INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2}))?$/i;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const INSTANT_FORMAT_HINT =
  'use uma data AAAA-MM-DD ou data e hora ISO 8601 com fuso (ex.: 2026-10-11T15:00:00Z)';

/**
 * Instante de um limite do filtro. Data sem hora vale o dia inteiro no fuso: "from" = início do dia,
 * "to" = início do dia seguinte (exclusivo). Data e hora: "to" inclui o próprio instante.
 * Formato ou data inexistente → null.
 */
export function parseInstant(
  value: string,
  edge: 'start' | 'end',
  timeZone: string,
): Date | null {
  if (DATE_ONLY.test(value)) {
    if (!isDateKey(value)) return null;
    return edge === 'start'
      ? startOfDayInZone(value, timeZone)
      : startOfDayInZone(addDaysToKey(value, 1), timeZone);
  }
  if (!INSTANT_PATTERN.test(value)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return edge === 'start' ? date : new Date(date.getTime() + 1);
}

export type InstantRange =
  | { ok: true; from: Date | null; toExclusive: Date | null }
  | { ok: false; message: string };

export function parseInstantRange(
  from: string | null | undefined,
  to: string | null | undefined,
  timeZone: string,
): InstantRange {
  const start = from ? parseInstant(from, 'start', timeZone) : null;
  if (from && !start) {
    return { ok: false, message: `from inválido: ${INSTANT_FORMAT_HINT}.` };
  }
  const end = to ? parseInstant(to, 'end', timeZone) : null;
  if (to && !end) {
    return { ok: false, message: `to inválido: ${INSTANT_FORMAT_HINT}.` };
  }
  if (start && end && start.getTime() >= end.getTime()) {
    return {
      ok: false,
      message: 'A data inicial (from) não pode ser depois da data final (to).',
    };
  }
  return { ok: true, from: start, toExclusive: end };
}

/** Nome de uma ação ou de um grupo da auditoria: ex.: platform.store, auth.login.failure, plan. */
export const AUDIT_ACTION_PATTERN = /^[a-z][a-z0-9_.]{0,79}$/;

/** Filtro de ação: a ação exata (se houver) ou as do grupo (padrão do LIKE terminado em ".%"). */
export interface ActionFilter {
  exact: string | null;
  prefix: string;
}

/**
 * Filtro por ação respeitando os segmentos do nome: "plan" traz plan e plan.*, mas não platform.*;
 * "auth.login" traz auth.login.success e auth.login.failure. Terminado em ponto ("plan."), só o
 * grupo. "%", "_" e "\" do texto são escapados no LIKE.
 */
export function actionFilter(action: string): ActionFilter {
  const escaped = action.replace(/[\\%_]/g, (char) => `\\${char}`);
  return action.endsWith('.')
    ? { exact: null, prefix: `${escaped}%` }
    : { exact: action, prefix: `${escaped}.%` };
}

/**
 * Dígitos de um termo de busca que PARECE um número (telefone, CNPJ/CPF): só dígitos, espaços e a
 * pontuação usual — "(21) 99999-0000", "+55 21 9...", "11.222.333/0001-81". Com 3 dígitos ou mais
 * devolve os dígitos para procurar no valor gravado sem pontuação; termo com letras ou "@" (nome,
 * e-mail, "Loja 219 Centro") → null: os dígitos soltos de um nome não procuram em telefones.
 */
export function numericSearchDigits(search: string): string | null {
  const text = search.trim();
  if (!/^[\d\s()+./-]+$/.test(text)) return null;
  const digits = text.replace(/\D/g, '');
  return digits.length >= 3 ? digits : null;
}
