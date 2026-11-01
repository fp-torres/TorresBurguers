import {
  DEFAULT_ROUTE_FACTOR,
  MAX_DISTANCE_BANDS,
  distanceDeliveryFor,
  haversineKm,
  maxDeliveryKm,
  parseDeliveryMode,
  parseDistanceSettings,
  publicDeliveryDistance,
  storeDistanceSettings,
  straightDeliveryKm,
  validCoordinates,
  type DistanceSettings,
} from './delivery-distance';
import { publicOrderRules } from './order-rules';
import { parseStoreDeliverySettings } from './store-delivery-settings';

const BANDS = [
  { up_to_km: 2, fee: 5, time: '25-35 min' },
  { up_to_km: 5, fee: 8, time: '35-45 min', min_order: 30 },
  { up_to_km: 8, fee: 12, time: '45-55 min', free_delivery_above: 80 },
];

describe('haversine e fator de rota', () => {
  const paulista = { lat: -23.5617, lng: -46.656 };
  const se = { lat: -23.5505, lng: -46.6333 };

  it('distância em linha reta conhecida (Av. Paulista → Praça da Sé ≈ 2,6 km)', () => {
    expect(haversineKm(paulista, se)).toBeCloseTo(2.62, 1);
    expect(haversineKm(paulista, paulista)).toBe(0);
    // Simétrica
    expect(haversineKm(se, paulista)).toBeCloseTo(haversineKm(paulista, se), 9);
  });

  it('1 grau de latitude ≈ 111,19 km (raio médio da Terra)', () => {
    expect(haversineKm({ lat: 0, lng: 10 }, { lat: 1, lng: 10 })).toBeCloseTo(
      111.19,
      2,
    );
  });

  it('a distância cobrada é a linha reta × fator (padrão 1,3), com 1 casa', () => {
    const straight = haversineKm(paulista, se);
    expect(straightDeliveryKm(paulista, se)).toBe(
      Math.round(straight * DEFAULT_ROUTE_FACTOR * 10) / 10,
    );
    expect(straightDeliveryKm(paulista, se, 1)).toBe(2.6);
    expect(straightDeliveryKm(paulista, se, 2)).toBe(
      Math.round(straight * 2 * 10) / 10,
    );
  });

  it('coordenadas válidas: números finitos nos limites; 0,0 conta como ausente', () => {
    expect(validCoordinates(-23.5, -46.6)).toEqual({ lat: -23.5, lng: -46.6 });
    expect(validCoordinates(null, -46.6)).toBeNull();
    expect(validCoordinates(91, 0)).toBeNull();
    expect(validCoordinates(0, 181)).toBeNull();
    expect(validCoordinates(0, 0)).toBeNull();
    expect(validCoordinates('-23.5', -46.6)).toBeNull();
    expect(validCoordinates(Number.NaN, 1)).toBeNull();
  });
});

