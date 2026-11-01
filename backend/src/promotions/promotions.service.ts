import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import axios from 'axios';

/** Fuso do banner global (rotas antigas) e reserva quando o fuso da loja é inválido. */
export const BANNER_TIME_ZONE = 'America/Sao_Paulo';

export interface BannerMatchDetails {
  home: string;
  away: string;
  tournament: string;
  time: string;
}

/**
 * Banner da página inicial (web e app).
 * Sem cupom: o checkout ainda não aplica cupons nem descontos, então o banner não pode prometê-los.
 */
export interface Banner {
  type: 'football' | 'promo';
  title: string;
  message: string;
  subtitle?: string;
  theme?: string;
  details?: BannerMatchDetails;
}

/** O que o banner precisa da loja: id (chave do cache) e fuso (o "hoje" da loja). */
export interface BannerStore {
  id: number;
  time_zone?: string | null;
}

interface FootballMatch {
  utcDate: string;
  status?: string;
  homeTeam: { name: string; shortName?: string };
  awayTeam: { name: string; shortName?: string };
  competition: { name: string; code?: string };
}

/** Jogos guardados no cache da plataforma (uma busca serve todas as lojas). */
interface MatchesEntry {
  matches: FootballMatch[];
  /** A API falhou: lista vazia por pouco tempo, para tentar de novo em breve. */
  failed: boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Competições do plano gratuito da football-data.org, em ordem de prioridade (Brasileirão primeiro). */
const COMPETITIONS = [
  'BSA',
  'CL',
  'WC',
  'EC',
  'PL',
  'PD',
  'SA',
  'BL1',
  'FL1',
  'PPL',
  'DED',
  'ELC',
];

/** Partidas que ainda valem o banner (agendadas ou rolando). */
const ACTIVE_MATCH_STATUSES = new Set([
  'SCHEDULED',
  'TIMED',
  'IN_PLAY',
  'PAUSED',
  'LIVE',
]);

/** Fuso válido para o Intl; senão, o fuso padrão do banner. */
function validTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return BANNER_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return timeZone;
  } catch {
    return BANNER_TIME_ZONE;
  }
}

/** Data local (AAAA-MM-DD) no fuso informado. */
function localDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Soma dias a uma data AAAA-MM-DD. */
function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Dia da semana (0 = domingo) de uma data AAAA-MM-DD. */
function weekdayOf(isoDate: string): number {
  return new Date(`${isoDate}T12:00:00Z`).getUTCDay();
}

// --- SUGESTÕES DA SEMANA (exibidas quando não há jogo) ---
// Texto neutro: nada de desconto, brinde, frete grátis ou cupom que o checkout não aplica.
const WEEKLY_PROMOTIONS: Record<number, Banner> = {
  0: {
    type: 'promo',
    theme: 'orange',
    title: 'Domingo em família 👨‍👩‍👧‍👦',
    message: 'Sugestão do dia: monte um pedido para dividir com todo mundo.',
  },
  1: {
    type: 'promo',
    theme: 'yellow',
    title: 'Começo de semana 🍔',
    message: 'Sugestão do dia: experimente um dos destaques do cardápio.',
  },
  2: {
    type: 'promo',
    theme: 'red',
    title: 'Terça de petiscos 🍟',
    message: 'Sugestão do dia: acompanhe o seu lanche com uma porção.',
  },
  3: {
    type: 'promo',
    theme: 'green',
    title: 'Quarta sem sair de casa 🛵',
    message:
      'Sugestão do dia: peça pelo site ou pelo app e acompanhe cada etapa.',
  },
  4: {
    type: 'promo',
    theme: 'purple',
    title: 'Quinta refrescante 🥤',
    message: 'Sugestão do dia: inclua uma bebida gelada no pedido.',
  },
  5: {
    type: 'promo',
    theme: 'blue',
    title: 'Sextou! 🎉',
    message: 'Sugestão do dia: capriche nos adicionais do seu lanche favorito.',
  },
  6: {
    type: 'promo',
    theme: 'red',
    title: 'Sabadou com a gente 🔥',
    message: 'Sugestão do dia: termine o pedido com uma sobremesa.',
  },
};

