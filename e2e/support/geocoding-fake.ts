/**
 * Localização falsa por CEP para a entrega por distância (GEOCODING_FAKE, só com NODE_ENV=test): a API de teste
 * nunca consulta Google, Nominatim ou AwesomeAPI. Usado por playwright.config.ts (ambiente da API) e pelos specs
 * de distância (tests/api/commerce/delivery-distance.spec.ts e tests/web/multistore/delivery-distance.spec.ts).
 *
 * A loja fica em GEO_ORIGIN; cada CEP de cliente fica N km AO NORTE em linha reta (1 grau de latitude =
 * 111,19 km). Com o fator de rota padrão 1,3, a distância cobrada é N × 1,3.
 */
export const GEO_ORIGIN = { lat: -22.9035, lng: -43.2096 } as const;

const KM_PER_DEGREE = 111.19492664;
const north = (km: number) => ({ lat: Number((GEO_ORIGIN.lat + km / KM_PER_DEGREE).toFixed(6)), lng: GEO_ORIGIN.lng });

/** CEPs reservados para os testes de distância (nenhum outro spec usa a faixa 28970-xxx). */
export const GEO_CEPS = {
  /** Endereço da loja (o painel localiza a loja por ele). */
  store: '28970-000',
  /** 1 km em linha reta → 1,3 km. */
  km1: '28970-001',
  /** 3 km → 3,9 km. */
  km3: '28970-003',
  /** 5 km → 6,5 km. */
  km5: '28970-005',
  /** 10 km → 13 km. */
  km10: '28970-010',
  /** 1 km, localizado só pelo centro do CEP. */
  zipCenter: '28970-020',
  /** Provedores de mapa fora do ar. */
  unavailable: '28970-098',
  /** Endereço que nenhum provedor encontra. */
  notFound: '28970-099',
} as const;

const digits = (cep: string) => cep.replace(/\D/g, '');

export const GEOCODING_FAKE_MAP: Record<string, { lat: number; lng: number; precision?: 'ZIP_CENTER' } | 'unavailable' | null> = {
  [digits(GEO_CEPS.store)]: { ...GEO_ORIGIN },
  [digits(GEO_CEPS.km1)]: north(1),
  [digits(GEO_CEPS.km3)]: north(3),
  [digits(GEO_CEPS.km5)]: north(5),
  [digits(GEO_CEPS.km10)]: north(10),
  [digits(GEO_CEPS.zipCenter)]: { ...north(1), precision: 'ZIP_CENTER' },
  [digits(GEO_CEPS.unavailable)]: 'unavailable',
  [digits(GEO_CEPS.notFound)]: null,
};

/** Valor de GEOCODING_FAKE para a API de teste. */
export const E2E_GEOCODING_FAKE = JSON.stringify(GEOCODING_FAKE_MAP);