describe('faixas de distância (parseDistanceSettings)', () => {
  it('normaliza: km e valores em centavos, prazo sem espaços, fator padrão gravado, sem raio extra', () => {
    expect(
      parseDistanceSettings({
        bands: [{ up_to_km: 2.004, fee: 5.001, time: ' 25-35 min ' }],
      }),
    ).toEqual({
      bands: [{ up_to_km: 2, fee: 5, time: '25-35 min' }],
      route_factor: 1.3,
    });
  });

  it('aplicar de novo dá o mesmo resultado (idempotente)', () => {
    const once = parseDistanceSettings({
      bands: BANDS,
      max_km: 12,
      extra_km_fee: 1.5,
      route_factor: 1.45,
      road_distance: true,
    });
    expect(parseDistanceSettings(once)).toEqual(once);
    expect(once).toEqual({
      bands: BANDS,
      max_km: 12,
      extra_km_fee: 1.5,
      route_factor: 1.45,
      road_distance: true,
    });
  });

  it('pedido mínimo e frete grátis por faixa usam as regras das zonas (0 vale; ausente herda)', () => {
    const parsed = parseDistanceSettings({
      bands: [
        {
          up_to_km: 3,
          fee: 4,
          time: '30 min',
          min_order: 0,
          free_delivery_above: 50,
        },
      ],
    });
    expect(parsed.bands[0]).toEqual({
      up_to_km: 3,
      fee: 4,
      time: '30 min',
      min_order: 0,
      free_delivery_above: 50,
    });
    expect(() =>
      parseDistanceSettings({
        bands: [{ up_to_km: 3, fee: 4, time: '30 min', min_order: '30' }],
      }),
    ).toThrow('"min_order" da faixa 1 precisa ser um valor em reais');
  });

  it.each([
    [null, '"distance" precisa ser um objeto'],
    [[], '"distance" precisa ser um objeto'],
    [{}, 'cadastre pelo menos uma faixa'],
    [{ bands: [] }, 'cadastre pelo menos uma faixa'],
    [{ bands: [{ up_to_km: 0, fee: 1, time: 'x' }] }, '"up_to_km" da faixa 1'],
    [{ bands: [{ up_to_km: 101, fee: 1, time: 'x' }] }, 'no máximo 100'],
    [
      { bands: [{ up_to_km: '2', fee: 1, time: 'x' }] },
      '"up_to_km" da faixa 1',
    ],
    [
      { bands: [{ up_to_km: 2, fee: -1, time: 'x' }] },
      'a taxa ("fee") da faixa 1',
    ],
    [
      { bands: [{ up_to_km: 2, fee: 1, time: ' ' }] },
      'informe o prazo ("time") da faixa 1',
    ],
    [
      { bands: [{ up_to_km: 2, fee: 1, time: 'x'.repeat(21) }] },
      'no máximo 20 caracteres',
    ],
    [
      { bands: [BANDS[1], BANDS[0]] },
      'a faixa 2 (até 2 km) precisa ir além da faixa 1 (até 5 km)',
    ],
    [{ bands: [BANDS[0], BANDS[0]] }, 'ordem crescente'],
    [{ bands: BANDS, max_km: 6 }, 'não pode ser menor que a última faixa'],
    [{ bands: BANDS, max_km: 10 }, 'informe a taxa por km adicional'],
    [
      { bands: BANDS, max_km: 10, extra_km_fee: 0 },
      'informe a taxa por km adicional',
    ],
    [{ bands: BANDS, extra_km_fee: 2 }, 'só vale com um raio máximo'],
    [{ bands: BANDS, route_factor: 0.9 }, '"route_factor" (fator de rota)'],
    [{ bands: BANDS, route_factor: 3.1 }, '"route_factor" (fator de rota)'],
    [{ bands: BANDS, road_distance: 'sim' }, '"road_distance" deve ser true'],
  ])('inválido %j → %s', (raw, message) => {
    expect(() => parseDistanceSettings(raw)).toThrow(message);
  });

  it(`no máximo ${MAX_DISTANCE_BANDS} faixas`, () => {
    const bands = Array.from(
      { length: MAX_DISTANCE_BANDS + 1 },
      (_, index) => ({
        up_to_km: index + 1,
        fee: 1,
        time: '30 min',
      }),
    );
    expect(() => parseDistanceSettings({ bands })).toThrow(
      `no máximo ${MAX_DISTANCE_BANDS} faixas`,
    );
    expect(
      parseDistanceSettings({ bands: bands.slice(0, MAX_DISTANCE_BANDS) })
        .bands,
    ).toHaveLength(MAX_DISTANCE_BANDS);
  });

  it('raio máximo igual à última faixa não é gravado (é o padrão)', () => {
    expect(parseDistanceSettings({ bands: BANDS, max_km: 8 })).toEqual({
      bands: BANDS,
      route_factor: DEFAULT_ROUTE_FACTOR,
    });
  });

  it('modo: "zones" ou "distance" (sem diferenciar maiúsculas); outro valor → erro', () => {
    expect(parseDeliveryMode(undefined)).toBeUndefined();
    expect(parseDeliveryMode(null)).toBeUndefined();
    expect(parseDeliveryMode(' Distance ')).toBe('distance');
    expect(parseDeliveryMode('zones')).toBe('zones');
    expect(() => parseDeliveryMode('km')).toThrow('"mode" deve ser "zones"');
  });
});

