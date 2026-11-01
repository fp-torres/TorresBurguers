import type { Request } from 'express';
import { uploadLimitKey } from './image-upload';

const requestFrom = (ip: string, user?: { id: number }) =>
  ({ ip, headers: {}, user }) as unknown as Request & {
    user?: { id: number } | null;
  };

describe('uploadLimitKey (limite UPLOAD)', () => {
  it('com login: a conta; sem login: o IP com a mesma chave dos outros limites (IPv6 pela rede /64)', () => {
    expect(uploadLimitKey(requestFrom('2001:db8::1', { id: 7 }) as never)).toBe(
      'user:7',
    );
    const first = uploadLimitKey(requestFrom('2001:db8:aa:bb:1::1') as never);
    const second = uploadLimitKey(
      requestFrom('2001:db8:aa:bb:ffff::2') as never,
    );
    // Trocar de endereço dentro da mesma rede /64 não fura o limite
    expect(first).toBe(second);
    expect(first.startsWith('ip:')).toBe(true);
    expect(uploadLimitKey(requestFrom('::ffff:203.0.113.9') as never)).toBe(
      'ip:203.0.113.9',
    );
  });
});
