import { Logger } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { Store } from '../store/entities/store.entity';
import { AddressGeoService } from './address-geo.service';
import type { Address } from './entities/address.entity';
import {
  EMPTY_GEO_FIELDS,
  GEO_RETRY_MS,
  geoFieldsFromOutcome,
  geocodeCacheKey,
  geocodingUserAgent,
  googleAddressText,
  needsGeoRefresh,
  nominatimParams,
  parseFakeGeoMap,
  parseGeoProviders,
  readAwesomeApi,
  readGoogleGeocode,
  readNominatim,
  readRoutesDistanceMeters,
  type GeocodeQuery,
} from './geocoding';
import {
  GEOCODE_BUDGET_MS,
  GEOCODE_SERVICE_COOLDOWN_MS,
  GeocodingService,
  NOMINATIM_INTERVAL_MS,
} from './geocoding.service';

const QUERY: GeocodeQuery = {
  zipCode: '01310-100',
  street: 'Avenida Paulista',
  number: '1000',
  neighborhood: 'Bela Vista',
  city: 'São Paulo',
  state: 'SP',
};

describe('geocoding: funções puras', () => {
  it('provedores: lista na ordem, sem repetir; desconhecidos ignorados; vazio = padrão', () => {
    expect(parseGeoProviders(undefined).providers).toEqual([
      'google',
      'nominatim',
      'awesomeapi',
    ]);
    expect(parseGeoProviders(' AwesomeAPI , nominatim,awesomeapi ')).toEqual({
      providers: ['awesomeapi', 'nominatim'],
      ignored: [],
    });
    expect(parseGeoProviders('none')).toEqual({
      providers: [],
      ignored: ['none'],
    });
    expect(parseGeoProviders('mapbox,google').ignored).toEqual(['mapbox']);
  });

  it('User-Agent identificado (política do Nominatim), com contato quando configurado', () => {
    expect(geocodingUserAgent('comestra', 'contato@loja.com')).toBe(
      'comestra-delivery-geocoder/1.0 (contato@loja.com)',
    );
    expect(geocodingUserAgent('comestra', '')).toBe(
      'comestra-delivery-geocoder/1.0',
    );
    // Sem quebras de linha nem parênteses vindos da variável
    expect(geocodingUserAgent('comestra', 'a)\r\nb')).toBe(
      'comestra-delivery-geocoder/1.0 (a   b)',
    );
  });

  it('textos de busca: Google com o endereço completo; Nominatim estruturado (sem o CEP; "S/N" não entra)', () => {
    expect(googleAddressText(QUERY)).toBe(
      'Avenida Paulista, 1000 - Bela Vista, São Paulo - SP, 01310-100, Brasil',
    );
    const params = nominatimParams({ ...QUERY, number: 'S/N' });
    expect(params?.get('street')).toBe('Avenida Paulista');
    expect(params?.get('city')).toBe('São Paulo');
    expect(params?.get('state')).toBe('SP');
    expect(params?.get('format')).toBe('jsonv2');
    expect(params?.has('postalcode')).toBe(false);
    expect(nominatimParams({ zipCode: '01310100' })).toBeNull();
    expect(nominatimParams(QUERY)?.get('street')).toBe('1000 Avenida Paulista');
  });

  it('chave do cache ignora acentos, maiúsculas, espaços e a máscara do CEP', () => {
    expect(
      geocodeCacheKey({ ...QUERY, city: 'SAO  PAULO', zipCode: '01310100' }),
    ).toBe(geocodeCacheKey(QUERY));
    expect(geocodeCacheKey({ ...QUERY, number: '1001' })).not.toBe(
      geocodeCacheKey(QUERY),
    );
  });

  it('Google: rua/endereço → ADDRESS; só o CEP → ZIP_CENTER; vago ou sem resultado → não encontrado; cota → fora do ar', () => {
    const result = (location_type: string, types: string[]) => ({
      status: 'OK',
      results: [
        {
          geometry: { location: { lat: -23.56, lng: -46.65 }, location_type },
          types,
        },
      ],
    });
    expect(readGoogleGeocode(result('ROOFTOP', ['street_address']))).toEqual({
      status: 'found',
      lat: -23.56,
      lng: -46.65,
      precision: 'ADDRESS',
      source: 'GOOGLE',
    });
    expect(
      readGoogleGeocode(result('GEOMETRIC_CENTER', ['route'])),
    ).toMatchObject({
      precision: 'ADDRESS',
    });
    expect(
      readGoogleGeocode(result('APPROXIMATE', ['postal_code'])),
    ).toMatchObject({
      precision: 'ZIP_CENTER',
    });
    expect(readGoogleGeocode(result('APPROXIMATE', ['locality']))).toEqual({
      status: 'not_found',
    });
    expect(readGoogleGeocode({ status: 'ZERO_RESULTS', results: [] })).toEqual({
      status: 'not_found',
    });
    expect(readGoogleGeocode({ status: 'OVER_QUERY_LIMIT' })).toEqual({
      status: 'unavailable',
    });
    expect(readGoogleGeocode(null)).toEqual({ status: 'unavailable' });
  });

  it('Nominatim: só resultados no nível da rua ou mais precisos (place_rank ≥ 26)', () => {
    expect(
      readNominatim([{ lat: '-23.5617', lon: '-46.656', place_rank: 30 }]),
    ).toEqual({
      status: 'found',
      lat: -23.5617,
      lng: -46.656,
      precision: 'ADDRESS',
      source: 'NOMINATIM',
    });
    expect(
      readNominatim([{ lat: '-23.5', lon: '-46.6', place_rank: 16 }]),
    ).toEqual({
      status: 'not_found',
    });
    expect(readNominatim([])).toEqual({ status: 'not_found' });
    expect(readNominatim({ error: 'x' })).toEqual({ status: 'unavailable' });
  });

  it('AwesomeAPI: centro do CEP; 404/400 ou sem coordenadas → não encontrado; outro HTTP → fora do ar', () => {
    expect(readAwesomeApi(200, { lat: '-23.56', lng: '-46.65' })).toEqual({
      status: 'found',
      lat: -23.56,
      lng: -46.65,
      precision: 'ZIP_CENTER',
      source: 'AWESOMEAPI',
    });
    expect(readAwesomeApi(200, { lat: '', lng: '' })).toEqual({
      status: 'not_found',
    });
    expect(readAwesomeApi(404, {})).toEqual({ status: 'not_found' });
    expect(readAwesomeApi(429, {})).toEqual({ status: 'unavailable' });
  });

  it('Google Routes: metros da primeira rota; sem rota → null', () => {
    expect(
      readRoutesDistanceMeters({ routes: [{ distanceMeters: 4210 }] }),
    ).toBe(4210);
    expect(readRoutesDistanceMeters({})).toBeNull();
    expect(readRoutesDistanceMeters({ routes: [{}] })).toBeNull();
  });

  it('mapa falso: coordenadas, precisão, "unavailable" e null; inválido → erro', () => {
    const map = parseFakeGeoMap(
      JSON.stringify({
        '01310-100': { lat: -23.56, lng: -46.65 },
        '01310200': { lat: -23.57, lng: -46.66, precision: 'ZIP_CENTER' },
        '01310300': 'unavailable',
        '01310400': null,
      }),
    );
    expect(map.get('01310100')).toEqual({
      status: 'found',
      lat: -23.56,
      lng: -46.65,
      precision: 'ADDRESS',
      source: 'FAKE',
    });
    expect(map.get('01310200')).toMatchObject({ precision: 'ZIP_CENTER' });
    expect(map.get('01310300')).toEqual({ status: 'unavailable' });
    expect(map.get('01310400')).toEqual({ status: 'not_found' });
    expect(() => parseFakeGeoMap('{')).toThrow('não é um JSON válido');
    expect(() => parseFakeGeoMap('{"123": {"lat": 1, "lng": 1}}')).toThrow(
      'não é um CEP',
    );
    expect(() =>
      parseFakeGeoMap('{"01310100": {"lat": 100, "lng": 1}}'),
    ).toThrow('"lat", "lng" } válidos');
  });

  it('campos geo_* a gravar e quando localizar de novo (nunca localizado ou fora do ar há 1 h)', () => {
    const at = new Date('2026-11-01T12:00:00Z');
    expect(
      geoFieldsFromOutcome(
        {
          status: 'found',
          lat: 1,
          lng: 2,
          precision: 'ADDRESS',
          source: 'GOOGLE',
        },
        at,
      ),
    ).toEqual({
      geo_latitude: 1,
      geo_longitude: 2,
      geo_precision: 'ADDRESS',
      geo_source: 'GOOGLE',
      geo_status: 'FOUND',
      geo_checked_at: at,
    });
    expect(geoFieldsFromOutcome({ status: 'unavailable' }, at)).toEqual({
      ...EMPTY_GEO_FIELDS,
      geo_status: 'UNAVAILABLE',
      geo_checked_at: at,
    });
    expect(needsGeoRefresh({ geo_status: null }, at)).toBe(true);
    expect(needsGeoRefresh({ geo_status: 'FOUND' }, at)).toBe(false);
    expect(needsGeoRefresh({ geo_status: 'NOT_FOUND' }, at)).toBe(false);
    const recent = new Date(at.getTime() - GEO_RETRY_MS + 1000);
    const old = new Date(at.getTime() - GEO_RETRY_MS);
    expect(
      needsGeoRefresh(
        { geo_status: 'UNAVAILABLE', geo_checked_at: recent },
        at,
      ),
    ).toBe(false);
    expect(
      needsGeoRefresh({ geo_status: 'UNAVAILABLE', geo_checked_at: old }, at),
    ).toBe(true);
    expect(
      needsGeoRefresh(
        { geo_status: 'UNAVAILABLE', geo_checked_at: old.toISOString() },
        at,
      ),
    ).toBe(true);
  });
});