describe('faixa de uma distância (distanceDeliveryFor)', () => {
  const settings: DistanceSettings = parseDistanceSettings({ bands: BANDS });
  const withExtra = parseDistanceSettings({
    bands: BANDS,
    max_km: 12,
    extra_km_fee: 1.5,
  });

  it('primeira faixa que cobre a distância, com os limites inclusivos', () => {
    expect(distanceDeliveryFor(0, settings)).toMatchObject({ fee: 5, band: 1 });
    expect(distanceDeliveryFor(2, settings)).toMatchObject({ fee: 5, band: 1 });
    expect(distanceDeliveryFor(2.1, settings)).toMatchObject({
      fee: 8,
      time: '35-45 min',
      band: 2,
      extraKm: 0,
      area: { min_order: 30 },
    });
    expect(distanceDeliveryFor(8, settings)).toMatchObject({
      fee: 12,
      band: 3,
      area: { free_delivery_above: 80 },
    });
  });

  it('além da última faixa sem km adicional: fora do raio (null)', () => {
    expect(maxDeliveryKm(settings)).toBe(8);
    expect(distanceDeliveryFor(8.1, settings)).toBeNull();
    expect(distanceDeliveryFor(Number.NaN, settings)).toBeNull();
    expect(distanceDeliveryFor(-1, settings)).toBeNull();
  });

  it('km adicional: cada km iniciado além da última faixa, até o raio máximo', () => {
    expect(maxDeliveryKm(withExtra)).toBe(12);
    expect(distanceDeliveryFor(8.1, withExtra)).toMatchObject({
      fee: 13.5,
      extraKm: 1,
      band: 3,
      time: '45-55 min',
      area: { free_delivery_above: 80 },
    });
    expect(distanceDeliveryFor(9, withExtra)).toMatchObject({
      fee: 13.5,
      extraKm: 1,
    });
    expect(distanceDeliveryFor(9.2, withExtra)).toMatchObject({
      fee: 15,
      extraKm: 2,
    });
    expect(distanceDeliveryFor(12, withExtra)).toMatchObject({
      fee: 18,
      extraKm: 4,
    });
    expect(distanceDeliveryFor(12.1, withExtra)).toBeNull();
  });

  it('configuração da loja: só o modo "distance" com faixas válidas vale; vitrine mostra o raio', () => {
    expect(storeDistanceSettings(null)).toBeNull();
    expect(
      storeDistanceSettings({ zones: [], distance: { bands: BANDS } }),
    ).toBeNull();
    expect(
      storeDistanceSettings({ mode: 'distance', distance: { bands: [] } }),
    ).toBeNull();
    expect(
      storeDistanceSettings({ mode: 'distance', distance: { bands: BANDS } }),
    ).toMatchObject({ bands: BANDS });
    expect(
      publicDeliveryDistance({
        mode: 'distance',
        distance: { bands: BANDS, max_km: 12, extra_km_fee: 2 },
      }),
    ).toEqual({ max_km: 12 });
    expect(publicDeliveryDistance({ zones: [] })).toBeNull();
  });
});

