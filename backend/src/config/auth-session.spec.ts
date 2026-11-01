import type { Request } from 'express';
import { corsOptionsDelegate } from './app-setup';
import {
  accessTokenTtlSeconds,
  authSessionWarnings,
  cookieSameSite,
  credentialOrigins,
  DEFAULT_ACCESS_TTL_SECONDS,
  DEFAULT_REFRESH_GRACE_SECONDS,
  durationSeconds,
  refreshGraceSeconds,
  sessionMaxAgeSeconds,
  webCookieEnabled,
} from './auth-session';

describe('Sessão do site em cookie: configuração (config/auth-session.ts)', () => {
  it('durationSeconds: formatos do JWT_EXPIRES_IN e números (segundos)', () => {
    expect(durationSeconds('15m')).toBe(900);
    expect(durationSeconds('7d')).toBe(604_800);
    expect(durationSeconds('90s')).toBe(90);
    expect(durationSeconds('2 hours')).toBe(7200);
    expect(durationSeconds('3600')).toBe(3600);
    expect(durationSeconds(120)).toBe(120);
    expect(durationSeconds('abc')).toBeNull();
    expect(durationSeconds('0')).toBeNull();
    expect(durationSeconds('')).toBeNull();
  });

  it('JWT_ACCESS_EXPIRES_IN: padrão 15 min; de 1 a 60 min; inválido ou fora da faixa → 15 min', () => {
    expect(accessTokenTtlSeconds({})).toBe(DEFAULT_ACCESS_TTL_SECONDS);
    expect(DEFAULT_ACCESS_TTL_SECONDS).toBe(900);
    expect(accessTokenTtlSeconds({ JWT_ACCESS_EXPIRES_IN: '5m' })).toBe(300);
    expect(accessTokenTtlSeconds({ JWT_ACCESS_EXPIRES_IN: '60m' })).toBe(3600);
    expect(accessTokenTtlSeconds({ JWT_ACCESS_EXPIRES_IN: '30s' })).toBe(900);
    expect(accessTokenTtlSeconds({ JWT_ACCESS_EXPIRES_IN: '2h' })).toBe(900);
    expect(accessTokenTtlSeconds({ JWT_ACCESS_EXPIRES_IN: 'x' })).toBe(900);
  });

  it('AUTH_SESSION_MAX_AGE: padrão = JWT_EXPIRES_IN (7 dias); inválido → o padrão', () => {
    expect(sessionMaxAgeSeconds({})).toBe(604_800);
    expect(sessionMaxAgeSeconds({ JWT_EXPIRES_IN: '12h' })).toBe(43_200);
    expect(sessionMaxAgeSeconds({ AUTH_SESSION_MAX_AGE: '1d' })).toBe(86_400);
    expect(sessionMaxAgeSeconds({ AUTH_SESSION_MAX_AGE: '1m' })).toBe(604_800);
    expect(sessionMaxAgeSeconds({ AUTH_SESSION_MAX_AGE: 'sempre' })).toBe(
      604_800,
    );
  });

  it('AUTH_REFRESH_GRACE_SECONDS: padrão 30, de 0 a 120', () => {
    expect(refreshGraceSeconds({})).toBe(DEFAULT_REFRESH_GRACE_SECONDS);
    expect(refreshGraceSeconds({ AUTH_REFRESH_GRACE_SECONDS: '0' })).toBe(0);
    expect(refreshGraceSeconds({ AUTH_REFRESH_GRACE_SECONDS: '3' })).toBe(3);
    expect(refreshGraceSeconds({ AUTH_REFRESH_GRACE_SECONDS: '121' })).toBe(30);
    expect(refreshGraceSeconds({ AUTH_REFRESH_GRACE_SECONDS: '-1' })).toBe(30);
  });

  it('AUTH_COOKIE_SAMESITE: strict (padrão) ou lax', () => {
    expect(cookieSameSite({})).toBe('strict');
    expect(cookieSameSite({ AUTH_COOKIE_SAMESITE: 'LAX' })).toBe('lax');
    expect(cookieSameSite({ AUTH_COOKIE_SAMESITE: 'none' })).toBe('strict');
  });

  describe('origens de credencial', () => {
    it('padrão: CORS_ORIGINS explícito + origem de APP_WEB_URL (sem barra, sem caminho, sem repetição)', () => {
      expect(
        credentialOrigins({
          NODE_ENV: 'production',
          CORS_ORIGINS: 'https://app.loja.com.br/, https://painel.loja.com.br',
          APP_WEB_URL: 'https://app.loja.com.br/entrar',
        }),
      ).toEqual(['https://app.loja.com.br', 'https://painel.loja.com.br']);
    });

    it('AUTH_COOKIE_ORIGINS substitui o padrão; "*" e valores inválidos são ignorados', () => {
      expect(
        credentialOrigins({
          NODE_ENV: 'production',
          CORS_ORIGINS: 'https://a.com',
          AUTH_COOKIE_ORIGINS: 'https://b.com, *, javascript:alert(1), lixo',
        }),
      ).toEqual(['https://b.com']);
    });

    it('CORS_ORIGINS vazio ou "*" não conta; em development/test sem APP_WEB_URL vale a do Vite', () => {
      expect(
        credentialOrigins({ NODE_ENV: 'production', CORS_ORIGINS: '*' }),
      ).toEqual([]);
      expect(credentialOrigins({ NODE_ENV: 'development' })).toEqual([
        'http://localhost:5173',
      ]);
      expect(credentialOrigins({ NODE_ENV: 'production' })).toEqual([]);
    });

    it('produção sem origens explícitas desliga o modo cookie (com aviso); AUTH_WEB_COOKIE=false desliga sempre', () => {
      expect(webCookieEnabled({ NODE_ENV: 'production' })).toBe(false);
      expect(authSessionWarnings({ NODE_ENV: 'production' })).toEqual([
        expect.stringContaining('Sessão do site em cookie desligada'),
      ]);
      expect(
        webCookieEnabled({
          NODE_ENV: 'production',
          CORS_ORIGINS: 'https://app.loja.com.br',
        }),
      ).toBe(true);
      expect(
        authSessionWarnings({
          NODE_ENV: 'production',
          CORS_ORIGINS: 'https://app.loja.com.br',
        }),
      ).toEqual([]);
      expect(webCookieEnabled({ NODE_ENV: 'development' })).toBe(true);
      expect(
        webCookieEnabled({ NODE_ENV: 'development', AUTH_WEB_COOKIE: 'false' }),
      ).toBe(false);
      expect(authSessionWarnings({ NODE_ENV: 'development' })).toEqual([]);
    });
  });

  describe('CORS por requisição (corsOptionsDelegate)', () => {
    function resolve(
      env: NodeJS.ProcessEnv,
      origin?: string,
    ): Record<string, unknown> {
      const delegate = corsOptionsDelegate(env);
      let options: Record<string, unknown> = {};
      delegate(
        { headers: origin ? { origin } : {} } as Request,
        (error, value) => {
          if (error) throw error;
          options = value as Record<string, unknown>;
        },
      );
      return options;
    }

    it('credenciais só para as origens explícitas, com a origem exata', () => {
      const env = {
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://app.loja.com.br',
      } as NodeJS.ProcessEnv;
      expect(resolve(env, 'https://app.loja.com.br')).toMatchObject({
        origin: 'https://app.loja.com.br',
        credentials: true,
        maxAge: 600,
      });
      expect(resolve(env, 'https://evil.example')).toMatchObject({
        origin: ['https://app.loja.com.br'],
        credentials: false,
      });
    });

    it('CORS_ORIGINS vazio em desenvolvimento: reflete a origem SEM credenciais (só a do site tem)', () => {
      const env = {
        NODE_ENV: 'development',
        APP_WEB_URL: 'http://localhost:5173',
      } as NodeJS.ProcessEnv;
      expect(resolve(env, 'http://192.168.0.10:5173')).toMatchObject({
        origin: true,
        credentials: false,
      });
      expect(resolve(env, 'http://localhost:5173')).toMatchObject({
        origin: 'http://localhost:5173',
        credentials: true,
      });
      expect(resolve(env)).toMatchObject({ credentials: false });
    });
  });
});
