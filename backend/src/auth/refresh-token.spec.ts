import { createHash } from 'node:crypto';
import {
  compareHash,
  createRefreshToken,
  parseRefreshToken,
  refreshHash,
} from './refresh-token';

describe('refresh da sessão do site (refresh-token.ts)', () => {
  it('formato v1.<seletor de 16 bytes>.<validador de 32 bytes>, em base64url, e só o hash do validador', () => {
    const token = createRefreshToken();
    expect(token.token).toMatch(/^v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(token.token).toBe(`v1.${token.selector}.${token.validator}`);
    expect(Buffer.from(token.selector, 'base64url')).toHaveLength(16);
    expect(Buffer.from(token.validator, 'base64url')).toHaveLength(32);
    expect(token.hash).toBe(
      createHash('sha256').update(token.validator, 'utf8').digest('hex'),
    );
    expect(token.hash).not.toContain(token.validator);
  });

  it('cada refresh é aleatório; a rotação mantém o seletor e troca o validador', () => {
    const first = createRefreshToken();
    const other = createRefreshToken();
    expect(other.selector).not.toBe(first.selector);
    const rotated = createRefreshToken(first.selector);
    expect(rotated.selector).toBe(first.selector);
    expect(rotated.validator).not.toBe(first.validator);
    expect(rotated.hash).not.toBe(first.hash);
  });

  it('parse estrito: só o formato exato (nada de outro tamanho, versão, espaço ou tipo)', () => {
    const { token, selector, validator } = createRefreshToken();
    expect(parseRefreshToken(token)).toEqual({ selector, validator });
    for (const invalid of [
      undefined,
      null,
      42,
      '',
      `v2.${selector}.${validator}`,
      `v1.${selector}.${validator}x`,
      `v1.${selector}x.${validator}`,
      `v1.${selector}.${validator.slice(1)}`,
      ` ${token}`,
      `${token}\n`,
      `v1.${selector}.${validator}.extra`,
      `v1.${selector.replace(/./, '+')}.${validator}`,
      `v1.${selector}`,
    ]) {
      expect(parseRefreshToken(invalid)).toBeNull();
    }
  });

  it('compareHash: igual só com o mesmo hash; null, vazio ou formato inválido → false', () => {
    const hash = refreshHash('validador');
    expect(compareHash(hash, hash)).toBe(true);
    expect(compareHash(hash, hash.toUpperCase())).toBe(true);
    expect(compareHash(hash, refreshHash('outro'))).toBe(false);
    expect(compareHash(hash, null)).toBe(false);
    expect(compareHash(null, hash)).toBe(false);
    expect(compareHash('', '')).toBe(false);
    expect(compareHash('abc', 'abc')).toBe(false);
    expect(compareHash(hash.slice(0, 63), hash.slice(0, 63))).toBe(false);
  });
});
