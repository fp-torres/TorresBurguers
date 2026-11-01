import { Injectable, Logger } from '@nestjs/common';
import { BRAND } from '../config/brand';
import { cepDigits } from './cep-lookup.service';
import {
  geocodeCacheKey,
  geocodingUserAgent,
  googleAddressText,
  nominatimParams,
  parseFakeGeoMap,
  parseGeoProviders,
  readAwesomeApi,
  readGoogleGeocode,
  readNominatim,
  readRoutesDistanceMeters,
  type GeoProvider,
  type GeocodeOutcome,
  type GeocodeQuery,
} from './geocoding';

/**
 * Para que a localização serve (cada uso tem um prazo TOTAL para a cadeia de provedores):
 * - quote: orçamento, pedido e cobranças por distância (o mais curto: nunca trava o pedido);
 * - save: cadastro e edição do endereço do cliente;
 * - panel: painel da loja (localizar a loja e simular uma entrega).
 */
export type GeocodePurpose = 'quote' | 'save' | 'panel';

export const GEOCODE_BUDGET_MS: Record<GeocodePurpose, number> = {
  quote: 4000,
  save: 5000,
  panel: 8000,
};
/** Prazo de cada provedor (limitado ao que sobra do prazo total). */
export const GEOCODE_PROVIDER_TIMEOUT_MS = 2500;
/** Abaixo disto, não vale começar outro provedor. */
const MIN_PROVIDER_WINDOW_MS = 300;
/** Um provedor que falhou (rede, prazo, cota, HTTP inesperado) fica de fora por este tempo. */
export const GEOCODE_SERVICE_COOLDOWN_MS = 60_000;
/** Política do Nominatim: no máximo 1 requisição por segundo (com folga). */
export const NOMINATIM_INTERVAL_MS = 1100;
/** Fila do Nominatim mais longa que isto: pula o provedor nesta consulta (o próximo da cadeia responde). */
export const NOMINATIM_MAX_WAIT_MS = 1500;
/** Cache em memória por instância: encontrado 24 h; não encontrado 1 h. */
export const GEOCODE_FOUND_TTL_MS = 24 * 60 * 60 * 1000;
export const GEOCODE_NOT_FOUND_TTL_MS = 60 * 60 * 1000;
/** Distância por rua (Google Routes): prazo curto e cache de 7 dias por par de coordenadas arredondadas. */
export const ROUTE_TIMEOUT_MS = 2000;
export const ROUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 5000;
const DEFAULT_NOMINATIM_URL = 'https://nominatim.openstreetmap.org';

/**
 * Modo de operação:
 * - network: produção e desenvolvimento (a cadeia de GEOCODING_PROVIDERS);
 * - offline: NODE_ENV=test sem GEOCODING_FAKE (nunca vai à internet: todo endereço fica "fora do ar");
 * - fake: NODE_ENV=test com GEOCODING_FAKE (um mapa de CEPs → coordenadas).
 */
type GeocodingMode =
  | {
      kind: 'network';
      providers: GeoProvider[];
      googleKey: string | null;
      userAgent: string;
      nominatimUrl: string;
    }
  | { kind: 'offline' }
  | { kind: 'fake'; entries: Map<string, GeocodeOutcome> };

interface JsonResponse {
  status: number;
  data: unknown;
}

type ServiceName = GeoProvider | 'routes';

/** Resultado de um provedor: "skipped" = não se aplica agora (sem rua, fila cheia) e não conta como falha. */
type ProviderResult = GeocodeOutcome | { status: 'skipped' };

/**
 * Coordenadas de endereços para a entrega por distância: cadeia de provedores com prazo total por uso, cache em
 * memória (encontrado 24 h, não encontrado 1 h), consultas simultâneas do mesmo endereço compartilhadas, provedor
 * que falhou fora por 60 s e o Nominatim limitado a 1 requisição por segundo. Nunca lança.
 * Também mede a distância por rua (Google Routes, só com GOOGLE_MAPS_API_KEY), com queda para null.
 *
 * Testes determinísticos: SÓ em NODE_ENV=test, GEOCODING_FAKE com um mapa de CEPs substitui os provedores.
 */
