import { ipRateLimitKey } from './ip-key';

describe('ipRateLimitKey (chave de IP dos limites de tentativas)', () => {
  it('IPv4 fica como está', () => {
    expect(ipRateLimitKey('200.10.20.30')).toBe('200.10.20.30');
    expect(ipRateLimitKey('127.0.0.1')).toBe('127.0.0.1');
  });

  it('IPv4 escrito como IPv6 (::ffff:a.b.c.d) conta como o IPv4', () => {
    expect(ipRateLimitKey('::ffff:200.10.20.30')).toBe('200.10.20.30');
    expect(ipRateLimitKey('::FFFF:127.0.0.1')).toBe('127.0.0.1');
  });

  it('endereços do mesmo /64 dividem a mesma chave', () => {
    const keys = [
      '2001:db8:1:2::1',
      '2001:db8:1:2:ffff:ffff:ffff:ffff',
      '2001:0db8:0001:0002:abcd:0:0:1',
      '2001:DB8:1:2:0:0:0:9',
      '2001:db8:1:2::1.2.3.4',
      'fe80::1%eth0'.replace('fe80::1', '2001:db8:1:2::7'),
    ].map(ipRateLimitKey);
    expect(new Set(keys)).toEqual(new Set(['2001:db8:1:2::/64']));
  });

  it('redes /64 diferentes têm chaves diferentes', () => {
    expect(ipRateLimitKey('2001:db8:1:2::1')).not.toBe(
      ipRateLimitKey('2001:db8:1:3::1'),
    );
    expect(ipRateLimitKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipRateLimitKey('::1')).toBe('0:0:0:0::/64');
    expect(ipRateLimitKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('texto que não é IP fica como está (nunca lança)', () => {
    for (const value of ['desconhecido', '', 'not-an-ip', '1.2.3', ':::']) {
      expect(ipRateLimitKey(value)).toBe(value);
    }
  });
});
