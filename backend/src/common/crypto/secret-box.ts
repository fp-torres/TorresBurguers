import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'crypto';
import { Logger } from '@nestjs/common';
import { BRAND } from '../../config/brand';
import { isDevOrTest } from '../../config/env';

/**
 * Criptografia simétrica (AES-256-GCM) dos segredos guardados no banco, como o Access Token do
 * Mercado Pago de cada loja. A chave vem de CREDENTIALS_ENCRYPTION_KEY (32 bytes em base64 ou hex).
 *
 * - Produção (inclusive NODE_ENV vazio/desconhecido): sem chave válida, gravar ou ler segredos falha.
 * - development/test: sem chave, usa uma chave fixa de desenvolvimento (com aviso no log).
 *
 * Formatos gravados (<iv base64>:<tag base64>:<cifrado base64>, tag GCM sempre de 16 bytes):
 * - v2: com contexto (AAD), ex.: "store:7" — o texto cifrado só decifra no mesmo contexto, então o
 *   segredo de uma loja copiado para outra (no banco) é recusado. Use encryptStoreSecret/decryptStoreSecret.
 * - v1: sem contexto (formato antigo). Continua legível até ser regravado; novos valores com contexto
 *   saem em v2.
 * Tag com tamanho diferente de 16 bytes é recusada (o GCM aceitaria tags truncadas, de até 4 bytes).
 */
const VERSION_V1 = 'v1';
const VERSION_V2 = 'v2';
const AUTH_TAG_BYTES = 16;
const logger = new Logger('Credenciais');
let fallbackWarned = false;

export class CredentialsKeyError extends Error {}

function parseKey(raw: string): Buffer | null {
  const value = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  try {
    const decoded = Buffer.from(value, 'base64');
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

/** Chave de 32 bytes. Lança CredentialsKeyError em produção sem CREDENTIALS_ENCRYPTION_KEY válida. */
export function credentialsKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.CREDENTIALS_ENCRYPTION_KEY;
  if (raw?.trim()) {
    const key = parseKey(raw);
    if (key) return key;
    throw new CredentialsKeyError(
      'CREDENTIALS_ENCRYPTION_KEY inválida: use 32 bytes em base64 (44 caracteres) ou hex (64 caracteres).',
    );
  }
  if (!isDevOrTest(env)) {
    throw new CredentialsKeyError(
      'CREDENTIALS_ENCRYPTION_KEY não definida: em produção as credenciais de pagamento das lojas não podem ser gravadas nem lidas. ' +
        "Gere uma com: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  if (!fallbackWarned) {
    fallbackWarned = true;
    logger.warn(
      'CREDENTIALS_ENCRYPTION_KEY não definida: usando uma chave fixa de desenvolvimento. Nunca rode assim em produção.',
    );
  }
  return createHash('sha256')
    .update(`${BRAND.slug}-dev-credentials-key`)
    .digest();
}

/** A chave está configurada (ou o ambiente é de desenvolvimento/teste)? */
export function credentialsKeyAvailable(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    credentialsKey(env);
    return true;
  } catch {
    return false;
  }
}

/** Contexto (AAD) do segredo de uma loja: o texto cifrado fica preso a ela. */
export function storeSecretContext(storeId: number): string {
  if (!Number.isSafeInteger(storeId) || storeId <= 0) {
    throw new Error('Loja inválida para o segredo cifrado.');
  }
  return `store:${storeId}`;
}

/**
 * Cifra o segredo. Com `context` (AAD), grava no formato v2 e o valor só decifra com o mesmo contexto;
 * sem ele, no formato v1 (sem vínculo — prefira encryptStoreSecret para segredos de loja).
 */
export function encryptSecret(
  plain: string,
  env: NodeJS.ProcessEnv = process.env,
  context?: string,
): string {
  const key = credentialsKey(env);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  if (context) cipher.setAAD(Buffer.from(context, 'utf8'));
  const encrypted = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    context ? VERSION_V2 : VERSION_V1,
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

/**
 * Lança erro se o valor foi adulterado, cifrado com outra chave, com tag fora do tamanho (16 bytes) ou,
 * no formato v2, se o contexto (AAD) não for o mesmo da gravação (ex.: segredo de outra loja). O formato
 * v1 (antigo, sem contexto) continua legível com ou sem `context`.
 */
export function decryptSecret(
  payload: string,
  env: NodeJS.ProcessEnv = process.env,
  context?: string,
): string {
  const [version, iv, tag, data, ...rest] = payload.split(':');
  if (
    (version !== VERSION_V1 && version !== VERSION_V2) ||
    !iv ||
    !tag ||
    !data ||
    rest.length
  ) {
    throw new Error('Segredo cifrado em formato desconhecido.');
  }
  if (version === VERSION_V2 && !context) {
    throw new Error(
      'Segredo cifrado com contexto: informe a loja para decifrar.',
    );
  }
  const authTag = Buffer.from(tag, 'base64');
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new Error(
      'Segredo cifrado inválido (tag de autenticação fora do tamanho).',
    );
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    credentialsKey(env),
    Buffer.from(iv, 'base64'),
    { authTagLength: AUTH_TAG_BYTES },
  );
  if (version === VERSION_V2 && context) {
    decipher.setAAD(Buffer.from(context, 'utf8'));
  }
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** Segredo de uma loja (ex.: Access Token do Mercado Pago), preso a ela (v2 com AAD "store:<id>"). */
export function encryptStoreSecret(
  storeId: number,
  plain: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return encryptSecret(plain, env, storeSecretContext(storeId));
}

/**
 * Decifra o segredo de uma loja: v2 só com o contexto da própria loja (cópia de outra loja → erro);
 * v1 (gravado antes do vínculo) continua legível até ser regravado.
 */
export function decryptStoreSecret(
  storeId: number,
  payload: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return decryptSecret(payload, env, storeSecretContext(storeId));
}

/** Formato do valor gravado (v1 = antigo, sem vínculo com a loja; null = desconhecido). */
export function secretFormatVersion(payload: string): 'v1' | 'v2' | null {
  const version = payload.split(':', 1)[0];
  return version === VERSION_V1 || version === VERSION_V2 ? version : null;
}

/**
 * Regrava no formato atual (v2, preso à loja) um segredo de loja gravado no formato antigo (v1).
 * Idempotente: valor já em v2 → null (nada a regravar; nem é decifrado). O texto decifrado só existe
 * dentro desta função: quem chama recebe apenas o novo valor cifrado. Lança se o valor não puder ser
 * lido (formato desconhecido, adulterado ou cifrado com outra chave) ou, em produção, sem a chave
 * (CredentialsKeyError).
 */
export function upgradeStoreSecret(
  storeId: number,
  payload: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const version = secretFormatVersion(payload);
  if (version === VERSION_V2) return null;
  if (version !== VERSION_V1) {
    throw new Error('Segredo cifrado em formato desconhecido.');
  }
  return encryptStoreSecret(
    storeId,
    decryptStoreSecret(storeId, payload, env),
    env,
  );
}

/** Hash SHA-256 (hex) de tokens de uso único: o banco nunca guarda o token em si. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Token aleatório para links (convite, redefinição de senha): 32 bytes em base64url. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Comparação em tempo constante de textos (ex.: assinaturas de webhook). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Mostra só o começo e o fim de um segredo (ex.: "APP_USR-12…cd34"), para conferência no painel. */
export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 12) return '••••';
  return `${value.slice(0, 10)}…${value.slice(-4)}`;
}