@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);
  private readonly mode: GeocodingMode;
  private readonly cache = new Map<
    string,
    { outcome: GeocodeOutcome; expiresAt: number }
  >();
  private readonly inflight = new Map<string, Promise<GeocodeOutcome>>();
  private readonly routeCache = new Map<
    string,
    { km: number; expiresAt: number }
  >();
  private readonly downUntil: Record<ServiceName, number> = {
    google: 0,
    nominatim: 0,
    awesomeapi: 0,
    routes: 0,
  };
  private nominatimNextAt = 0;

  constructor() {
    this.mode = this.readMode(process.env);
  }

  private readMode(env: NodeJS.ProcessEnv): GeocodingMode {
    const fake = env.GEOCODING_FAKE?.trim();
    if (env.NODE_ENV === 'test') {
      if (!fake) return { kind: 'offline' };
      try {
        return { kind: 'fake', entries: parseFakeGeoMap(fake) };
      } catch (error) {
        this.logger.error(
          `GEOCODING_FAKE inválido (${(error as Error).message}). Nenhum endereço será localizado.`,
        );
        return { kind: 'fake', entries: new Map() };
      }
    }
    if (fake)
      this.logger.warn(
        'GEOCODING_FAKE foi ignorado: o modo de localização falso só vale com NODE_ENV=test.',
      );
    const { providers, ignored } = parseGeoProviders(env.GEOCODING_PROVIDERS);
    const unknown = ignored.filter((item) => item !== 'none');
    if (unknown.length)
      this.logger.warn(
        `GEOCODING_PROVIDERS: ignorados ${unknown.join(', ')} (use google, nominatim e/ou awesomeapi).`,
      );
    const googleKey = env.GOOGLE_MAPS_API_KEY?.trim() || null;
    const contact = env.GEOCODING_CONTACT?.trim() || null;
    if (providers.includes('nominatim') && !contact)
      this.logger.warn(
        'GEOCODING_CONTACT não definido: a política do Nominatim pede um contato (e-mail ou site) no User-Agent.',
      );
    return {
      kind: 'network',
      providers,
      googleKey,
      userAgent: geocodingUserAgent(BRAND.slug, contact),
      nominatimUrl: (
        env.GEOCODING_NOMINATIM_URL?.trim() || DEFAULT_NOMINATIM_URL
      ).replace(/\/+$/, ''),
    };
  }

  /** Modo falso ativo (NODE_ENV=test + GEOCODING_FAKE). */
  get fake(): boolean {
    return this.mode.kind === 'fake';
  }

  /** A distância real por rua está disponível (GOOGLE_MAPS_API_KEY, fora dos testes). */
  get roadDistanceAvailable(): boolean {
    return this.mode.kind === 'network' && !!this.mode.googleKey;
  }

  /** Coordenadas do endereço pela cadeia de provedores. Nunca lança; CEP inválido = não encontrado. */
  async geocode(
    query: GeocodeQuery,
    purpose: GeocodePurpose,
  ): Promise<GeocodeOutcome> {
    const digits = cepDigits(query.zipCode);
    if (!digits) return { status: 'not_found' };
    if (this.mode.kind === 'fake')
      return this.mode.entries.get(digits) ?? { status: 'not_found' };
    if (this.mode.kind === 'offline') return { status: 'unavailable' };

    const key = geocodeCacheKey(query);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.outcome;
    if (cached) this.cache.delete(key);

    const running = this.inflight.get(key);
    if (running) return running;
    const task = this.runChain(query, key, GEOCODE_BUDGET_MS[purpose]).finally(
      () => this.inflight.delete(key),
    );
    this.inflight.set(key, task);
    return task;
  }

  private async runChain(
    query: GeocodeQuery,
    key: string,
    budgetMs: number,
  ): Promise<GeocodeOutcome> {
    if (this.mode.kind !== 'network') return { status: 'unavailable' };
    const deadline = this.now() + budgetMs;
    let unavailable = false;
    for (const provider of this.mode.providers) {
      if (provider === 'google' && !this.mode.googleKey) continue;
      if (!this.available(provider)) {
        unavailable = true;
        continue;
      }
      const remaining = deadline - this.now();
      if (remaining < MIN_PROVIDER_WINDOW_MS) {
        unavailable = true;
        break;
      }
      const result = await this.callProvider(
        provider,
        query,
        Math.min(GEOCODE_PROVIDER_TIMEOUT_MS, remaining),
      );
      if (result.status === 'found') return this.remember(key, result);
      if (result.status === 'unavailable') unavailable = true;
    }
    if (unavailable) return { status: 'unavailable' };
    return this.remember(key, { status: 'not_found' });
  }

  private async callProvider(
    provider: GeoProvider,
    query: GeocodeQuery,
    timeoutMs: number,
  ): Promise<ProviderResult> {
    if (this.mode.kind !== 'network') return { status: 'unavailable' };
    try {
      if (provider === 'google') {
        const params = new URLSearchParams({
          address: googleAddressText(query),
          components: 'country:BR',
          region: 'br',
          language: 'pt-BR',
          key: this.mode.googleKey ?? '',
        });
        const { status, data } = await this.fetchJson(
          `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`,
          {},
          timeoutMs,
        );
        if (status !== 200) return this.failed(provider, `HTTP ${status}`);
        const outcome = readGoogleGeocode(data);
        if (outcome.status === 'unavailable')
          return this.failed(
            provider,
            `status ${String((data as { status?: unknown } | null)?.status)}`,
          );
        return outcome;
      }

      if (provider === 'nominatim') {
        const params = nominatimParams(query);
        if (!params) return { status: 'skipped' };
        const waitMs = this.reserveNominatimSlot(
          Math.min(NOMINATIM_MAX_WAIT_MS, timeoutMs - MIN_PROVIDER_WINDOW_MS),
        );
        if (waitMs === null) return { status: 'skipped' };
        if (waitMs > 0) await this.wait(waitMs);
        const { status, data } = await this.fetchJson(
          `${this.mode.nominatimUrl}/search?${params.toString()}`,
          { 'Accept-Language': 'pt-BR' },
          timeoutMs - waitMs,
        );
        if (status !== 200) return this.failed(provider, `HTTP ${status}`);
        const outcome = readNominatim(data);
        return outcome.status === 'unavailable'
          ? this.failed(provider, 'resposta inesperada')
          : outcome;
      }

      const digits = cepDigits(query.zipCode) as string;
      const { status, data } = await this.fetchJson(
        `https://cep.awesomeapi.com.br/json/${digits}`,
        {},
        timeoutMs,
      );
      const outcome = readAwesomeApi(status, data);
      return outcome.status === 'unavailable'
        ? this.failed(provider, `HTTP ${status}`)
        : outcome;
    } catch (error) {
      return this.failed(provider, (error as Error).message);
    }
  }

  /**
   * Reserva a próxima vaga do Nominatim (1 por NOMINATIM_INTERVAL_MS): devolve quanto esperar, ou null quando a
   * fila passaria de maxWaitMs (a consulta pula o Nominatim, sem reservar, e segue a cadeia).
   */
  private reserveNominatimSlot(maxWaitMs: number): number | null {
    const now = this.now();
    const start = Math.max(now, this.nominatimNextAt);
    const waitMs = start - now;
    if (waitMs > maxWaitMs) return null;
    this.nominatimNextAt = start + NOMINATIM_INTERVAL_MS;
    return waitMs;
  }

  /**
   * Distância por rua em km (1 casa) pelo Google Routes, com cache por par de coordenadas arredondadas (4 casas,
   * ~11 m). null quando não há chave, nos testes, sem rota ou com falha (quem chama usa a linha reta).
   */
  async roadDistanceKm(
    from: { lat: number; lng: number },
    to: { lat: number; lng: number },
  ): Promise<number | null> {
    if (this.mode.kind !== 'network' || !this.mode.googleKey) return null;
    const round = (value: number) => value.toFixed(4);
    const key = `${round(from.lat)},${round(from.lng)}>${round(to.lat)},${round(to.lng)}`;
    const cached = this.routeCache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.km;
    if (cached) this.routeCache.delete(key);
    if (!this.available('routes')) return null;

    const point = (value: { lat: number; lng: number }) => ({
      location: { latLng: { latitude: value.lat, longitude: value.lng } },
    });
    try {
      const { status, data } = await this.fetchJson(
        'https://routes.googleapis.com/directions/v2:computeRoutes',
        {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': this.mode.googleKey,
          'X-Goog-FieldMask': 'routes.distanceMeters',
        },
        ROUTE_TIMEOUT_MS,
        JSON.stringify({
          origin: point(from),
          destination: point(to),
          travelMode: 'DRIVE',
          routingPreference: 'TRAFFIC_UNAWARE',
        }),
      );
      if (status !== 200) {
        this.markDown('routes', `Google Routes respondeu HTTP ${status}.`);
        return null;
      }
      const meters = readRoutesDistanceMeters(data);
      if (meters === null) return null;
      const km = Math.round(meters / 100) / 10;
      this.store(this.routeCache, key, {
        km,
        expiresAt: this.now() + ROUTE_TTL_MS,
      });
      return km;
    } catch (error) {
      this.markDown(
        'routes',
        `Google Routes indisponível: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private failed(provider: GeoProvider, reason: string): GeocodeOutcome {
    this.markDown(
      provider,
      `Localização (${provider}) indisponível: ${reason}.`,
    );
    return { status: 'unavailable' };
  }

  private available(service: ServiceName): boolean {
    return this.downUntil[service] <= this.now();
  }

  private markDown(service: ServiceName, reason: string): void {
    this.downUntil[service] = this.now() + GEOCODE_SERVICE_COOLDOWN_MS;
    this.logger.warn(reason);
  }

  private remember(key: string, outcome: GeocodeOutcome): GeocodeOutcome {
    if (outcome.status === 'unavailable') return outcome;
    this.store(this.cache, key, {
      outcome,
      expiresAt:
        this.now() +
        (outcome.status === 'found'
          ? GEOCODE_FOUND_TTL_MS
          : GEOCODE_NOT_FOUND_TTL_MS),
    });
    return outcome;
  }

  private store<T>(cache: Map<string, T>, key: string, value: T): void {
    if (cache.size >= CACHE_MAX_ENTRIES) {
      // Map guarda a ordem de inserção: sai o mais antigo
      for (const oldest of cache.keys()) {
        cache.delete(oldest);
        break;
      }
    }
    cache.set(key, value);
  }

  // Pontos de extensão para os testes (relógio, espera e rede)

  protected now(): number {
    return Date.now();
  }

  protected wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  protected async fetchJson(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number,
    body?: string,
  ): Promise<JsonResponse> {
    if (this.mode.kind !== 'network') return { status: 0, data: null };
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Accept: 'application/json',
        'User-Agent': this.mode.userAgent,
        ...headers,
      },
      body,
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
    let data: unknown = null;
    try {
      data = (await response.json()) as unknown;
    } catch {
      data = null;
    }
    return { status: response.status, data };
  }
}
