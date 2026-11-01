import { Logger } from '@nestjs/common';
import {
  jwtLifetimeSeconds,
  legacyTokenAccepted,
  legacyTokenCutoff,
} from './legacy-token';

const DAY = 24 * 60 * 60;
const CUTOFF = '2026-11-01T12:00:00Z';
const cutoffSeconds = Date.parse(CUTOFF) / 1000;

const prod = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'production',
  ...extra,
});

describe('Tokens sem jti (janela de transição das sessões registradas)', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterAll(() => jest.restoreAllMocks());

  it('validade do JWT_EXPIRES_IN em segundos', () => {
    expect(jwtLifetimeSeconds({})).toBe(7 * DAY);
    expect(jwtLifetimeSeconds({ JWT_EXPIRES_IN: '12h' })).toBe(12 * 60 * 60);
    expect(jwtLifetimeSeconds({ JWT_EXPIRES_IN: '3600' })).toBe(3600);
    expect(jwtLifetimeSeconds({ JWT_EXPIRES_IN: '2 weeks' })).toBe(14 * DAY);
    expect(jwtLifetimeSeconds({ JWT_EXPIRES_IN: '30m' })).toBe(30 * 60);
  });

  it('produção sem JWT_LEGACY_ISSUED_BEFORE: nenhum token sem jti é aceito', () => {
    expect(legacyTokenCutoff(prod())).toBeNull();
    const now = Math.floor(Date.now() / 1000);
    expect(
      legacyTokenAccepted({ sub: 1, iat: now - 60, exp: now + DAY }, prod()),
    ).toBe(false);
    // NODE_ENV vazio também é produção
    expect(legacyTokenCutoff({})).toBeNull();
  });

  it('development/test sem o corte: aceitos até expirar, como antes', () => {
    for (const NODE_ENV of ['development', 'test']) {
      expect(legacyTokenAccepted({ sub: 1 }, { NODE_ENV })).toBe(true);
    }
  });

  it('com o corte: só os emitidos antes dele e com a validade normal', () => {
    const env = prod({ JWT_LEGACY_ISSUED_BEFORE: CUTOFF });
    const before = cutoffSeconds - 3600;
    expect(
      legacyTokenAccepted({ sub: 1, iat: before, exp: before + 7 * DAY }, env),
    ).toBe(true);
    // Emitido depois do corte: a API já só emite tokens com jti, então é forjado
    expect(
      legacyTokenAccepted(
        { sub: 1, iat: cutoffSeconds + 1, exp: cutoffSeconds + DAY },
        env,
      ),
    ).toBe(false);
    // iat antigo com validade esticada (forjado para passar do corte + JWT_EXPIRES_IN)
    expect(
      legacyTokenAccepted(
        { sub: 1, iat: before, exp: before + 365 * DAY },
        env,
      ),
    ).toBe(false);
    // Sem iat/exp numéricos → recusado
    expect(legacyTokenAccepted({ sub: 1 }, env)).toBe(false);
    expect(
      legacyTokenAccepted(
        { sub: 1, iat: String(before) as unknown as number, exp: before },
        env,
      ),
    ).toBe(false);
  });

  it('o corte vale em qualquer ambiente; "none" recusa todos; valor inválido recusa (com aviso)', () => {
    expect(
      legacyTokenAccepted(
        { sub: 1, iat: cutoffSeconds + 10, exp: cutoffSeconds + DAY },
        { NODE_ENV: 'development', JWT_LEGACY_ISSUED_BEFORE: CUTOFF },
      ),
    ).toBe(false);
    expect(
      legacyTokenCutoff({ NODE_ENV: 'test', JWT_LEGACY_ISSUED_BEFORE: 'none' }),
    ).toBeNull();
    expect(
      legacyTokenCutoff(prod({ JWT_LEGACY_ISSUED_BEFORE: 'amanhã' })),
    ).toBeNull();
  });
});