type Reply = { status: number; data: unknown } | Error;

/** Serviço com relógio, espera e rede controlados pelo teste. */
class TestGeocoder extends GeocodingService {
  clock = 1_000_000;
  waits: number[] = [];
  calls: {
    url: string;
    headers: Record<string, string>;
    timeoutMs: number;
    body?: string;
  }[] = [];
  replies: Reply[] = [];
  /** Respostas por servidor (consultas simultâneas, em que a ordem das chamadas não é fixa). */
  hostReplies: Record<string, Reply[]> = {};
  /** Cada chamada consome todo o prazo recebido (serviço lento). */
  slow = false;

  protected now(): number {
    return this.clock;
  }

  /** A espera não avança o relógio: as consultas simultâneas disputam a fila no mesmo instante. */
  protected wait(ms: number): Promise<void> {
    this.waits.push(ms);
    return Promise.resolve();
  }

  protected fetchJson(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number,
    body?: string,
  ): Promise<{ status: number; data: unknown }> {
    this.calls.push({ url, headers, timeoutMs, body });
    if (this.slow) this.clock += timeoutMs;
    const reply =
      this.hostReplies[new URL(url).host]?.shift() ?? this.replies.shift();
    if (!reply) return Promise.reject(new Error('sem resposta configurada'));
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(reply);
  }

