import { randomBytes } from 'crypto';
import { Logger } from '@nestjs/common';
import {
  CredentialsKeyError,
  credentialsKey,
  decryptSecret,
  decryptStoreSecret,
  encryptSecret,
  encryptStoreSecret,
  maskSecret,
  randomToken,
  safeEqual,
  secretFormatVersion,
  sha256Hex,
  storeSecretContext,
  upgradeStoreSecret,
} from './secret-box';

const KEY_B64 = randomBytes(32).toString('base64');
const PROD = { NODE_ENV: 'production', CREDENTIALS_ENCRYPTION_KEY: KEY_B64 };

describe('secret-box', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('cifra e decifra com a chave configurada (IV aleatório a cada vez)', () => {
    const a = encryptSecret('APP_USR-123-segredo', PROD);
    const b = encryptSecret('APP_USR-123-segredo', PROD);
    expect(a).not.toBe(b);
    expect(a).not.toContain('APP_USR');
    expect(decryptSecret(a, PROD)).toBe('APP_USR-123-segredo');
  });

  it('aceita a chave em hex', () => {
    const hex = randomBytes(32).toString('hex');
    const env = { NODE_ENV: 'production', CREDENTIALS_ENCRYPTION_KEY: hex };
    expect(decryptSecret(encryptSecret('x', env), env)).toBe('x');
  });

  it('recusa valor adulterado ou cifrado com outra chave', () => {
    const payload = encryptSecret('segredo', PROD);
    const parts = payload.split(':');
    parts[3] = Buffer.from('outro').toString('base64');
    expect(() => decryptSecret(parts.join(':'), PROD)).toThrow();

    const other = {
      NODE_ENV: 'production',
      CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    };
    expect(() => decryptSecret(payload, other)).toThrow();
  });

  it('tag GCM truncada (ex.: 4 bytes) é recusada, no formato antigo e no novo', () => {
    for (const payload of [
      encryptSecret('APP_USR-secret', PROD),
      encryptStoreSecret(7, 'APP_USR-secret', PROD),
    ]) {
      const parts = payload.split(':');
      const tag = Buffer.from(parts[2], 'base64');
      expect(tag).toHaveLength(16);
      for (const size of [4, 8, 12, 15]) {
        const truncated = [
          parts[0],
          parts[1],
          tag.subarray(0, size).toString('base64'),
          parts[3],
        ].join(':');
        expect(() => decryptSecret(truncated, PROD, 'store:7')).toThrow(
          /tag de autenticação/,
        );
      }
    }
  });

  it('segredo da loja (v2) fica preso a ela: copiado para outra loja não decifra', () => {
    const fromB = encryptStoreSecret(8, 'APP_USR-loja-b', PROD);
    expect(secretFormatVersion(fromB)).toBe('v2');
    expect(fromB).not.toContain('APP_USR');
    expect(decryptStoreSecret(8, fromB, PROD)).toBe('APP_USR-loja-b');
    // UPDATE stores SET mp_access_token_encrypted = (o da loja B) WHERE id = A
    expect(() => decryptStoreSecret(7, fromB, PROD)).toThrow();
    // Sem informar a loja também não decifra
    expect(() => decryptSecret(fromB, PROD)).toThrow(/informe a loja/);
    expect(() => storeSecretContext(0)).toThrow();
    expect(storeSecretContext(7)).toBe('store:7');
  });

  it('formato antigo (v1, sem vínculo) continua legível até ser regravado', () => {
    const legacy = encryptSecret('APP_USR-antigo', PROD);
    expect(secretFormatVersion(legacy)).toBe('v1');
    expect(decryptSecret(legacy, PROD)).toBe('APP_USR-antigo');
    expect(decryptStoreSecret(7, legacy, PROD)).toBe('APP_USR-antigo');
    expect(() => decryptSecret(`v3:${legacy.slice(3)}`, PROD)).toThrow(
      /formato desconhecido/,
    );
    expect(secretFormatVersion('lixo')).toBeNull();
  });

  it('upgradeStoreSecret: v1 vira v2 preso à loja; v2 não muda (idempotente); ilegível lança', () => {
    const legacy = encryptSecret('APP_USR-antigo-123', PROD);
    const upgraded = upgradeStoreSecret(7, legacy, PROD);
    expect(upgraded).not.toBeNull();
    expect(secretFormatVersion(upgraded!)).toBe('v2');
    expect(upgraded).not.toContain('APP_USR');
    expect(decryptStoreSecret(7, upgraded!, PROD)).toBe('APP_USR-antigo-123');
    // Preso à loja: em outra loja (ou sem contexto) não decifra
    expect(() => decryptStoreSecret(8, upgraded!, PROD)).toThrow();
    expect(() => decryptSecret(upgraded!, PROD)).toThrow(/contexto/);

    // Idempotente: o valor já atual não é regravado (nem decifrado: mesmo com a chave errada)
    expect(upgradeStoreSecret(7, upgraded!, PROD)).toBeNull();
    const otherKey = {
      NODE_ENV: 'production',
      CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    };
    expect(upgradeStoreSecret(7, upgraded!, otherKey)).toBeNull();

    // Ilegível: formato desconhecido, adulterado ou de outra chave → erro (o valor fica como está)
    expect(() => upgradeStoreSecret(7, 'lixo', PROD)).toThrow(
      /formato desconhecido/,
    );
    expect(() => upgradeStoreSecret(7, legacy, otherKey)).toThrow();
    const [version, iv, tag, data] = legacy.split(':');
    const tampered = [version, iv, tag, `A${data.slice(1)}`].join(':');
    if (tampered !== legacy) {
      expect(() => upgradeStoreSecret(7, tampered, PROD)).toThrow();
    }
    // Produção sem chave: falha fechado com CredentialsKeyError (não confunde com valor ilegível)
    expect(() =>
      upgradeStoreSecret(7, legacy, { NODE_ENV: 'production' }),
    ).toThrow(CredentialsKeyError);
  });

  it('produção sem chave (ou com chave inválida) falha fechado', () => {
    expect(() => credentialsKey({ NODE_ENV: 'production' })).toThrow(
      CredentialsKeyError,
    );
    expect(() => credentialsKey({})).toThrow(CredentialsKeyError);
    expect(() =>
      credentialsKey({
        NODE_ENV: 'production',
        CREDENTIALS_ENCRYPTION_KEY: 'curta',
      }),
    ).toThrow(CredentialsKeyError);
  });

  it('development/test sem chave usa a chave fixa de desenvolvimento', () => {
    const env = { NODE_ENV: 'test' };
    expect(credentialsKey(env)).toHaveLength(32);
    expect(decryptSecret(encryptSecret('dev', env), env)).toBe('dev');
  });

  it('utilitários de token', () => {
    expect(sha256Hex('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(maskSecret('APP_USR-1234567890-abcdef')).toBe('APP_USR-12…cdef');
    expect(maskSecret(null)).toBeNull();
  });
});