describe('JSON de entrega da loja com o modo de cobrança (parseStoreDeliverySettings)', () => {
  const FALLBACK = { fee: 15, time: '60 min' };

  it('sem "mode" nem "distance": exatamente o JSON de antes', () => {
    const zones = {
      zones: [{ neighborhoods: ['Centro'], fee: 5, time: '30 min' }],
      fallback: FALLBACK,
    };
    expect(parseStoreDeliverySettings(zones)).toEqual(zones);
    // "mode": "zones" é o padrão: não é gravado
    expect(parseStoreDeliverySettings({ ...zones, mode: 'zones' })).toEqual(
      zones,
    );
  });

  it('modo distância: zonas podem faltar (gravadas vazias), faixas normalizadas, ordem de chaves estável', () => {
    const parsed = parseStoreDeliverySettings({
      mode: 'distance',
      distance: { bands: [{ up_to_km: 3, fee: 5, time: '30 min' }] },
      fallback: FALLBACK,
      min_order: 20,
    });
    expect(parsed).toEqual({
      zones: [],
      fallback: FALLBACK,
      min_order: 20,
      mode: 'distance',
      distance: {
        bands: [{ up_to_km: 3, fee: 5, time: '30 min' }],
        route_factor: 1.3,
      },
    });
    expect(Object.keys(parsed ?? {})).toEqual([
      'zones',
      'fallback',
      'min_order',
      'mode',
      'distance',
    ]);
    expect(parseStoreDeliverySettings(parsed)).toEqual(parsed);
  });

  it('modo distância com recusa fora do raio: não exige zonas nem "fallback"', () => {
    expect(
      parseStoreDeliverySettings({
        zones: [],
        outside_zones: 'refuse',
        mode: 'distance',
        distance: { bands: BANDS },
      }),
    ).toMatchObject({ zones: [], outside_zones: 'refuse', mode: 'distance' });
    // No modo por zonas, a recusa continua exigindo uma zona
    expect(() =>
      parseStoreDeliverySettings({ zones: [], outside_zones: 'refuse' }),
    ).toThrow('cadastre pelo menos uma zona');
  });

  it('modo distância exige as faixas e a taxa de fora do raio (ou a recusa)', () => {
    expect(() =>
      parseStoreDeliverySettings({ mode: 'distance', fallback: FALLBACK }),
    ).toThrow('informe as faixas em "distance"');
    expect(() =>
      parseStoreDeliverySettings({
        mode: 'distance',
        distance: { bands: BANDS },
      }),
    ).toThrow('endereços além do raio de entrega ou que não forem localizados');
    expect(() =>
      parseStoreDeliverySettings({
        mode: 'distance',
        fallback: FALLBACK,
        distance: { bands: [{ up_to_km: 3, fee: 5 }] },
      }),
    ).toThrow('informe o prazo ("time") da faixa 1');
    expect(() =>
      parseStoreDeliverySettings({ mode: 'km', zones: [], fallback: FALLBACK }),
    ).toThrow('"mode" deve ser');
  });

  it('modo por zonas guarda as faixas enviadas (validadas) para quando a loja trocar de modo', () => {
    const parsed = parseStoreDeliverySettings({
      zones: [{ neighborhoods: ['Centro'], fee: 5, time: '30 min' }],
      fallback: FALLBACK,
      distance: { bands: BANDS, route_factor: 1.2 },
    });
    expect(parsed).not.toHaveProperty('mode');
    expect(parsed?.distance).toEqual({ bands: BANDS, route_factor: 1.2 });
    expect(() =>
      parseStoreDeliverySettings({
        zones: [{ neighborhoods: ['Centro'], fee: 5, time: '30 min' }],
        fallback: FALLBACK,
        distance: { bands: [] },
      }),
    ).toThrow('cadastre pelo menos uma faixa');
  });

  it('texto JSON e null', () => {
    expect(parseStoreDeliverySettings(null)).toBeNull();
    expect(() => parseStoreDeliverySettings('{')).toThrow(
      'não é um JSON válido',
    );
    expect(
      parseStoreDeliverySettings(
        JSON.stringify({
          mode: 'distance',
          distance: { bands: BANDS },
          fallback: FALLBACK,
        }),
      ),
    ).toMatchObject({ mode: 'distance' });
  });

  it('vitrine: "varia por zona" considera as faixas no modo distância', () => {
    const base = { zones: [], fallback: FALLBACK, min_order: 30 };
    expect(
      publicOrderRules({
        ...base,
        mode: 'distance',
        distance: { bands: [{ up_to_km: 3, fee: 5, time: '30 min' }] },
      }).varies_by_zone,
    ).toBe(false);
    expect(
      publicOrderRules({
        ...base,
        mode: 'distance',
        distance: { bands: BANDS.map((band) => ({ ...band, min_order: 50 })) },
      }).varies_by_zone,
    ).toBe(true);
    // Faixas guardadas no modo por zonas não contam
    expect(
      publicOrderRules({
        ...base,
        distance: { bands: BANDS.map((band) => ({ ...band, min_order: 50 })) },
      }).varies_by_zone,
    ).toBe(false);
  });
});
