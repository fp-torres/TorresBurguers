import { SubscriptionStatus } from '../billing/entities/subscription.entity';
import {
  canonicalTimeZone,
  credentialEnvironmentOf,
  documentError,
  featuresOf,
  isValidCnpj,
  isValidCpf,
  MAX_DELIVERY_ZONES,
  MAX_OPENING_HOURS_ENTRIES,
  MAX_ZONE_ZIP_RANGES,
  mercadoPagoCredentialEnvironment,
  normalizeDocument,
  onlinePaymentsEnabled,
  parseOpeningHours,
  parseStoreDeliveryZones,
  platformPublicKey,
} from './store-rules';

const PRODUCTION = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
const TEST = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;

describe('store-rules', () => {
  describe('documento (CPF/CNPJ)', () => {
    it('normaliza a pontuação digitada e deixa letras maiúsculas', () => {
      expect(normalizeDocument('529.982.247-25')).toBe('52998224725');
      expect(normalizeDocument(' 11.222.333/0001-81 ')).toBe('11222333000181');
      expect(normalizeDocument('12.abc.345/01de-35')).toBe('12ABC34501DE35');
    });

    it('CPF: confere os dois dígitos verificadores', () => {
      expect(isValidCpf('52998224725')).toBe(true);
      expect(isValidCpf('52998224724')).toBe(false);
      expect(isValidCpf('11111111111')).toBe(false); // todos iguais
      expect(isValidCpf('5299822472')).toBe(false);
    });

    it('CNPJ numérico e alfanumérico (julho/2026): mesmos pesos, letra vale ASCII − 48', () => {
      expect(isValidCnpj('11222333000181')).toBe(true);
      expect(isValidCnpj('11222333000182')).toBe(false);
      expect(isValidCnpj('12ABC34501DE35')).toBe(true);
      expect(isValidCnpj('12ABC34501DE36')).toBe(false);
      expect(isValidCnpj('00000000000000')).toBe(false);
      // dígitos verificadores são sempre numéricos
      expect(isValidCnpj('12ABC34501DEAB')).toBe(false);
    });

    it('documentError explica cada problema (null = válido)', () => {
      expect(documentError('52998224725')).toBeNull();
      expect(documentError('11222333000181')).toBeNull();
      expect(documentError('52998224724')).toMatch(/^CPF inválido/);
      expect(documentError('11222333000182')).toMatch(/^CNPJ inválido/);
      expect(documentError('123')).toMatch(/Informe o CPF \(11 dígitos\)/);
      expect(documentError('5299822472A')).toMatch(/Informe o CPF/);
    });
  });

  it('fuso: só nomes IANA válidos, no formato canônico', () => {
    expect(canonicalTimeZone('America/Sao_Paulo')).toBe('America/Sao_Paulo');
    expect(canonicalTimeZone(' america/sao_paulo ')).toBe('America/Sao_Paulo');
    expect(canonicalTimeZone('UTC')).toBe('UTC');
    expect(canonicalTimeZone('Fuso/Invalido')).toBeNull();
    // deslocamentos são lidos com o sinal invertido pelo PostgreSQL: recusados
    expect(canonicalTimeZone('+03:00')).toBeNull();
    expect(canonicalTimeZone('')).toBeNull();
  });

  describe('horários de funcionamento', () => {
    it('ordena por dia e horário; lista vazia ou null → null', () => {
      expect(
        parseOpeningHours([
          { day: 6, open: '18:00', close: '02:00' },
          { day: 0, open: '18:00', close: '23:00' },
          { day: 0, open: ' 11:30 ', close: '15:00' },
        ]),
      ).toEqual([
        { day: 0, open: '11:30', close: '15:00' },
        { day: 0, open: '18:00', close: '23:00' },
        { day: 6, open: '18:00', close: '02:00' },
      ]);
      expect(parseOpeningHours([])).toBeNull();
      expect(parseOpeningHours(null)).toBeNull();
    });

    it('recusa dia, horário e formato inválidos com a explicação', () => {
      expect(() => parseOpeningHours({ day: 1 })).toThrow(/lista/);
      expect(() =>
        parseOpeningHours([{ day: 7, open: '18:00', close: '23:00' }]),
      ).toThrow(/0 \(domingo\) a 6 \(sábado\)/);
      expect(() =>
        parseOpeningHours([{ day: 1.5, open: '18:00', close: '23:00' }]),
      ).toThrow(/"day"/);
      expect(() =>
        parseOpeningHours([{ day: 1, open: '9:00', close: '23:00' }]),
      ).toThrow(/HH:MM/);
      expect(() =>
        parseOpeningHours([{ day: 1, open: '18:00', close: '24:00' }]),
      ).toThrow(/HH:MM/);
      expect(() =>
        parseOpeningHours([{ day: 1, open: '18:00', close: '18:00' }]),
      ).toThrow(/mesmo horário/);
      expect(() =>
        parseOpeningHours([
          { day: 1, open: '18:00', close: '23:00' },
          { day: 1, open: '18:00', close: '23:00' },
        ]),
      ).toThrow(/repete/);
      expect(() => parseOpeningHours(['18:00'])).toThrow(/horário 1/);
      expect(() =>
        parseOpeningHours(
          Array.from({ length: MAX_OPENING_HOURS_ENTRIES + 1 }, (_, i) => ({
            day: i % 7,
            open: `${String(i).padStart(2, '0')}:00`,
            close: '23:59',
          })),
        ),
      ).toThrow(/no máximo/);
    });
  });

  describe('zonas de entrega da loja', () => {
    const zones = {
      fallback: { fee: 12.345, time: ' 50-60 min ' },
      zones: [
        {
          neighborhoods: [' Centro ', 'Lapa'],
          cities: ['Rio de Janeiro'],
          fee: 5,
          time: '30-40 min',
        },
      ],
    };

    it('normaliza pelas regras do frete (centavos, espaços) e é idempotente', () => {
      const parsed = parseStoreDeliveryZones(zones);
      expect(parsed).toEqual({
        fallback: { fee: 12.35, time: '50-60 min' },
        zones: [
          {
            neighborhoods: ['Centro', 'Lapa'],
            cities: ['Rio de Janeiro'],
            fee: 5,
            time: '30-40 min',
          },
        ],
      });
      expect(parseStoreDeliveryZones(parsed)).toEqual(parsed);
      expect(parseStoreDeliveryZones(JSON.stringify(zones))).toEqual(parsed);
      expect(parseStoreDeliveryZones(null)).toBeNull();
    });

    it('taxa única para todos os bairros: zones vazio + fallback', () => {
      expect(
        parseStoreDeliveryZones({
          fallback: { fee: 8, time: '40 min' },
          zones: [],
        }),
      ).toEqual({ fallback: { fee: 8, time: '40 min' }, zones: [] });
    });

    it('endereços fora das zonas: "refuse" dispensa o fallback, exige uma zona e é idempotente', () => {
      const refusing = parseStoreDeliveryZones({
        zones: zones.zones,
        outside_zones: 'Refuse',
      });
      expect(refusing).toEqual({
        zones: [
          {
            neighborhoods: ['Centro', 'Lapa'],
            cities: ['Rio de Janeiro'],
            fee: 5,
            time: '30-40 min',
          },
        ],
        outside_zones: 'refuse',
      });
      expect(refusing).not.toHaveProperty('fallback');
      expect(parseStoreDeliveryZones(refusing)).toEqual(refusing);
      // fallback null com "refuse" = sem fallback
      expect(parseStoreDeliveryZones({ ...refusing, fallback: null })).toEqual(
        refusing,
      );
      // Com "refuse" e fallback informado, o fallback fica guardado (volta a valer se a loja aceitar de novo)
      expect(
        parseStoreDeliveryZones({ ...zones, outside_zones: 'refuse' }),
      ).toMatchObject({
        fallback: { fee: 12.35, time: '50-60 min' },
        outside_zones: 'refuse',
      });
      // "fallback" explícito também é guardado
      expect(
        parseStoreDeliveryZones({ ...zones, outside_zones: 'fallback' }),
      ).toMatchObject({ outside_zones: 'fallback' });

      expect(() =>
        parseStoreDeliveryZones({ zones: [], outside_zones: 'refuse' }),
      ).toThrow(/pelo menos uma zona/);
      expect(() =>
        parseStoreDeliveryZones({ zones: zones.zones, outside_zones: 'nao' }),
      ).toThrow(/outside_zones/);
      expect(() =>
        parseStoreDeliveryZones({
          zones: zones.zones,
          outside_zones: 'fallback',
        }),
      ).toThrow(/fallback/);
    });

    it('zonas por faixa de CEP: até 50 faixas por zona', () => {
      const range = { from: '20000-000', to: '20099-999' };
      expect(
        parseStoreDeliveryZones({
          fallback: { fee: 9, time: '1 h' },
          zones: [{ zip_ranges: [range], fee: 4, time: '20 min' }],
        }),
      ).toEqual({
        zones: [
          {
            neighborhoods: [],
            zip_ranges: [{ from: '20000000', to: '20099999' }],
            fee: 4,
            time: '20 min',
          },
        ],
        fallback: { fee: 9, time: '1 h' },
      });
      expect(() =>
        parseStoreDeliveryZones({
          fallback: { fee: 9, time: '1 h' },
          zones: [
            {
              zip_ranges: Array.from(
                { length: MAX_ZONE_ZIP_RANGES + 1 },
                () => range,
              ),
              fee: 4,
              time: '20 min',
            },
          ],
        }),
      ).toThrow(/faixas de CEP/);
    });

    it('fallback é obrigatório (o padrão da plataforma vale só para a loja padrão)', () => {
      expect(() => parseStoreDeliveryZones({ zones: zones.zones })).toThrow(
        /fallback/,
      );
      expect(() => parseStoreDeliveryZones(zones.zones)).toThrow(/objeto/);
    });

    it('recusa estrutura inválida com a explicação em português', () => {
      expect(() => parseStoreDeliveryZones('{ruim')).toThrow(/JSON válido/);
      expect(() =>
        parseStoreDeliveryZones({
          fallback: zones.fallback,
          zones: [{ fee: 5, time: '30 min' }],
        }),
      ).toThrow(/neighborhoods/);
      expect(() =>
        parseStoreDeliveryZones({
          fallback: { fee: -1, time: '1h' },
          zones: [],
        }),
      ).toThrow(/fallback/);
      expect(() =>
        parseStoreDeliveryZones({
          fallback: zones.fallback,
          zones: Array.from({ length: MAX_DELIVERY_ZONES + 1 }, () => ({
            neighborhoods: ['Centro'],
            fee: 1,
            time: '1h',
          })),
        }),
      ).toThrow(/no máximo/);
      expect(() =>
        parseStoreDeliveryZones({
          fallback: zones.fallback,
          zones: [{ neighborhoods: ['x'.repeat(81)], fee: 1, time: '1h' }],
        }),
      ).toThrow(/80 caracteres/);
      expect(() =>
        parseStoreDeliveryZones({
          fallback: { fee: 1, time: 'x'.repeat(21) },
          zones: [],
        }),
      ).toThrow(/20 caracteres/);
    });
  });

  it('credenciais do Mercado Pago: produção (APP_USR-) ou teste (TEST-)', () => {
    expect(
      mercadoPagoCredentialEnvironment('APP_USR-1234567890123456-101112-abc'),
    ).toBe('PRODUCTION');
    expect(mercadoPagoCredentialEnvironment('TEST-5a6b2c43-1e71-4b0e')).toBe(
      'TEST',
    );
    expect(mercadoPagoCredentialEnvironment('APP_USR-')).toBeNull();
    expect(mercadoPagoCredentialEnvironment('APP_USR-1234 5678 90')).toBeNull();
    expect(mercadoPagoCredentialEnvironment('sk_live_123456789')).toBeNull();
  });

  describe('pagamento online na vitrine', () => {
    const base = { storeCredential: null, isDefaultStore: false };

    it('sem o recurso do plano, nunca', () => {
      expect(
        onlinePaymentsEnabled({
          ...base,
          planAllows: false,
          storeCredential: 'PRODUCTION',
          env: TEST,
        }),
      ).toBe(false);
    });

    it('credencial de produção da própria loja libera em qualquer ambiente', () => {
      expect(
        onlinePaymentsEnabled({
          ...base,
          planAllows: true,
          storeCredential: 'PRODUCTION',
          env: PRODUCTION,
        }),
      ).toBe(true);
    });

    it('em produção, credencial de teste (TEST-) não conta — como na cobrança', () => {
      expect(
        onlinePaymentsEnabled({
          ...base,
          planAllows: true,
          storeCredential: 'TEST',
          env: PRODUCTION,
        }),
      ).toBe(false);
      // A loja com credencial própria (mesmo recusada) não herda o MP_ACCESS_TOKEN do ambiente
      expect(
        onlinePaymentsEnabled({
          planAllows: true,
          storeCredential: 'TEST',
          isDefaultStore: true,
          env: { ...PRODUCTION, MP_ACCESS_TOKEN: 'APP_USR-plataforma-123' },
        }),
      ).toBe(false);
      expect(
        onlinePaymentsEnabled({
          ...base,
          planAllows: true,
          isDefaultStore: true,
          env: { ...PRODUCTION, MP_ACCESS_TOKEN: 'TEST-plataforma-123' },
        }),
      ).toBe(false);
    });

    it('MP_ACCESS_TOKEN do ambiente vale só para a loja padrão sem credencial própria', () => {
      const env = { ...PRODUCTION, MP_ACCESS_TOKEN: 'APP_USR-plataforma-123' };
      expect(
        onlinePaymentsEnabled({
          ...base,
          planAllows: true,
          isDefaultStore: true,
          env,
        }),
      ).toBe(true);
      expect(onlinePaymentsEnabled({ ...base, planAllows: true, env })).toBe(
        false,
      );
    });

    it('ambiente da credencial pelo prefixo', () => {
      expect(credentialEnvironmentOf('TEST-abc')).toBe('TEST');
      expect(credentialEnvironmentOf('APP_USR-abc')).toBe('PRODUCTION');
      expect(credentialEnvironmentOf(' ')).toBeNull();
      expect(credentialEnvironmentOf(null)).toBeNull();
    });

    it('sandbox só em development/test (aprovações simuladas)', () => {
      expect(
        onlinePaymentsEnabled({ ...base, planAllows: true, env: TEST }),
      ).toBe(true);
      expect(
        onlinePaymentsEnabled({ ...base, planAllows: true, env: PRODUCTION }),
      ).toBe(false);
      expect(
        onlinePaymentsEnabled({
          ...base,
          planAllows: true,
          env: { ...PRODUCTION, PAYMENT_SANDBOX: 'true' },
        }),
      ).toBe(false);
    });

    it('MP_PUBLIC_KEY vazia → null', () => {
      expect(platformPublicKey({ MP_PUBLIC_KEY: '  ' })).toBeNull();
      expect(platformPublicKey({ MP_PUBLIC_KEY: ' APP_USR-pk ' })).toBe(
        'APP_USR-pk',
      );
    });
  });

  it('recursos do plano: todas as chaves, só da assinatura não cancelada', () => {
    const none = {
      online_payments: false,
      advanced_reports: false,
      custom_branding: false,
    };
    expect(featuresOf(null)).toEqual(none);
    const plan = { features: { online_payments: true, custom_branding: true } };
    expect(
      featuresOf({ status: SubscriptionStatus.ACTIVE, plan } as never),
    ).toEqual({ ...none, online_payments: true, custom_branding: true });
    expect(
      featuresOf({ status: SubscriptionStatus.CANCELED, plan } as never),
    ).toEqual(none);
  });
});
