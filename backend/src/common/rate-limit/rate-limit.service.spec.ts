import { HttpException, Logger } from '@nestjs/common';
import {
  RATE_LIMIT_SWEEP_BATCH,
  RateLimitService,
  TOO_MANY_ATTEMPTS_MESSAGE,
  resolvePolicy,
} from './rate-limit.service';

describe('RateLimitService', () => {
  const original = { ...process.env };
  let service: RateLimitService;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  beforeEach(() => {
    process.env = { ...original };
    delete process.env.RATE_LIMIT_ENABLED;
    delete process.env.RATE_LIMIT_FORGOT_PASSWORD;
    service = new RateLimitService();
  });

  afterAll(() => {
    process.env = original;
  });

  it('bloqueia depois do limite e libera quando a janela passa', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) service.consume('FORGOT_PASSWORD', 'ip-1', t0);
    expect(() => service.consume('FORGOT_PASSWORD', 'ip-1', t0)).toThrow(
      HttpException,
    );
    // outra chave não é afetada
    expect(() => service.consume('FORGOT_PASSWORD', 'ip-2', t0)).not.toThrow();
    // 15 minutos depois a janela liberou
    expect(() =>
      service.consume('FORGOT_PASSWORD', 'ip-1', t0 + 15 * 60_000 + 1),
    ).not.toThrow();
  });

  it('responde 429 no formato de erro do contrato ({ statusCode, message, error })', () => {
    for (let i = 0; i < 5; i++) service.consume('FORGOT_PASSWORD', 'ip', 1);
    try {
      service.consume('FORGOT_PASSWORD', 'ip', 1);
      fail('deveria lançar');
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(429);
      expect((error as HttpException).getResponse()).toEqual({
        statusCode: 429,
        message: TOO_MANY_ATTEMPTS_MESSAGE,
        error: 'Too Many Requests',
      });
      expect((error as HttpException).message).toBe(TOO_MANY_ATTEMPTS_MESSAGE);
    }
    for (let i = 0; i < 10; i++) service.hit('LOGIN_FAILURES', 'ip|x@y.com');
    try {
      service.assertNotLimited('LOGIN_FAILURES', 'ip|x@y.com');
      fail('deveria lançar');
    } catch (error) {
      expect((error as HttpException).getResponse()).toMatchObject({
        statusCode: 429,
        error: 'Too Many Requests',
      });
    }
  });

  it('falhas de login: hit conta, reset zera, chave sem diferenciar maiúsculas', () => {
    for (let i = 0; i < 10; i++) service.hit('LOGIN_FAILURES', 'IP|A@B.COM');
    expect(service.isLimited('LOGIN_FAILURES', 'ip|a@b.com')).toBe(true);
    expect(() =>
      service.assertNotLimited('LOGIN_FAILURES', 'ip|a@b.com'),
    ).toThrow(HttpException);
    service.reset('LOGIN_FAILURES', 'ip|a@b.com');
    expect(service.isLimited('LOGIN_FAILURES', 'ip|a@b.com')).toBe(false);
  });

  it('RATE_LIMIT_<NOME> sobrescreve a política; valor inválido usa o padrão', () => {
    expect(resolvePolicy('SIGNUP', { RATE_LIMIT_SIGNUP: '1000/3600' })).toEqual(
      { limit: 1000, windowSeconds: 3600 },
    );
    expect(resolvePolicy('SIGNUP', { RATE_LIMIT_SIGNUP: 'muito' })).toEqual({
      limit: 30,
      windowSeconds: 3600,
    });
  });

  it('take: conta na hora (429 no limite) e a função devolvida desfaz só aquela contagem, uma vez', () => {
    process.env.RATE_LIMIT_FORGOT_PASSWORD = '2/900';
    const first = service.take('FORGOT_PASSWORD', 'k', 1);
    const second = service.take('FORGOT_PASSWORD', 'k', 2);
    expect(() => service.take('FORGOT_PASSWORD', 'k', 3)).toThrow(
      HttpException,
    );
    first();
    first(); // idempotente: não libera uma vaga a mais
    expect(service.isLimited('FORGOT_PASSWORD', 'k', 4)).toBe(false);
    const third = service.take('FORGOT_PASSWORD', 'k', 5);
    expect(service.isLimited('FORGOT_PASSWORD', 'k', 6)).toBe(true);
    second();
    third();
    expect(service.isLimited('FORGOT_PASSWORD', 'k', 7)).toBe(false);
  });

  it('rajada simultânea: reservar antes do trabalho assíncrono deixa passar só o limite (conferir e contar depois deixaria todas)', async () => {
    process.env.RATE_LIMIT_LOGIN_FAILURES = '10/900';
    const slowCheck = () => new Promise((resolve) => setTimeout(resolve, 5));

    // Padrão antigo (assertNotLimited → await → hit): as 50 passam pela conferência juntas
    const old = await Promise.allSettled(
      Array.from({ length: 50 }, async () => {
        service.assertNotLimited('LOGIN_FAILURES', 'antigo');
        await slowCheck();
        service.hit('LOGIN_FAILURES', 'antigo');
      }),
    );
    expect(old.filter((r) => r.status === 'fulfilled')).toHaveLength(50);

    // take() antes do trabalho: exatamente 10 passam, as outras 40 recebem 429 na hora
    let checked = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, async () => {
        service.take('LOGIN_FAILURES', 'novo');
        checked++;
        await slowCheck();
      }),
    );
    expect(checked).toBe(10);
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(rejected).toHaveLength(40);
    expect(
      rejected.every((r) => (r.reason as HttpException).getStatus?.() === 429),
    ).toBe(true);
  });

  it('consume é atômico: chamadas simultâneas nunca passam do limite', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, () =>
        Promise.resolve().then(() =>
          service.consume('FORGOT_PASSWORD', 'rajada', 1),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
  });

  it('RATE_LIMIT_ENABLED=false desliga', () => {
    process.env.RATE_LIMIT_ENABLED = 'false';
    for (let i = 0; i < 50; i++) service.consume('FORGOT_PASSWORD', 'ip', 1);
    expect(service.isLimited('FORGOT_PASSWORD', 'ip')).toBe(false);
  });

  describe('limpeza periódica (memória)', () => {
    it('cada balde sai pela janela da PRÓPRIA regra (CEP de 60 s não fica 1 h na memória)', () => {
      const t0 = Date.now();
      for (let i = 0; i < 100; i++) service.hit('CEP_LOOKUP', `ip-${i}`, t0);
      service.hit('LOGIN_FAILURES', 'ip-x:alguem@x.com', t0);
      expect(service.size).toBe(101);

      // 2 min depois: a limpeza roda; os CEPs (janela de 60 s) saem, a falha de login (15 min) fica
      service.hit('SIGNUP', 'ip-novo', t0 + 2 * 60_000);
      expect(service.size).toBe(2);
      expect(service.isLimited('LOGIN_FAILURES', 'ip-x:alguem@x.com')).toBe(
        false,
      );
    });

    it('eventos dentro da janela nunca saem na limpeza: forçar uma limpeza não zera o próprio balde', () => {
      const t0 = Date.now();
      for (let i = 0; i < 5; i++)
        service.consume('FORGOT_PASSWORD', 'ip-atacante', t0);
      // Limpeza (61 s depois) disparada pelo próprio atacante: ainda dentro da janela de 15 min
      service.hit('SIGNUP', 'ip-atacante', t0 + 61_000);
      expect(service.size).toBe(2);
      expect(() =>
        service.consume('FORGOT_PASSWORD', 'ip-atacante', t0 + 61_000),
      ).toThrow(HttpException);
    });

    it('em fatias: cada chamada confere no máximo RATE_LIMIT_SWEEP_BATCH baldes', () => {
      const t0 = Date.now();
      for (let i = 0; i < RATE_LIMIT_SWEEP_BATCH + 10; i++)
        service.hit('CEP_LOOKUP', `ip-${i}`, t0);
      const later = t0 + 2 * 60_000;
      service.hit('SIGNUP', 'ip-a', later);
      // Primeira fatia: RATE_LIMIT_SWEEP_BATCH baldes conferidos; o resto fica para a próxima chamada
      expect(service.size).toBe(10 + 1);
      service.hit('SIGNUP', 'ip-b', later + 1);
      expect(service.size).toBe(2);
    });
  });
});
