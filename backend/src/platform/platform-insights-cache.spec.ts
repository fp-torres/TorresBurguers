import { platformInsightsCacheMs } from '../config/env';
import { InsightsCache } from './platform-insights-cache';

describe('InsightsCache (dashboard e financeiro do superpainel)', () => {
  it('reaproveita o resultado dentro do prazo e carrega de novo depois dele', async () => {
    let now = 1_000;
    const cache = new InsightsCache(30_000, () => now);
    const load = jest
      .fn()
      .mockResolvedValueOnce({ total: 1 })
      .mockResolvedValueOnce({ total: 2 });

    expect(await cache.get('dashboard', load)).toEqual({ total: 1 });
    now += 29_999;
    expect(await cache.get('dashboard', load)).toEqual({ total: 1 });
    expect(load).toHaveBeenCalledTimes(1);
    now += 2;
    expect(await cache.get('dashboard', load)).toEqual({ total: 2 });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('pedidos simultâneos esperam a mesma carga (uma só ida ao banco); chaves diferentes não se misturam', async () => {
    const cache = new InsightsCache(30_000);
    let resolve!: (value: string) => void;
    const load = jest.fn(() => new Promise<string>((done) => (resolve = done)));
    const first = cache.get('finance|2026-01-01|2026-01-31', load);
    const second = cache.get('finance|2026-01-01|2026-01-31', load);
    resolve('janeiro');
    expect(await Promise.all([first, second])).toEqual(['janeiro', 'janeiro']);
    expect(load).toHaveBeenCalledTimes(1);

    const other = jest.fn().mockResolvedValue('fevereiro');
    expect(await cache.get('finance|2026-02-01|2026-02-28', other)).toBe(
      'fevereiro',
    );
  });

  it('falha não fica no cache', async () => {
    const cache = new InsightsCache(30_000);
    const load = jest
      .fn()
      .mockRejectedValueOnce(new Error('banco fora'))
      .mockResolvedValueOnce('ok');
    await expect(cache.get('dashboard', load)).rejects.toThrow('banco fora');
    expect(await cache.get('dashboard', load)).toBe('ok');
  });

  it('prazo 0 desliga o cache; no máximo 50 chaves guardadas', async () => {
    const off = new InsightsCache(0);
    const load = jest.fn().mockResolvedValue(1);
    await off.get('dashboard', load);
    await off.get('dashboard', load);
    expect(load).toHaveBeenCalledTimes(2);

    const cache = new InsightsCache(30_000);
    const loads = jest.fn((key: string) => Promise.resolve(key));
    for (let index = 0; index < 51; index++)
      await cache.get(`k${index}`, () => loads(`k${index}`));
    // A mais antiga saiu; a mais nova continua
    await cache.get('k0', () => loads('k0'));
    await cache.get('k50', () => loads('k50'));
    expect(loads).toHaveBeenCalledTimes(52);
  });

  it('PLATFORM_INSIGHTS_CACHE_MS: padrão 30 s, 0 desliga, inválido → padrão', () => {
    expect(platformInsightsCacheMs({})).toBe(30_000);
    expect(platformInsightsCacheMs({ PLATFORM_INSIGHTS_CACHE_MS: '0' })).toBe(
      0,
    );
    expect(
      platformInsightsCacheMs({ PLATFORM_INSIGHTS_CACHE_MS: '5000' }),
    ).toBe(5_000);
    expect(
      platformInsightsCacheMs({ PLATFORM_INSIGHTS_CACHE_MS: 'muito' }),
    ).toBe(30_000);
  });
});
