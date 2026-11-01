import { summarizeUserAgent, UNKNOWN_BROWSER } from './user-agent';

describe('summarizeUserAgent (resumo do navegador da sessão)', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Chrome no Windows',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
      'Edge no Windows',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      'Safari no macOS',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Safari no iOS',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
      'Samsung Internet no Android',
    ],
    [
      'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
      'Firefox no Linux',
    ],
    [
      'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Chrome no ChromeOS',
    ],
    ['okhttp/4.9.2', 'Aplicativo no Android'],
    ['Comestra/1 CFNetwork/1490.0.4 Darwin/23.2.0', 'Aplicativo no iOS'],
    ['Mozilla/5.0 (Windows NT 10.0) qualquer', 'Navegador no Windows'],
  ])('%s → %s', (agent, expected) => {
    expect(summarizeUserAgent(agent)).toBe(expected);
  });

  it('sem navegador conhecido ou vazio → "Navegador desconhecido"', () => {
    for (const agent of [
      null,
      undefined,
      '',
      '   ',
      'Playwright/1.63.0 (x64)',
    ]) {
      expect(summarizeUserAgent(agent)).toBe(UNKNOWN_BROWSER);
    }
  });
});
