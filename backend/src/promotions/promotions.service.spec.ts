import { Logger } from '@nestjs/common';
import axios from 'axios';
import type { Cache } from 'cache-manager';
import { PromotionsService } from './promotions.service';

jest.mock('axios');
// eslint-disable-next-line @typescript-eslint/unbound-method -- mock do jest, sem uso de this
const mockedGet = axios.get as jest.MockedFunction<typeof axios.get>;

/** Cache em memória simples para os testes. */
function memoryCache() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: jest.fn((key: string) => Promise.resolve(store.get(key))),
    set: jest.fn((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve(value);
    }),
  };
}

describe('PromotionsService.getBanner', () => {
  const originalToken = process.env.FOOTBALL_DATA_TOKEN;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    process.env.FOOTBALL_DATA_TOKEN = originalToken;
  });

  it('sem token: sugestão do dia no fuso de Brasília, com título e mensagem', async () => {
    delete process.env.FOOTBALL_DATA_TOKEN;
    // Terça 01:30 UTC = segunda 22:30 em Brasília
    jest.useFakeTimers({ now: new Date('2026-10-13T01:30:00Z') });
    const cache = memoryCache();
    const service = new PromotionsService(cache as unknown as Cache);

    const banner = await service.getBanner();

    expect(banner).toMatchObject({
      type: 'promo',
      title: 'Começo de semana 🍔', // segunda-feira
    });
    expect(banner.message).toMatch(/^Sugestão do dia: /);
    expect(cache.store.has('home_banner:2026-10-12')).toBe(true);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('a sugestão de cada dia da semana não promete desconto, brinde nem cupom', async () => {
    delete process.env.FOOTBALL_DATA_TOKEN;
    // 11/10/2026 é domingo: 7 dias seguidos, ao meio-dia em Brasília
    for (let day = 11; day <= 17; day++) {
      jest.useFakeTimers({ now: new Date(`2026-10-${day}T15:00:00Z`) });
      const banner = await new PromotionsService(
        memoryCache() as unknown as Cache,
      ).getBanner();

      expect(banner.type).toBe('promo');
      expect(banner).not.toHaveProperty('coupon');
      expect(banner.title.trim()).not.toBe('');
      expect(banner.message).toMatch(/^Sugestão do dia: /);
      expect(`${banner.title} ${banner.message}`).not.toMatch(
        /%|R\$|gr[aá]tis|desconto|off\b|cupom|metade|frete/i,
      );
    }
  });

  it('com jogo hoje (horário local): banner de futebol', async () => {
    process.env.FOOTBALL_DATA_TOKEN = 'token-de-teste';
    jest.useFakeTimers({ now: new Date('2026-10-14T15:00:00Z') }); // quarta, 12:00 em Brasília
    mockedGet.mockResolvedValueOnce({
      data: {
        matches: [
          {
            // 00:30 UTC de quinta = 21:30 de quarta em Brasília
            utcDate: '2026-10-15T00:30:00Z',
            status: 'TIMED',
            homeTeam: { name: 'Clube A', shortName: 'A' },
            awayTeam: { name: 'Clube B', shortName: 'B' },
            competition: { name: 'Brasileirão', code: 'BSA' },
          },
          {
            // 12:00 de quinta em Brasília: não é hoje
            utcDate: '2026-10-15T15:00:00Z',
            status: 'TIMED',
            homeTeam: { name: 'Clube C' },
            awayTeam: { name: 'Clube D' },
            competition: { name: 'Premier League', code: 'PL' },
          },
        ],
      },
    });
    const service = new PromotionsService(memoryCache() as unknown as Cache);

    const banner = await service.getBanner();

    expect(banner).toMatchObject({
      type: 'football',
      message: 'A x B às 21:30',
      details: {
        home: 'Clube A',
        away: 'Clube B',
        tournament: 'Brasileirão',
        time: '21:30',
      },
    });
    expect(banner.title).toBeTruthy();
    expect(mockedGet.mock.calls[0][1]?.params).toMatchObject({
      dateFrom: '2026-10-14',
      dateTo: '2026-10-15',
    });
  });

  it('API de futebol fora do ar ou cache quebrado: nunca lança erro', async () => {
    process.env.FOOTBALL_DATA_TOKEN = 'token-de-teste';
    jest.useFakeTimers({ now: new Date('2026-10-16T15:00:00Z') }); // sexta
    mockedGet.mockRejectedValueOnce(new Error('timeout'));
    const service = new PromotionsService(memoryCache() as unknown as Cache);
    await expect(service.getBanner()).resolves.toMatchObject({
      type: 'promo',
      title: 'Sextou! 🎉',
    });

    const broken = {
      get: jest.fn().mockRejectedValue(new Error('cache indisponível')),
      set: jest.fn(),
    };
    const fallback = new PromotionsService(broken as unknown as Cache);
    await expect(fallback.getBanner()).resolves.toMatchObject({
      type: 'promo',
    });
  });
});
