import { Logger } from '@nestjs/common';
import axios from 'axios';
import type { Cache } from 'cache-manager';
import { PromotionsService } from './promotions.service';

jest.mock('axios');
// eslint-disable-next-line @typescript-eslint/unbound-method -- mock do jest, sem uso de this
const mockedGet = axios.get as jest.MockedFunction<typeof axios.get>;

/** Cache em memória simples para os testes (guarda também o TTL de cada chave). */
function memoryCache() {
  const store = new Map<string, unknown>();
  const ttls = new Map<string, number | undefined>();
  return {
    store,
    ttls,
    get: jest.fn((key: string) => Promise.resolve(store.get(key))),
    set: jest.fn((key: string, value: unknown, ttl?: number) => {
      store.set(key, value);
      ttls.set(key, ttl);
      return Promise.resolve(value);
    }),
  };
}

const HOUR = 60 * 60 * 1000;

/** Resposta da football-data.org com uma partida às 00:30 UTC de 15/10/2026. */
function matchesResponse() {
  return {
    data: {
      matches: [
        {
          // 00:30 UTC de quinta = 21:30 de quarta em Brasília (20:30 em Manaus)
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
  };
}

describe('PromotionsService', () => {
  const originalToken = process.env.FOOTBALL_DATA_TOKEN;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    process.env.FOOTBALL_DATA_TOKEN = originalToken;
  });

  describe('banner global (rotas antigas)', () => {
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
      mockedGet.mockResolvedValueOnce(matchesResponse());
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
      // Janela ontem–amanhã (UTC): cobre o "hoje" de qualquer fuso
      expect(mockedGet.mock.calls[0][1]?.params).toMatchObject({
        dateFrom: '2026-10-13',
        dateTo: '2026-10-15',
      });
    });

    it('API de futebol fora do ar ou cache quebrado: nunca lança erro', async () => {
      process.env.FOOTBALL_DATA_TOKEN = 'token-de-teste';
      jest.useFakeTimers({ now: new Date('2026-10-16T15:00:00Z') }); // sexta
      mockedGet.mockRejectedValueOnce(new Error('timeout'));
      const cache = memoryCache();
      const service = new PromotionsService(cache as unknown as Cache);
      await expect(service.getBanner()).resolves.toMatchObject({
        type: 'promo',
        title: 'Sextou! 🎉',
      });
      // Falha guardada por pouco tempo: tenta de novo em 15 minutos
      expect(cache.ttls.get('football_matches:2026-10-16')).toBe(15 * 60_000);
      expect(cache.ttls.get('home_banner:2026-10-16')).toBe(15 * 60_000);

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

  describe('banner da loja (/stores/:storeSlug/promotions/banner)', () => {
    it('"hoje" no fuso da loja e cache por loja', async () => {
      delete process.env.FOOTBALL_DATA_TOKEN;
      // Terça 01:30 UTC: segunda em Brasília, terça em Tóquio
      jest.useFakeTimers({ now: new Date('2026-10-13T01:30:00Z') });
      const cache = memoryCache();
      const service = new PromotionsService(cache as unknown as Cache);

      const tokyo = await service.getStoreBanner({
        id: 5,
        time_zone: 'Asia/Tokyo',
      });
      const brasilia = await service.getStoreBanner({
        id: 6,
        time_zone: 'America/Sao_Paulo',
      });

      expect(tokyo.title).toBe('Terça de petiscos 🍟');
      expect(brasilia.title).toBe('Começo de semana 🍔');
      expect([...cache.store.keys()]).toEqual(
        expect.arrayContaining([
          'home_banner:store:5:2026-10-13',
          'home_banner:store:6:2026-10-12',
        ]),
      );
      // A chave global (rotas antigas) não se mistura com a das lojas
      expect(cache.store.has('home_banner:2026-10-12')).toBe(false);
    });

    it('fuso inválido ou ausente: usa o fuso de Brasília', async () => {
      delete process.env.FOOTBALL_DATA_TOKEN;
      jest.useFakeTimers({ now: new Date('2026-10-13T01:30:00Z') });
      const cache = memoryCache();
      const service = new PromotionsService(cache as unknown as Cache);

      for (const time_zone of ['Fuso/Inexistente', null, undefined, '']) {
        await expect(
          service.getStoreBanner({ id: 9, time_zone }),
        ).resolves.toMatchObject({ title: 'Começo de semana 🍔' });
      }
      expect(cache.store.has('home_banner:store:9:2026-10-12')).toBe(true);
    });

    it('jogos buscados UMA vez por dia para toda a plataforma; horário no fuso de cada loja', async () => {
      process.env.FOOTBALL_DATA_TOKEN = 'token-de-teste';
      jest.useFakeTimers({ now: new Date('2026-10-14T15:00:00Z') });
      mockedGet.mockResolvedValue(matchesResponse());
      const cache = memoryCache();
      const service = new PromotionsService(cache as unknown as Cache);

      const [legacy, saoPaulo, manaus] = await Promise.all([
        service.getBanner(),
        service.getStoreBanner({ id: 1, time_zone: 'America/Sao_Paulo' }),
        service.getStoreBanner({ id: 2, time_zone: 'America/Manaus' }),
      ]);
      await service.getStoreBanner({ id: 3, time_zone: 'America/Recife' });

      expect(mockedGet).toHaveBeenCalledTimes(1);
      expect(cache.ttls.get('football_matches:2026-10-14')).toBe(HOUR);
      expect(legacy.message).toBe('A x B às 21:30');
      expect(saoPaulo).toEqual(legacy);
      expect(manaus).toMatchObject({
        type: 'football',
        message: 'A x B às 20:30',
        details: { time: '20:30' },
      });
      expect(cache.store.has('home_banner:store:2:2026-10-14')).toBe(true);
    });

    it('o "hoje" segue o fuso da loja: em Tóquio já é dia 15', async () => {
      process.env.FOOTBALL_DATA_TOKEN = 'token-de-teste';
      // 14/10 15:00 UTC = 15/10 00:00 em Tóquio; o jogo das 00:30 UTC (09:30 em Tóquio) é hoje lá
      jest.useFakeTimers({ now: new Date('2026-10-14T15:00:00Z') });
      mockedGet.mockResolvedValue(matchesResponse());
      const service = new PromotionsService(memoryCache() as unknown as Cache);

      const tokyo = await service.getStoreBanner({
        id: 4,
        time_zone: 'Asia/Tokyo',
      });
      expect(tokyo).toMatchObject({
        type: 'football',
        message: 'A x B às 09:30',
      });
    });
  });
});