@Injectable()
export class PromotionsService {
  private readonly logger = new Logger(PromotionsService.name);
  private readonly API_URL = 'https://api.football-data.org/v4/matches';
  /** Busca de jogos em andamento (várias lojas pedindo ao mesmo tempo fazem UMA chamada à API). */
  private readonly pendingMatches = new Map<string, Promise<MatchesEntry>>();

  constructor(@Inject(CACHE_MANAGER) private readonly cacheManager: Cache) {}

  /**
   * Banner global das rotas antigas (/promotions/banner e /promotions/football): "hoje" no fuso de
   * Brasília. Nunca lança erro: qualquer falha cai na sugestão do dia.
   */
  getBanner(): Promise<Banner> {
    return this.bannerFor('home_banner', BANNER_TIME_ZONE);
  }

  /**
   * Banner da vitrine de uma loja (/stores/:storeSlug/promotions/banner): "hoje" e horário do jogo
   * no fuso da loja (stores.time_zone), em cache por loja e por dia. Os jogos vêm do cache da
   * plataforma (uma busca por dia serve todas as lojas).
   */
  getStoreBanner(store: BannerStore): Promise<Banner> {
    return this.bannerFor(
      `home_banner:store:${store.id}`,
      validTimeZone(store.time_zone),
    );
  }

  private async bannerFor(
    keyPrefix: string,
    timeZone: string,
  ): Promise<Banner> {
    const today = this.today(timeZone);
    const cacheKey = `${keyPrefix}:${today}`; // chave por dia: virou o dia, muda o banner

    try {
      const cached = await this.cacheManager.get<Banner>(cacheKey);
      if (cached) return cached;

      const { banner, ttl } = await this.resolveBanner(today, timeZone);
      await this.cacheManager.set(cacheKey, banner, ttl);
      return banner;
    } catch (error) {
      this.logger.warn(
        `Falha ao montar o banner (${(error as Error).message}). Exibindo a sugestão do dia.`,
      );
      return this.getDailyPromotion(today);
    }
  }

  private async resolveBanner(
    today: string,
    timeZone: string,
  ): Promise<{ banner: Banner; ttl: number }> {
    const token = process.env.FOOTBALL_DATA_TOKEN?.trim();
    if (!token) {
      // Sem token: só a sugestão do dia (o banner de futebol é opcional)
      return { banner: this.getDailyPromotion(today), ttl: 12 * HOUR };
    }

    const { matches, failed } = await this.platformMatches(token);
    const match = this.todayMatch(matches, today, timeZone);
    if (match) {
      return { banner: this.footballBanner(match, timeZone), ttl: HOUR };
    }
    // API fora do ar: tenta de novo em breve; sem jogo nenhum na janela: a lista não muda tão cedo
    const ttl = failed ? 15 * MINUTE : matches.length ? HOUR : 6 * HOUR;
    return { banner: this.getDailyPromotion(today), ttl };
  }

  /**
   * Jogos da janela ontem–amanhã (datas UTC), que cobre o "hoje" de qualquer fuso. Buscados uma vez
   * para toda a plataforma (chave por dia UTC) e filtrados por cada loja no próprio fuso.
   */
  private async platformMatches(token: string): Promise<MatchesEntry> {
    const utcToday = new Date().toISOString().slice(0, 10);
    const cacheKey = `football_matches:${utcToday}`;

    const cached = await this.cacheManager.get<MatchesEntry>(cacheKey);
    if (cached) return cached;

    const pending = this.pendingMatches.get(cacheKey);
    if (pending) return pending;

    const request = this.fetchMatches(token, utcToday)
      .then((matches): MatchesEntry => ({ matches, failed: false }))
      .catch((error: Error): MatchesEntry => {
        this.logger.warn(
          `API de futebol indisponível (${error.message}). Exibindo a sugestão do dia.`,
        );
        return { matches: [], failed: true };
      })
      .then(async (entry) => {
        const ttl = entry.failed
          ? 15 * MINUTE
          : entry.matches.length
            ? HOUR
            : 6 * HOUR;
        await this.cacheManager.set(cacheKey, entry, ttl);
        return entry;
      })
      .finally(() => this.pendingMatches.delete(cacheKey));
    this.pendingMatches.set(cacheKey, request);
    return request;
  }