  hosts(): string[] {
    return this.calls.map((call) => new URL(call.url).host);
  }
}

const NOMINATIM_FOUND = {
  status: 200,
  data: [{ lat: '-23.5617', lon: '-46.656', place_rank: 30 }],
};
const AWESOME_FOUND = { status: 200, data: { lat: '-23.56', lng: '-46.65' } };

describe('GeocodingService (cadeia de provedores)', () => {
  const originalEnv = { ...process.env };

  function network(env: Record<string, string> = {}): TestGeocoder {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'development',
      GEOCODING_CONTACT: 'suporte@comestra.test',
      ...env,
    };
    if (!('GEOCODING_FAKE' in env)) delete process.env.GEOCODING_FAKE;
    if (!('GOOGLE_MAPS_API_KEY' in env)) delete process.env.GOOGLE_MAPS_API_KEY;
    if (!('GEOCODING_PROVIDERS' in env)) delete process.env.GEOCODING_PROVIDERS;
    return new TestGeocoder();
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('sem GOOGLE_MAPS_API_KEY o Google é pulado: Nominatim responde (User-Agent identificado)', async () => {
    const geocoder = network();
    geocoder.replies.push(NOMINATIM_FOUND);
    await expect(geocoder.geocode(QUERY, 'save')).resolves.toMatchObject({
      status: 'found',
      source: 'NOMINATIM',
      precision: 'ADDRESS',
    });
    expect(geocoder.hosts()).toEqual(['nominatim.openstreetmap.org']);
    expect(geocoder.calls[0].headers['Accept-Language']).toBe('pt-BR');
    expect(geocoder.roadDistanceAvailable).toBe(false);
  });

  it('com a chave, o Google vem primeiro (a chave vai só na URL do Google)', async () => {
    const geocoder = network({ GOOGLE_MAPS_API_KEY: 'chave-secreta' });
    geocoder.replies.push({
      status: 200,
      data: {
        status: 'OK',
        results: [
          {
            geometry: {
              location: { lat: -23.5, lng: -46.6 },
              location_type: 'ROOFTOP',
            },
            types: ['street_address'],
          },
        ],
      },
    });
    await expect(geocoder.geocode(QUERY, 'quote')).resolves.toMatchObject({
      source: 'GOOGLE',
    });
    expect(geocoder.calls).toHaveLength(1);
    expect(geocoder.calls[0].url).toContain('maps.googleapis.com');
    expect(geocoder.calls[0].url).toContain('key=chave-secreta');
    expect(geocoder.roadDistanceAvailable).toBe(true);
  });

  it('falhas em sequência: Google fora do ar → Nominatim sem resultado → centro do CEP (AwesomeAPI)', async () => {
    const geocoder = network({ GOOGLE_MAPS_API_KEY: 'k' });
    geocoder.replies.push(
      new Error('timeout'),
      { status: 200, data: [] },
      AWESOME_FOUND,
    );
    await expect(geocoder.geocode(QUERY, 'save')).resolves.toEqual({
      status: 'found',
      lat: -23.56,
      lng: -46.65,
      precision: 'ZIP_CENTER',
      source: 'AWESOMEAPI',
    });
    expect(geocoder.hosts()).toEqual([
      'maps.googleapis.com',
      'nominatim.openstreetmap.org',
      'cep.awesomeapi.com.br',
    ]);
    expect(geocoder.calls[2].url).toContain('/json/01310100');
  });

  it('todos sem resultado → não encontrado (guardado no cache por 1 h); algum fora do ar → "fora do ar" (sem cache)', async () => {
    const geocoder = network({ GEOCODING_PROVIDERS: 'nominatim,awesomeapi' });
    geocoder.replies.push({ status: 200, data: [] }, { status: 404, data: {} });
    await expect(geocoder.geocode(QUERY, 'save')).resolves.toEqual({
      status: 'not_found',
    });
    await expect(geocoder.geocode(QUERY, 'save')).resolves.toEqual({
      status: 'not_found',
    });
    expect(geocoder.calls).toHaveLength(2);

    const other = { ...QUERY, number: '2000' };
    geocoder.clock += NOMINATIM_INTERVAL_MS;
    geocoder.replies.push(
      { status: 503, data: null },
      { status: 404, data: {} },
    );
    await expect(geocoder.geocode(other, 'save')).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it('cache: o mesmo endereço encontrado não consulta de novo por 24 h; consultas simultâneas compartilham a chamada', async () => {
    const geocoder = network({ GEOCODING_PROVIDERS: 'awesomeapi' });
    geocoder.replies.push(AWESOME_FOUND);
    const [first, second] = await Promise.all([
      geocoder.geocode(QUERY, 'quote'),
      geocoder.geocode({ ...QUERY, city: 'SAO PAULO' }, 'quote'),
    ]);
    expect(first).toEqual(second);
    await geocoder.geocode(QUERY, 'quote');
    expect(geocoder.calls).toHaveLength(1);

    geocoder.clock += 24 * 60 * 60 * 1000 + 1;
    geocoder.replies.push(AWESOME_FOUND);
    await geocoder.geocode(QUERY, 'quote');
    expect(geocoder.calls).toHaveLength(2);
  });

  it('provedor que falhou fica fora por 60 s (sem esperar o prazo de novo); depois volta', async () => {
    const geocoder = network({ GEOCODING_PROVIDERS: 'awesomeapi' });
    geocoder.replies.push(new Error('rede'));
    await expect(geocoder.geocode(QUERY, 'quote')).resolves.toEqual({
      status: 'unavailable',
    });
    await expect(
      geocoder.geocode({ ...QUERY, zipCode: '01310200' }, 'quote'),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(geocoder.calls).toHaveLength(1);

    geocoder.clock += GEOCODE_SERVICE_COOLDOWN_MS;
    geocoder.replies.push(AWESOME_FOUND);
    await expect(geocoder.geocode(QUERY, 'quote')).resolves.toMatchObject({
      status: 'found',
    });
  });

  it('Nominatim: no máximo 1 requisição por segundo; fila longa pula para o próximo provedor', async () => {
    const geocoder = network({ GEOCODING_PROVIDERS: 'nominatim,awesomeapi' });
    geocoder.replies.push(NOMINATIM_FOUND, NOMINATIM_FOUND);
    await geocoder.geocode(QUERY, 'save');
    await geocoder.geocode({ ...QUERY, number: '1001' }, 'save');
    // A segunda esperou a vaga (1,1 s depois da primeira)
    expect(geocoder.waits).toEqual([NOMINATIM_INTERVAL_MS]);

    // Três ao mesmo tempo: a terceira passaria do limite de espera → vai direto à AwesomeAPI
    geocoder.clock += 10_000;
    geocoder.waits = [];
    geocoder.hostReplies = {
      'nominatim.openstreetmap.org': [NOMINATIM_FOUND, NOMINATIM_FOUND],
      'cep.awesomeapi.com.br': [AWESOME_FOUND],
    };
    const results = await Promise.all(
      ['2001', '2002', '2003'].map((number) =>
        geocoder.geocode({ ...QUERY, number }, 'save'),
      ),
    );
    expect(
      results.map((result) => result.status === 'found' && result.source),
    ).toEqual(['NOMINATIM', 'NOMINATIM', 'AWESOMEAPI']);
    expect(geocoder.waits).toEqual([NOMINATIM_INTERVAL_MS]);
  });

  it('prazo total por uso: cada provedor recebe no máximo o que sobra (o orçamento nunca trava)', async () => {
    const geocoder = network({ GOOGLE_MAPS_API_KEY: 'k' });
    // Cada provedor demora todo o prazo dele e falha; a cadeia segue com o que sobrou
    geocoder.slow = true;
    geocoder.replies.push(new Error('timeout'), new Error('timeout'));
    await expect(geocoder.geocode(QUERY, 'quote')).resolves.toEqual({
      status: 'unavailable',
    });
    const used = geocoder.calls.reduce((sum, call) => sum + call.timeoutMs, 0);
    expect(used).toBeLessThanOrEqual(GEOCODE_BUDGET_MS.quote);
    expect(geocoder.calls.length).toBeLessThan(3);
  });

  it('CEP inválido: não encontrado, sem consultar nada', async () => {
    const geocoder = network();
    await expect(
      geocoder.geocode({ ...QUERY, zipCode: '123' }, 'save'),
    ).resolves.toEqual({ status: 'not_found' });
    expect(geocoder.calls).toHaveLength(0);
  });

  it('distância por rua: Google Routes com a chave no cabeçalho, cache por par arredondado; falha → null', async () => {
    const geocoder = network({ GOOGLE_MAPS_API_KEY: 'k' });
    const from = { lat: -23.5617, lng: -46.656 };
    const to = { lat: -23.5505, lng: -46.6333 };
    geocoder.replies.push({
      status: 200,
      data: { routes: [{ distanceMeters: 3462 }] },
    });
    await expect(geocoder.roadDistanceKm(from, to)).resolves.toBe(3.5);
    await expect(
      geocoder.roadDistanceKm(from, { lat: -23.55051, lng: -46.63331 }),
    ).resolves.toBe(3.5);
    expect(geocoder.calls).toHaveLength(1);
    expect(geocoder.calls[0].headers['X-Goog-Api-Key']).toBe('k');
    expect(geocoder.calls[0].headers['X-Goog-FieldMask']).toBe(
      'routes.distanceMeters',
    );
    expect(JSON.parse(geocoder.calls[0].body ?? '{}')).toMatchObject({
      travelMode: 'DRIVE',
      origin: {
        location: { latLng: { latitude: from.lat, longitude: from.lng } },
      },
    });

    geocoder.replies.push({ status: 403, data: {} });
    await expect(
      geocoder.roadDistanceKm(from, { lat: -23.6, lng: -46.7 }),
    ).resolves.toBeNull();
    // Fora por 60 s depois da falha
    await expect(
      geocoder.roadDistanceKm(from, { lat: -23.61, lng: -46.71 }),
    ).resolves.toBeNull();
    expect(geocoder.calls).toHaveLength(2);
  });

  it('sem a chave do Google, a distância por rua não é consultada', async () => {
    const geocoder = network();
    await expect(
      geocoder.roadDistanceKm({ lat: 1, lng: 1 }, { lat: 2, lng: 2 }),
    ).resolves.toBeNull();
    expect(geocoder.calls).toHaveLength(0);
  });

  it('NODE_ENV=test: com GEOCODING_FAKE usa só o mapa; sem ele, nunca vai à internet ("fora do ar")', async () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      GOOGLE_MAPS_API_KEY: 'k',
      GEOCODING_FAKE: JSON.stringify({
        '01310100': { lat: -23.56, lng: -46.65 },
      }),
    };
    const fake = new TestGeocoder();
    expect(fake.fake).toBe(true);
    await expect(fake.geocode(QUERY, 'quote')).resolves.toMatchObject({
      status: 'found',
      source: 'FAKE',
    });
    await expect(
      fake.geocode({ ...QUERY, zipCode: '01310999' }, 'quote'),
    ).resolves.toEqual({ status: 'not_found' });
    await expect(
      fake.roadDistanceKm({ lat: 1, lng: 1 }, { lat: 2, lng: 2 }),
    ).resolves.toBeNull();
    expect(fake.roadDistanceAvailable).toBe(false);

    delete process.env.GEOCODING_FAKE;
    const offline = new TestGeocoder();
    await expect(offline.geocode(QUERY, 'quote')).resolves.toEqual({
      status: 'unavailable',
    });
    expect(fake.calls).toHaveLength(0);
    expect(offline.calls).toHaveLength(0);
  });

  it('GEOCODING_FAKE fora de NODE_ENV=test é ignorado (com aviso)', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const geocoder = network({ GEOCODING_FAKE: '{}' });
    expect(geocoder.fake).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('GEOCODING_FAKE foi ignorado'),
    );
  });
});

