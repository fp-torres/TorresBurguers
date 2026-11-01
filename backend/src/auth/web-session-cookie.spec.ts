import { ForbiddenException } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  assertCookieRequest,
  clearRefreshCookie,
  cookieRequestCheck,
  DEV_REFRESH_COOKIE,
  emissionTransport,
  readRefreshCookie,
  refreshCookieName,
  refreshCookieOptions,
  requestedCookieTransport,
  SECURE_REFRESH_COOKIE,
  setRefreshCookie,
} from './web-session-cookie';

const DEV = {
  NODE_ENV: 'development',
  APP_WEB_URL: 'http://localhost:5173',
} as NodeJS.ProcessEnv;
const PROD = {
  NODE_ENV: 'production',
  APP_WEB_URL: 'https://app.comestra.com.br',
} as NodeJS.ProcessEnv;

function req(
  headers: Record<string, string> = {},
  secure = false,
): Pick<Request, 'headers' | 'secure'> {
  return { headers, secure } as Pick<Request, 'headers' | 'secure'>;
}

describe('cookie do refresh (web-session-cookie.ts)', () => {
  it('nome e Secure: __Host- com Secure em produção e em HTTPS; sem Secure só em http fora de produção', () => {
    expect(SECURE_REFRESH_COOKIE).toBe('__Host-comestra_rt');
    expect(DEV_REFRESH_COOKIE).toBe('comestra_rt');
    expect(refreshCookieName(req(), DEV)).toBe('comestra_rt');
    expect(refreshCookieOptions(req(), DEV).secure).toBe(false);
    expect(refreshCookieName(req({}, true), DEV)).toBe('__Host-comestra_rt');
    expect(refreshCookieOptions(req({}, true), DEV).secure).toBe(true);
    // Produção: sempre Secure (atrás do proxy HTTPS, mesmo que a API veja http)
    expect(refreshCookieName(req(), PROD)).toBe('__Host-comestra_rt');
    expect(refreshCookieOptions(req(), PROD)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
    });
  });

  it('SameSite: strict por padrão; lax só com AUTH_COOKIE_SAMESITE=lax; valor inválido → strict', () => {
    expect(refreshCookieOptions(req(), DEV).sameSite).toBe('strict');
    expect(
      refreshCookieOptions(req(), { ...DEV, AUTH_COOKIE_SAMESITE: 'lax' })
        .sameSite,
    ).toBe('lax');
    expect(
      refreshCookieOptions(req(), { ...DEV, AUTH_COOKIE_SAMESITE: 'none' })
        .sameSite,
    ).toBe('strict');
  });

  it('set: HttpOnly, Path=/, sem Domain e Max-Age até o fim da sessão; clear: mesmos atributos', () => {
    const cookie = jest.fn();
    const clearCookie = jest.fn();
    const expiresAt = new Date(Date.now() + 3600_000);
    setRefreshCookie({ cookie }, req(), 'v1.a.b', expiresAt, DEV);
    const [name, value, options] = cookie.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe('comestra_rt');
    expect(value).toBe('v1.a.b');
    expect(options).toMatchObject({
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: false,
    });
    expect(options).not.toHaveProperty('domain');
    expect(options.maxAge).toBeGreaterThan(3590_000);
    expect(options.maxAge).toBeLessThanOrEqual(3600_000);

    clearRefreshCookie({ clearCookie }, req({}, true), DEV);
    expect(clearCookie).toHaveBeenCalledWith('__Host-comestra_rt', {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
    });
  });

  it('leitura: acha o cookie entre outros; nome duplicado (cookie plantado) é inválido; ausente', () => {
    expect(readRefreshCookie(req(), DEV)).toEqual({ present: false });
    expect(
      readRefreshCookie(req({ cookie: 'tema=escuro; outro=1' }), DEV),
    ).toEqual({ present: false });
    expect(
      readRefreshCookie(
        req({ cookie: 'tema=escuro; comestra_rt=v1.abc.def; x=1' }),
        DEV,
      ),
    ).toEqual({ present: true, value: 'v1.abc.def' });
    expect(
      readRefreshCookie(
        req({ cookie: 'comestra_rt=v1.a.b; comestra_rt=v1.c.d' }),
        DEV,
      ),
    ).toEqual({ present: true, value: null });
    // Em HTTPS o nome é o __Host-: o cookie sem prefixo não vale
    expect(
      readRefreshCookie(req({ cookie: 'comestra_rt=v1.a.b' }, true), DEV),
    ).toEqual({ present: false });
    expect(
      readRefreshCookie(
        req({ cookie: '__Host-comestra_rt=v1.a.b' }, true),
        DEV,
      ),
    ).toEqual({ present: true, value: 'v1.a.b' });
  });

  describe('regras da requisição (cabeçalho, Origin e Sec-Fetch-Site)', () => {
    const header = { 'x-auth-transport': 'cookie' };

    it('sem o cabeçalho X-Auth-Transport: cookie → recusado', () => {
      expect(requestedCookieTransport(req())).toBe(false);
      expect(
        requestedCookieTransport(req({ 'x-auth-transport': 'bearer' })),
      ).toBe(false);
      expect(cookieRequestCheck(req(), DEV)).toBe('missing_header');
      expect(() => assertCookieRequest(req(), DEV)).toThrow(ForbiddenException);
    });

    it('Origin: da lista → aceito; fora da lista ou "null" → recusado; ausente → aceito', () => {
      expect(
        cookieRequestCheck(
          req({ ...header, origin: 'http://localhost:5173' }),
          DEV,
        ),
      ).toBe('ok');
      expect(
        cookieRequestCheck(
          req({ ...header, origin: 'https://evil.example' }),
          DEV,
        ),
      ).toBe('origin');
      expect(cookieRequestCheck(req({ ...header, origin: 'null' }), DEV)).toBe(
        'origin',
      );
      expect(cookieRequestCheck(req(header), DEV)).toBe('ok');
    });

    it('Sec-Fetch-Site: cross-site → recusado; same-site, same-origin ou ausente → aceito', () => {
      const origin = { ...header, origin: 'http://localhost:5173' };
      expect(
        cookieRequestCheck(
          req({ ...origin, 'sec-fetch-site': 'cross-site' }),
          DEV,
        ),
      ).toBe('site');
      for (const site of ['same-site', 'same-origin', 'none']) {
        expect(
          cookieRequestCheck(req({ ...origin, 'sec-fetch-site': site }), DEV),
        ).toBe('ok');
      }
      expect(() =>
        assertCookieRequest(
          req({ ...origin, 'sec-fetch-site': 'cross-site' }),
          DEV,
        ),
      ).toThrow('Origem não autorizada para a sessão deste navegador.');
    });

    it('emissão: sem cabeçalho → null (como hoje); válida → COOKIE; cross-site, origem errada ou AUTH_WEB_COOKIE=false → BEARER', () => {
      const ok = req({ ...header, origin: 'http://localhost:5173' });
      expect(emissionTransport(req(), DEV)).toBeNull();
      expect(emissionTransport(ok, DEV)).toBe('COOKIE');
      expect(
        emissionTransport(
          req({
            ...header,
            origin: 'http://localhost:5173',
            'sec-fetch-site': 'cross-site',
          }),
          DEV,
        ),
      ).toBe('BEARER');
      expect(
        emissionTransport(
          req({ ...header, origin: 'https://evil.example' }),
          DEV,
        ),
      ).toBe('BEARER');
      expect(emissionTransport(ok, { ...DEV, AUTH_WEB_COOKIE: 'false' })).toBe(
        'BEARER',
      );
      // Produção sem nenhuma origem explícita: modo cookie desligado
      expect(emissionTransport(req(header), { NODE_ENV: 'production' })).toBe(
        'BEARER',
      );
    });
  });
});
