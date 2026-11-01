/** Chaves que nunca vão para a auditoria nem para logs (senhas, tokens, segredos, dados de cartão). */
const SENSITIVE_KEY =
  /pass(word)?|senha|token|secret|segredo|authorization|cookie|cvv|card(_?number)?|cartao|access[_-]?key|api[_-]?key|private[_-]?key|credential/i;

const REDACTED = '[removido]';
const MAX_DEPTH = 5;
const MAX_STRING = 500;
const MAX_ITEMS = 50;

/**
 * Cópia do objeto sem valores sensíveis, pronta para gravar (jsonb) ou logar.
 * Strings longas são cortadas e estruturas muito profundas/grandes são resumidas.
 */
export function sanitizeForAudit(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[…]';

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ITEMS)
      .map((item) => sanitizeForAudit(item, depth + 1));
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_ITEMS)) {
      result[key] = SENSITIVE_KEY.test(key)
        ? REDACTED
        : sanitizeForAudit(item, depth + 1);
    }
    return result;
  }
  // bigint vira texto; funções e símbolos não são gravados
  return typeof value === 'bigint' ? value.toString() : null;
}

/** Mascara um e-mail para exibição pública (ex.: ma***@gmail.com). */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***@${domain}`;
}