  private async fetchMatches(
    token: string,
    utcToday: string,
  ): Promise<FootballMatch[]> {
    // A API filtra por data UTC
    const response = await axios.get<{ matches?: FootballMatch[] }>(
      this.API_URL,
      {
        headers: { 'X-Auth-Token': token },
        params: {
          dateFrom: addDays(utcToday, -1),
          dateTo: addDays(utcToday, 1),
          competitions: COMPETITIONS.join(','),
        },
        timeout: 5000, // timeout curto para não travar a página inicial
      },
    );

    // O cache guarda só o que o banner usa (e só partidas completas)
    return (response.data.matches ?? [])
      .filter(
        (match) =>
          typeof match?.utcDate === 'string' &&
          !!match.homeTeam?.name &&
          !!match.awayTeam?.name &&
          !!match.competition?.name,
      )
      .map((match) => ({
        utcDate: match.utcDate,
        status: match.status,
        homeTeam: {
          name: match.homeTeam.name,
          shortName: match.homeTeam.shortName,
        },
        awayTeam: {
          name: match.awayTeam.name,
          shortName: match.awayTeam.shortName,
        },
        competition: {
          name: match.competition.name,
          code: match.competition.code,
        },
      }));
  }

  /** Jogo de hoje (no fuso da loja) ainda não encerrado, priorizando o Brasileirão. */
  private todayMatch(
    matches: FootballMatch[],
    today: string,
    timeZone: string,
  ): FootballMatch | undefined {
    const priority = (match: FootballMatch) => {
      const index = COMPETITIONS.indexOf(match.competition?.code ?? '');
      return index === -1 ? COMPETITIONS.length : index;
    };

    return matches
      .filter(
        (match) =>
          localDate(new Date(match.utcDate), timeZone) === today &&
          (!match.status || ACTIVE_MATCH_STATUSES.has(match.status)),
      )
      .sort(
        (a, b) =>
          priority(a) - priority(b) ||
          new Date(a.utcDate).getTime() - new Date(b.utcDate).getTime(),
      )[0];
  }

  private footballBanner(match: FootballMatch, timeZone: string): Banner {
    const time = new Date(match.utcDate).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone,
    });
    const home = match.homeTeam.shortName || match.homeTeam.name;
    const away = match.awayTeam.shortName || match.awayTeam.name;

    return {
      type: 'football',
      theme: 'green',
      title: 'Hoje tem jogo! ⚽',
      message: `${home} x ${away} às ${time}`,
      subtitle: `${match.competition.name}: garanta seu pedido antes do apito inicial. 🍔`,
      details: {
        home: match.homeTeam.name,
        away: match.awayTeam.name,
        tournament: match.competition.name,
        time,
      },
    };
  }

  /** Data de hoje no fuso informado (AAAA-MM-DD); se o fuso falhar, usa a data UTC. */
  private today(timeZone: string): string {
    try {
      return localDate(new Date(), timeZone);
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  }

  /** Sugestão fixa do dia da semana. */
  private getDailyPromotion(today: string): Banner {
    const promo = WEEKLY_PROMOTIONS[weekdayOf(today)] ?? WEEKLY_PROMOTIONS[0];
    return { ...promo };
  }
}