describe('AddressGeoService (coordenadas dos endereços)', () => {
  const address = (fields: Partial<Address> = {}) =>
    ({
      id: 20,
      zipCode: '01310100',
      street: 'Avenida Paulista',
      number: '1000',
      neighborhood: 'Bela Vista',
      city: 'São Paulo',
      state: 'SP',
      geo_status: null,
      geo_checked_at: null,
      ...fields,
    }) as Address;

  function setup(distanceStores: boolean) {
    const geocoder = {
      geocode: jest.fn().mockResolvedValue({
        status: 'found',
        lat: -23.56,
        lng: -46.65,
        precision: 'ADDRESS',
        source: 'NOMINATIM',
      }),
    };
    const addresses = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    const builder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getExists: jest.fn().mockResolvedValue(distanceStores),
    };
    const stores = { createQueryBuilder: jest.fn(() => builder) };
    const service = new AddressGeoService(
      geocoder as unknown as GeocodingService,
      addresses as unknown as Repository<Address>,
      stores as unknown as Repository<Store>,
    );
    return { service, geocoder, addresses, builder };
  }

  it('PADRÃO (nenhuma loja cobra por distância): o cadastro não consulta nenhum serviço externo', async () => {
    const { service, geocoder, builder } = setup(false);
    await expect(service.resolveForSave(address())).resolves.toEqual(
      EMPTY_GEO_FIELDS,
    );
    await service.resolveForSave(address());
    expect(geocoder.geocode).not.toHaveBeenCalled();
    // A pergunta "alguma loja cobra por distância?" fica em cache por alguns segundos
    expect(builder.getExists).toHaveBeenCalledTimes(1);
  });

  it('com alguma loja por distância, o cadastro localiza o endereço (prazo do cadastro)', async () => {
    const { service, geocoder } = setup(true);
    await expect(service.resolveForSave(address())).resolves.toMatchObject({
      geo_latitude: -23.56,
      geo_longitude: -46.65,
      geo_precision: 'ADDRESS',
      geo_source: 'NOMINATIM',
      geo_status: 'FOUND',
    });
    expect(geocoder.geocode).toHaveBeenCalledWith(
      expect.objectContaining({ zipCode: '01310100', number: '1000' }),
      'save',
    );
  });

  it('orçamento: localiza o endereço nunca localizado e grava só se o endereço não mudou', async () => {
    const { service, geocoder, addresses } = setup(false);
    const refreshed = await service.refresh(address());
    expect(geocoder.geocode).toHaveBeenCalledWith(expect.anything(), 'quote');
    expect(refreshed).toMatchObject({
      geo_status: 'FOUND',
      geo_latitude: -23.56,
    });
    expect(addresses.update).toHaveBeenCalledWith(
      {
        id: 20,
        zipCode: '01310100',
        street: 'Avenida Paulista',
        number: '1000',
      },
      expect.objectContaining({ geo_status: 'FOUND' }),
    );
  });

  it('orçamento: localizado ou não encontrado não consulta de novo; fora do ar tenta de novo depois de 1 h', async () => {
    const { service, geocoder } = setup(false);
    await service.refresh(
      address({ geo_status: 'FOUND', geo_latitude: 1, geo_longitude: 2 }),
    );
    await service.refresh(address({ geo_status: 'NOT_FOUND' }));
    await service.refresh(
      address({ geo_status: 'UNAVAILABLE', geo_checked_at: new Date() }),
    );
    expect(geocoder.geocode).not.toHaveBeenCalled();
    await service.refresh(
      address({
        geo_status: 'UNAVAILABLE',
        geo_checked_at: new Date(Date.now() - GEO_RETRY_MS - 1),
      }),
    );
    expect(geocoder.geocode).toHaveBeenCalledTimes(1);
  });

  it('falha ao gravar não impede o orçamento', async () => {
    const { service, addresses } = setup(false);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    addresses.update.mockRejectedValueOnce(new Error('banco ocupado'));
    await expect(service.refresh(address())).resolves.toMatchObject({
      geo_status: 'FOUND',
    });
  });
});
