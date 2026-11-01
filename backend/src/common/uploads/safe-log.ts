/** Caracteres de controle (C0, DEL e C1). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;
/** Separadores de linha Unicode (U+2028 e U+2029), que alguns visualizadores de log quebram. */
const LINE_SEPARATORS = new RegExp(
  `[${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`,
  'g',
);

/**
 * Texto vindo do cliente ou do banco (nome do arquivo enviado, caminho de imagem, nome de produto)
 * pronto para o log: caracteres de controle (CR/LF, ESC...) viram "?" e o tamanho é limitado. Assim
 * ninguém forja linhas inteiras no log ("...\r\n[Nest] 1 - LOG [AuthService] ...").
 */
export function safeForLog(value: unknown, maxLength = 120): string {
  const text = typeof value === 'string' ? value : String(value);
  const clean = text.replace(CONTROL_CHARS, '?').replace(LINE_SEPARATORS, '?');
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}…` : clean;
}
