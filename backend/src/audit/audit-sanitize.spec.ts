import { maskEmail, sanitizeForAudit } from './audit-sanitize';

describe('sanitizeForAudit', () => {
  it('remove senhas, tokens e segredos em qualquer nível', () => {
    const result = sanitizeForAudit({
      email: 'a@b.com',
      password: 'Segredo@123',
      nested: {
        access_token: 'eyJ...',
        mp_access_token: 'APP_USR-1',
        refreshToken: 'r',
        apiKey: 'k',
        keep: 'ok',
      },
      list: [{ secret: 's', name: 'n' }],
      Authorization: 'Bearer x',
      card_number: '4111',
    });

    expect(result).toEqual({
      email: 'a@b.com',
      password: '[removido]',
      nested: {
        access_token: '[removido]',
        mp_access_token: '[removido]',
        refreshToken: '[removido]',
        apiKey: '[removido]',
        keep: 'ok',
      },
      list: [{ secret: '[removido]', name: 'n' }],
      Authorization: '[removido]',
      card_number: '[removido]',
    });
    expect(JSON.stringify(result)).not.toMatch(/Segredo|APP_USR|eyJ|Bearer/);
  });

  it('funções e símbolos não são gravados; bigint vira texto', () => {
    expect(
      sanitizeForAudit({ fn: () => 1, sym: Symbol('x'), big: BigInt(10) }),
    ).toEqual({ fn: null, sym: null, big: '10' });
  });

  it('corta textos longos e estruturas profundas', () => {
    const long = 'x'.repeat(2000);
    expect((sanitizeForAudit(long) as string).length).toBeLessThan(510);
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    expect(JSON.stringify(sanitizeForAudit(deep))).toContain('[…]');
  });

  it('datas viram ISO e valores simples são mantidos', () => {
    expect(sanitizeForAudit(new Date('2026-01-01T00:00:00Z'))).toBe(
      '2026-01-01T00:00:00.000Z',
    );
    expect(sanitizeForAudit(3)).toBe(3);
    expect(sanitizeForAudit(null)).toBeNull();
  });
});

describe('maskEmail', () => {
  it('mostra só o começo do usuário e o domínio', () => {
    expect(maskEmail('maria.silva@gmail.com')).toBe('ma***@gmail.com');
    expect(maskEmail('a@b.com')).toBe('a***@b.com');
    expect(maskEmail('')).toBe('');
  });
});
