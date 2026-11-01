import { OrderStatus, OrderType, PaymentStatus } from './order.enums';
import {
  DEFAULT_STORE_TIME_ZONE,
  DELIVERY_DISABLED_MESSAGE,
  DELIVERY_OUT_OF_AREA_MESSAGE,
  MAX_MONEY_CENTS,
  REPORT_MAX_DAYS,
  TAKEOUT_DISABLED_MESSAGE,
  TAKEOUT_ESTIMATE,
  ORDERS_PAGE_INVALID_MESSAGE,
  activeScopeSince,
  addDaysToKey,
  canStaffSeeOrder,
  chartWindowStart,
  checkAssign,
  checkCancel,
  checkStatusChange,
  countAddonIds,
  dateKeyInZone,
  dateKeysBetween,
  dayKeyInZone,
  deliveryEstimate,
  deliveryEstimateAt,
  effectiveUnitPriceCents,
  findDeliveryZone,
  formatBRL,
  fromCents,
  isInActiveScope,
  isOrderManager,
  isSameDeliveryArea,
  isStaffRole,
  isValidTransition,
  lastDayKeys,
  needsRefundOnCancel,
  orderTotalLimitError,
  orderTypeUnavailableMessage,
  outsideZonesPolicy,
  parseDeliveryZones,
  parseListPage,
  parseMoneyInput,
  parseOrdersScope,
  parseReportRange,
  paymentStatusAfterRefund,
  priceLine,
  resolveChangeFor,
  resolveDeliveryZones,
  resolveTimeZone,
  shouldMarkPaidOnStatus,
  staffOrderScopes,
  staffOrderView,
  startOfDayInZone,
  storeDeliveryZones,
  storeTimeZone,
  takeoutEstimateFor,
  toCents,
  zipCodeDigits,
  type StatusChangeInput,
} from './order-rules';
import { DEFAULT_DELIVERY_ZONES } from './delivery-zones.config';

const { PENDING, PREPARING, READY_FOR_PICKUP, DELIVERING, DONE, CANCELED } =
  OrderStatus;
const { DELIVERY, TAKEOUT } = OrderType;

describe('order-rules', () => {
  describe('dinheiro', () => {
    it('converte reais (number ou string do Postgres) para centavos sem erro de ponto flutuante', () => {
      expect(toCents(29.9)).toBe(2990);
      expect(toCents('35.90')).toBe(3590);
      expect(toCents(0.1 + 0.2)).toBe(30);
      expect(toCents('abc')).toBe(0);
      expect(fromCents(7780)).toBe(77.8);
    });

    it('formata em reais no padrão brasileiro', () => {
      expect(formatBRL(1234.5)).toBe('R$ 1.234,50');
      expect(formatBRL(50)).toBe('R$ 50,00');
    });
  });

  describe('preço dos itens', () => {
    it('usa o preço promocional apenas quando definido e menor que o preço cheio', () => {
      expect(effectiveUnitPriceCents('35.90', null)).toBe(3590);
      expect(effectiveUnitPriceCents('35.90', undefined)).toBe(3590);
      expect(effectiveUnitPriceCents('35.90', '29.90')).toBe(2990);
      expect(effectiveUnitPriceCents('35.90', '35.90')).toBe(3590);
      expect(effectiveUnitPriceCents('35.90', '40.00')).toBe(3590);
      expect(effectiveUnitPriceCents('35.90', '0.00')).toBe(3590);
    });

    it('agrupa ids de adicionais repetidos como quantidade, na ordem da primeira ocorrência', () => {
      expect(countAddonIds([3, 5, 3, 3])).toEqual([
        { id: 3, quantity: 3 },
        { id: 5, quantity: 1 },
      ]);
      expect(countAddonIds([])).toEqual([]);
      expect(countAddonIds(undefined)).toEqual([]);
      expect(countAddonIds(null)).toEqual([]);
    });

    it('calcula a linha: (unitário + adicionais de uma unidade) × quantidade', () => {
      // Exemplo do mapa do backend: 29,90 × 2 com um adicional de 4,00
      expect(priceLine(2990, [{ priceCents: 400, quantity: 1 }], 2)).toEqual({
        unitPriceCents: 2990,
        addonsCents: 400,
        lineCents: 6780,
      });
    });

    it('cobra cada unidade de um adicional repetido (2x Bacon = 2 × preço)', () => {
      const line = priceLine(
        2490,
        [
          { priceCents: 400, quantity: 2 },
          { priceCents: 300, quantity: 1 },
        ],
        3,
      );
      expect(line.addonsCents).toBe(1100);
      expect(line.lineCents).toBe((2490 + 1100) * 3);
    });
  });

  describe('entrega', () => {
    it('calcula taxa e tempo pelo bairro, sem diferenciar acentos e maiúsculas', () => {
      expect(deliveryEstimate('Centro')).toEqual({ fee: 5, time: '30-40 min' });
      expect(deliveryEstimate('  SANTA TERESA ')).toEqual({
        fee: 5,
        time: '30-40 min',
      });
      expect(deliveryEstimate('Laranjeiras')).toEqual({
        fee: 7,
        time: '40-50 min',
      });
      expect(deliveryEstimate('Leblon')).toEqual({
        fee: 10,
        time: '50-60 min',
      });
      expect(deliveryEstimate('Maracanã')).toEqual({
        fee: 12,
        time: '50-60 min',
      });
      expect(deliveryEstimate('Recreio dos Bandeirantes')).toEqual({
        fee: 20,
        time: '60-80 min',
      });
    });

    it('"Barra da Tijuca" é Barra (não Tijuca)', () => {
      expect(deliveryEstimate('Barra da Tijuca').fee).toBe(20);
      expect(deliveryEstimate('Tijuca').fee).toBe(12);
    });

    it('usa a faixa padrão para bairros desconhecidos ou vazios', () => {
      expect(deliveryEstimate('Méier')).toEqual({ fee: 15, time: '50-60 min' });
      expect(deliveryEstimate(null)).toEqual({ fee: 15, time: '50-60 min' });
    });

    it('devolve uma cópia (alterar o resultado não muda a tabela)', () => {
      const estimate = deliveryEstimate('Centro');
      estimate.fee = 999;
      expect(deliveryEstimate('Centro').fee).toBe(5);
    });

    it('casa o nome INTEIRO do bairro, nunca um pedaço dele', () => {
      // "Barra Funda" (SP) não é "Barra"; "Centro Histórico" não é "Centro"
      expect(deliveryEstimate('Barra Funda').fee).toBe(15);
      expect(deliveryEstimate('Centro Histórico').fee).toBe(15);
      expect(deliveryEstimate('Alto da Tijuca').fee).toBe(15);
      expect(deliveryEstimate('Barra').fee).toBe(20);
      expect(deliveryEstimate('Recreio').fee).toBe(20);
      expect(deliveryEstimate('maracana').fee).toBe(12);
    });

    it('zonas com cidade só valem naquela cidade (sem diferenciar acentos)', () => {
      const config = parseDeliveryZones({
        fallback: { fee: 9, time: '40-50 min' },
        zones: [
          {
            neighborhoods: ['Centro'],
            cities: ['São Paulo'],
            fee: 6,
            time: '20-30 min',
          },
        ],
      });
      expect(deliveryEstimate('Centro', 'sao paulo', config)).toEqual({
        fee: 6,
        time: '20-30 min',
      });
      expect(deliveryEstimate('Centro', 'Rio de Janeiro', config)).toEqual({
        fee: 9,
        time: '40-50 min',
      });
    });
  });

  describe('configuração das zonas de entrega', () => {
    const json = JSON.stringify({
      zones: [
        {
          neighborhoods: ['Pinheiros', 'Vila Madalena'],
          fee: 8.5,
          time: '30-40 min',
        },
      ],
    });

    it('sem variáveis usa delivery-zones.config.ts', () => {
      const resolved = resolveDeliveryZones({}, () => {
        throw new Error('não deveria ler arquivo');
      });
      expect(resolved).toEqual({
        config: DEFAULT_DELIVERY_ZONES,
        source: 'padrão',
      });
    });

    it('DELIVERY_ZONES_JSON substitui as zonas (o padrão de bairros fora da lista continua)', () => {
      const { config, source } = resolveDeliveryZones(
        { DELIVERY_ZONES_JSON: json },
        () => '',
      );
      expect(source).toBe('DELIVERY_ZONES_JSON');
      expect(deliveryEstimate('vila madalena', null, config)).toEqual({
        fee: 8.5,
        time: '30-40 min',
      });
      expect(deliveryEstimate('Centro', null, config)).toEqual(
        DEFAULT_DELIVERY_ZONES.fallback,
      );
    });

    it('DELIVERY_ZONES_FILE lê um arquivo .json (lista simples também vale)', () => {
      const read = jest.fn(() =>
        JSON.stringify([{ neighborhoods: ['Moema'], fee: 12, time: '1 h' }]),
      );
      const { config, source } = resolveDeliveryZones(
        { DELIVERY_ZONES_FILE: './zonas.json' },
        read,
      );
      expect(read).toHaveBeenCalledWith('./zonas.json');
      expect(source).toBe('./zonas.json');
      expect(deliveryEstimate('Moema', null, config).fee).toBe(12);
    });

    it('configuração inválida não derruba a API: usa o padrão e explica o motivo', () => {
      for (const raw of [
        '{',
        '{"zones": "Centro"}',
        '{"zones": [{"neighborhoods": [], "fee": 5, "time": "1 h"}]}',
        '{"zones": [{"neighborhoods": ["Centro"], "fee": -1, "time": "1 h"}]}',
        '{"zones": [{"neighborhoods": ["Centro"], "fee": 5}]}',
        '{"fallback": {"fee": "dez"}, "zones": []}',
      ]) {
        const resolved = resolveDeliveryZones(
          { DELIVERY_ZONES_JSON: raw },
          () => '',
        );
        expect(resolved.config).toBe(DEFAULT_DELIVERY_ZONES);
        expect(resolved.error).toMatch(/^DELIVERY_ZONES_JSON: /);
      }
      const missingFile = resolveDeliveryZones(
        { DELIVERY_ZONES_FILE: 'nao-existe.json' },
        () => {
          throw new Error('ENOENT');
        },
      );
      expect(missingFile.error).toContain('ENOENT');
    });
  });

  describe('área de entrega: faixas de CEP e endereços fora das zonas', () => {
    const config = parseDeliveryZones({
      fallback: { fee: 9, time: '50 min' },
      zones: [
        { neighborhoods: ['Centro'], fee: 5, time: '30 min' },
        {
          zip_ranges: [
            { from: '22010-000', to: '22099-999' },
            { from: 22200000, to: '22299999' },
          ],
          fee: 7,
          time: '40 min',
        },
      ],
    });

    it('faixas de CEP: normaliza para 8 dígitos e a zona pode não ter bairros', () => {
      expect(config.zones[1]).toEqual({
        neighborhoods: [],
        zip_ranges: [
          { from: '22010000', to: '22099999' },
          { from: '22200000', to: '22299999' },
        ],
        fee: 7,
        time: '40 min',
      });
      expect(config.outside_zones).toBeUndefined();
    });

    it('vale a primeira zona com o bairro OU com o CEP na faixa (limites inclusive)', () => {
      expect(
        findDeliveryZone(
          { neighborhood: 'Botafogo', zipCode: '22250-040' },
          config,
        )?.fee,
      ).toBe(7);
      expect(
        findDeliveryZone({ neighborhood: 'x', zipCode: '22010000' }, config)
          ?.fee,
      ).toBe(7);
      expect(
        findDeliveryZone({ neighborhood: 'x', zipCode: '22099999' }, config)
          ?.fee,
      ).toBe(7);
      expect(
        findDeliveryZone({ neighborhood: 'x', zipCode: '22100000' }, config),
      ).toBeUndefined();
      // Bairro da zona 1 com CEP da zona 2: a primeira zona da lista ganha
      expect(
        findDeliveryZone(
          { neighborhood: 'centro', zipCode: '22041001' },
          config,
        )?.fee,
      ).toBe(5);
      // CEP inválido não casa com faixa nenhuma
      expect(
        findDeliveryZone({ neighborhood: 'x', zipCode: '220' }, config),
      ).toBeUndefined();
      expect(deliveryEstimate('x', null, config, '22041-001')).toEqual({
        fee: 7,
        time: '40 min',
      });
    });

    it('outside_zones: "fallback" (padrão) paga a faixa padrão; "refuse" → null (a loja recusa)', () => {
      const location = { neighborhood: 'Méier', zipCode: '20710000' };
      expect(outsideZonesPolicy(config)).toBe('fallback');
      expect(deliveryEstimateAt(location, config)).toEqual({
        fee: 9,
        time: '50 min',
      });

      const refusing = parseDeliveryZones({
        ...config,
        outside_zones: ' REFUSE ',
      });
      expect(refusing.outside_zones).toBe('refuse');
      expect(outsideZonesPolicy(refusing)).toBe('refuse');
      expect(deliveryEstimateAt(location, refusing)).toBeNull();
      expect(deliveryEstimateAt({ neighborhood: 'Centro' }, refusing)).toEqual({
        fee: 5,
        time: '30 min',
      });
      // deliveryEstimate (sem a política) continua devolvendo a faixa padrão
      expect(deliveryEstimate('Méier', null, refusing)).toEqual({
        fee: 9,
        time: '50 min',
      });
      expect(DELIVERY_OUT_OF_AREA_MESSAGE).toBe(
        'Este endereço está fora da área de entrega da loja.',
      );
    });

    it('"fallback": null vale como ausente (usa o da base)', () => {
      const parsed = parseDeliveryZones(
        { fallback: null, zones: [], outside_zones: 'refuse' },
        DEFAULT_DELIVERY_ZONES,
      );
      expect(parsed.fallback).toEqual(DEFAULT_DELIVERY_ZONES.fallback);
      expect(parsed.outside_zones).toBe('refuse');
    });

    it('recusa faixas e políticas inválidas com a explicação', () => {
      const zone = { fee: 5, time: '30 min' };
      for (const [raw, message] of [
        [{ zones: [{ ...zone, zip_ranges: 'x' }] }, /zip_ranges/],
        [{ zones: [{ ...zone, zip_ranges: [] }] }, /neighborhoods/],
        [{ zones: [{ ...zone, zip_ranges: [{ from: '123' }] }] }, /8 dígitos/],
        [
          {
            zones: [
              { ...zone, zip_ranges: [{ from: '22099999', to: '22010000' }] },
            ],
          },
          /menor ou igual/,
        ],
        [
          {
            zones: [
              {
                ...zone,
                neighborhoods: ['Centro', ''],
                zip_ranges: [{ from: '22010000', to: '22099999' }],
              },
            ],
          },
          /neighborhoods/,
        ],
        [{ zones: [], outside_zones: 'talvez' }, /outside_zones/],
        [{ zones: [], outside_zones: true }, /outside_zones/],
      ] as const) {
        expect(() => parseDeliveryZones(raw)).toThrow(message);
      }
    });

    it('CEP: só os 8 dígitos', () => {
      expect(zipCodeDigits('22041-001')).toBe('22041001');
      expect(zipCodeDigits(1001000)).toBe('01001000');
      expect(zipCodeDigits('2204100')).toBeNull();
      expect(zipCodeDigits(undefined)).toBeNull();
    });
  });

  describe('limite do total', () => {
    it('total acima de R$ 99.999.999,99 é recusado antes de cobrar', () => {
      expect(MAX_MONEY_CENTS).toBe(9_999_999_999);
      expect(orderTotalLimitError(MAX_MONEY_CENTS)).toBeNull();
      expect(orderTotalLimitError(MAX_MONEY_CENTS + 1)).toContain(
        'R$ 99.999.999,99',
      );
      // 3 linhas × 50 × R$ 999.999,99
      expect(orderTotalLimitError(toCents(149_999_998.5))).toContain(
        'R$ 149.999.998,50',
      );
    });
  });

  describe('troco', () => {
    it('lê os formatos digitados pelos apps', () => {
      expect(parseMoneyInput('R$ 50,00')).toBe(50);
      expect(parseMoneyInput('50')).toBe(50);
      expect(parseMoneyInput('50.5')).toBe(50.5);
      expect(parseMoneyInput('1.234,56')).toBe(1234.56);
      expect(parseMoneyInput('1.500')).toBe(1500);
      expect(parseMoneyInput('Sem troco')).toBeNull();
      expect(parseMoneyInput('')).toBeNull();
      expect(parseMoneyInput(undefined)).toBeNull();
    });

    it('guarda o troco no formato "R$ 0,00" somente para dinheiro', () => {
      expect(resolveChangeFor('MONEY', '100', 4590)).toEqual({
        ok: true,
        value: 'R$ 100,00',
      });
      expect(resolveChangeFor('MONEY', 'R$ 45,90', 4590)).toEqual({
        ok: true,
        value: 'R$ 45,90',
      });
      expect(resolveChangeFor('MONEY', 'Sem troco', 4590)).toEqual({
        ok: true,
        value: null,
      });
      expect(resolveChangeFor('MONEY', undefined, 4590)).toEqual({
        ok: true,
        value: null,
      });
      expect(resolveChangeFor('PIX', 'R$ 100,00', 4590)).toEqual({
        ok: true,
        value: null,
      });
      expect(resolveChangeFor('CREDIT_CARD', '100', 4590)).toEqual({
        ok: true,
        value: null,
      });
    });

    it('recusa troco menor que o total', () => {
      const result = resolveChangeFor('MONEY', 'R$ 20,00', 4590);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('R$ 45,90');
    });

    it('troco tem teto: até R$ 200,00 acima do total (a maior cédula)', () => {
      // Pedido de R$ 35,00: até R$ 235,00
      expect(resolveChangeFor('MONEY', 'R$ 235,00', 3500)).toEqual({
        ok: true,
        value: 'R$ 235,00',
      });
      expect(resolveChangeFor('MONEY', 'R$ 200,00', 3500)).toEqual({
        ok: true,
        value: 'R$ 200,00',
      });
      for (const raw of [
        'R$ 235,01',
        'R$ 2.000,00',
        '999999999999999999999999999999',
      ]) {
        const result = resolveChangeFor('MONEY', raw, 3500);
        expect(result).toEqual({
          ok: false,
          message:
            'Valor para troco acima do permitido: informe até R$ 235,00 (no máximo R$ 200,00 acima do total do pedido).',
        });
      }
    });
  });

  describe('o que cada perfil da equipe enxerga', () => {
    const now = new Date('2026-10-24T15:00:00Z');
    const recently = new Date('2026-10-24T10:00:00Z');
    const longAgo = new Date('2026-10-20T10:00:00Z');
    const {
      PENDING,
      PREPARING,
      READY_FOR_PICKUP: READY,
      DELIVERING,
      DONE,
      CANCELED,
    } = OrderStatus;
    const order = (
      status: OrderStatus,
      extra: Partial<{
        type: OrderType;
        driverId: number | null;
        updated_at: Date;
      }> = {},
    ) => ({
      status,
      type: OrderType.DELIVERY,
      driverId: null,
      updated_at: recently,
      ...extra,
    });
    const sees = (role: string, o: ReturnType<typeof order>) =>
      canStaffSeeOrder(o, { id: 30, role }, now);

    it('gestão vê todos; cozinha só preparo; entregador só entregas prontas e as próprias', () => {
      expect(staffOrderScopes('ADMIN')).toBeNull();
      expect(staffOrderScopes('EMPLOYEE')).toBeNull();
      expect(staffOrderScopes('CLIENT')).toEqual([]);
      for (const status of Object.values(OrderStatus)) {
        expect(sees('ADMIN', order(status))).toBe(true);
        expect(sees('EMPLOYEE', order(status, { driverId: 99 }))).toBe(true);
        expect(sees('KITCHEN', order(status))).toBe(
          status === PENDING || status === PREPARING,
        );
        expect(sees('CLIENT', order(status))).toBe(false);
      }

      // Entregador
      expect(sees('COURIER', order(PENDING))).toBe(false);
      expect(sees('COURIER', order(PREPARING))).toBe(false);
      expect(sees('COURIER', order(READY))).toBe(true);
      expect(sees('COURIER', order(READY, { type: OrderType.TAKEOUT }))).toBe(
        false,
      );
      expect(sees('COURIER', order(READY, { driverId: 30 }))).toBe(true);
      expect(sees('COURIER', order(READY, { driverId: 31 }))).toBe(false);
      expect(sees('COURIER', order(DELIVERING, { driverId: 30 }))).toBe(true);
      expect(sees('COURIER', order(DELIVERING, { driverId: 31 }))).toBe(false);
      expect(sees('COURIER', order(DELIVERING))).toBe(false);
      expect(sees('COURIER', order(DONE, { driverId: 30 }))).toBe(true);
      expect(sees('COURIER', order(CANCELED, { driverId: 30 }))).toBe(true);
      expect(
        sees('COURIER', order(DONE, { driverId: 30, updated_at: longAgo })),
      ).toBe(false);
      expect(sees('COURIER', order(DONE, { driverId: 31 }))).toBe(false);
    });

    it('formato do pedido por perfil', () => {
      expect(staffOrderView('ADMIN')).toBe('full');
      expect(staffOrderView('EMPLOYEE')).toBe('full');
      expect(staffOrderView('KITCHEN')).toBe('kitchen');
      expect(staffOrderView('COURIER')).toBe('courier');
    });
  });

  describe('páginas das listas', () => {
    it('padrão: os 100 mais recentes; page/pageSize inteiros dentro dos limites', () => {
      expect(parseListPage(undefined, undefined)).toEqual({
        skip: 0,
        take: 100,
      });
      expect(parseListPage('', '')).toEqual({ skip: 0, take: 100 });
      expect(parseListPage('3', '20')).toEqual({ skip: 40, take: 20 });
      expect(parseListPage('10000', '100')).toEqual({
        skip: 999_900,
        take: 100,
      });
      for (const [page, size] of [
        ['0', undefined],
        ['-1', undefined],
        ['1.5', undefined],
        ['abc', undefined],
        ['10001', undefined],
        [undefined, '0'],
        [undefined, '101'],
        [undefined, '1e2'],
        [['1', '2'], undefined],
        [2, undefined],
      ] as Array<[unknown, unknown]>) {
        expect(parseListPage(page, size)).toBeNull();
      }
      expect(ORDERS_PAGE_INVALID_MESSAGE).toBe(
        'Paginação inválida: use page de 1 a 10000 e pageSize de 1 a 100.',
      );
    });
  });

  describe('perfis', () => {
    it('identifica equipe e gestores do pedido', () => {
      expect(
        ['ADMIN', 'EMPLOYEE', 'KITCHEN', 'COURIER'].every(isStaffRole),
      ).toBe(true);
      expect(isStaffRole('CLIENT')).toBe(false);
      expect(isStaffRole(undefined)).toBe(false);
      expect(isOrderManager('ADMIN')).toBe(true);
      expect(isOrderManager('EMPLOYEE')).toBe(true);
      expect(isOrderManager('KITCHEN')).toBe(false);
      expect(isOrderManager('COURIER')).toBe(false);
    });
  });

  describe('transições de status', () => {
    const change = (
      input: Partial<StatusChangeInput> &
        Pick<StatusChangeInput, 'role' | 'from' | 'to'>,
    ) =>
      checkStatusChange({
        actorId: 10,
        type: DELIVERY,
        driverId: null,
        ...input,
      });

    it('DONE e CANCELED são finais; mudar para o mesmo status é inválido', () => {
      for (const from of [DONE, CANCELED]) {
        for (const to of Object.values(OrderStatus)) {
          expect(isValidTransition(from, to, DELIVERY)).toBe(false);
        }
      }
      expect(isValidTransition(PREPARING, PREPARING, DELIVERY)).toBe(false);
    });

    it('pedido de retirada nunca entra em DELIVERING', () => {
      expect(isValidTransition(READY_FOR_PICKUP, DELIVERING, TAKEOUT)).toBe(
        false,
      );
      expect(isValidTransition(READY_FOR_PICKUP, DONE, TAKEOUT)).toBe(true);
      expect(isValidTransition(READY_FOR_PICKUP, DELIVERING, DELIVERY)).toBe(
        true,
      );
    });

    it('transição impossível → 400 "Transição inválida: X → Y" (para qualquer perfil)', () => {
      for (const role of [
        'ADMIN',
        'EMPLOYEE',
        'KITCHEN',
        'COURIER',
        'CLIENT',
      ]) {
        expect(change({ role, from: DONE, to: PREPARING })).toEqual({
          ok: false,
          status: 400,
          message: 'Transição inválida: DONE → PREPARING',
        });
      }
      expect(
        change({
          role: 'ADMIN',
          from: READY_FOR_PICKUP,
          to: DELIVERING,
          type: TAKEOUT,
        }),
      ).toEqual({
        ok: false,
        status: 400,
        message: 'Transição inválida: READY_FOR_PICKUP → DELIVERING',
      });
    });

    it.each(['ADMIN', 'EMPLOYEE'])(
      '%s pode qualquer transição válida (inclusive voltar etapas, concluir e cancelar)',
      (role) => {
        expect(change({ role, from: PENDING, to: PREPARING }).ok).toBe(true);
        expect(change({ role, from: DELIVERING, to: PENDING }).ok).toBe(true);
        expect(change({ role, from: PENDING, to: DONE }).ok).toBe(true);
        expect(change({ role, from: PREPARING, to: CANCELED }).ok).toBe(true);
        expect(
          change({ role, from: READY_FOR_PICKUP, to: DONE, type: TAKEOUT }).ok,
        ).toBe(true);
      },
    );

    it('cozinha: só PENDING → PREPARING e PREPARING → READY_FOR_PICKUP', () => {
      expect(change({ role: 'KITCHEN', from: PENDING, to: PREPARING })).toEqual(
        { ok: true },
      );
      expect(
        change({ role: 'KITCHEN', from: PREPARING, to: READY_FOR_PICKUP }),
      ).toEqual({ ok: true });
      for (const [from, to] of [
        [READY_FOR_PICKUP, DELIVERING],
        [PREPARING, DONE],
        [PENDING, CANCELED],
        [PREPARING, PENDING],
      ] as const) {
        expect(change({ role: 'KITCHEN', from, to })).toMatchObject({
          ok: false,
          status: 403,
        });
      }
    });

    it('entregador assume um pedido pronto sem responsável', () => {
      expect(
        change({
          role: 'COURIER',
          from: READY_FOR_PICKUP,
          to: DELIVERING,
          driverId: null,
        }),
      ).toEqual({
        ok: true,
        assignDriverId: 10,
      });
      expect(
        change({
          role: 'COURIER',
          from: READY_FOR_PICKUP,
          to: DELIVERING,
          driverId: 10,
        }),
      ).toEqual({ ok: true });
    });

    it('entregador não pega pedido atribuído a outro → 403', () => {
      expect(
        change({
          role: 'COURIER',
          from: READY_FOR_PICKUP,
          to: DELIVERING,
          driverId: 99,
        }),
      ).toMatchObject({
        ok: false,
        status: 403,
      });
    });

    it('entregador conclui apenas as próprias entregas', () => {
      expect(
        change({ role: 'COURIER', from: DELIVERING, to: DONE, driverId: 10 }),
      ).toEqual({ ok: true });
      expect(
        change({ role: 'COURIER', from: DELIVERING, to: DONE, driverId: 99 }),
      ).toMatchObject({ ok: false, status: 403 });
      expect(
        change({ role: 'COURIER', from: DELIVERING, to: DONE, driverId: null }),
      ).toMatchObject({ ok: false, status: 403 });
    });

    it('entregador não mexe nas outras etapas (403) e não leva pedido de retirada (400)', () => {
      expect(
        change({ role: 'COURIER', from: PENDING, to: PREPARING }),
      ).toMatchObject({ ok: false, status: 403 });
      expect(
        change({
          role: 'COURIER',
          from: DELIVERING,
          to: CANCELED,
          driverId: 10,
        }),
      ).toMatchObject({ ok: false, status: 403 });
      expect(
        change({
          role: 'COURIER',
          from: READY_FOR_PICKUP,
          to: DELIVERING,
          type: TAKEOUT,
        }),
      ).toMatchObject({
        ok: false,
        status: 400,
      });
    });

    it('cliente não altera status (403)', () => {
      expect(
        change({ role: 'CLIENT', from: PENDING, to: CANCELED }),
      ).toMatchObject({ ok: false, status: 403 });
    });

    it('concluir pedido sem pagamento online marca como pago', () => {
      expect(shouldMarkPaidOnStatus(DONE, null)).toBe(true);
      expect(shouldMarkPaidOnStatus(DONE, undefined)).toBe(true);
      expect(shouldMarkPaidOnStatus(DONE, '123456')).toBe(false);
      expect(shouldMarkPaidOnStatus(DELIVERING, null)).toBe(false);
      expect(shouldMarkPaidOnStatus(CANCELED, null)).toBe(false);
    });
  });

  describe('cancelamento', () => {
    it('dono cancela apenas enquanto PENDING', () => {
      expect(
        checkCancel({ role: 'CLIENT', isOwner: true, status: PENDING }),
      ).toEqual({ ok: true });
      expect(
        checkCancel({ role: 'CLIENT', isOwner: true, status: PREPARING }),
      ).toMatchObject({ ok: false, status: 400 });
    });

    it('outro cliente ou cozinha/entregador → 403 (antes de olhar o status)', () => {
      expect(
        checkCancel({ role: 'CLIENT', isOwner: false, status: PENDING }),
      ).toMatchObject({ ok: false, status: 403 });
      expect(
        checkCancel({ role: 'CLIENT', isOwner: false, status: DONE }),
      ).toMatchObject({ ok: false, status: 403 });
      expect(
        checkCancel({ role: 'KITCHEN', isOwner: false, status: PENDING }),
      ).toMatchObject({ ok: false, status: 403 });
      expect(
        checkCancel({ role: 'COURIER', isOwner: false, status: DELIVERING }),
      ).toMatchObject({ ok: false, status: 403 });
    });

    it.each(['ADMIN', 'EMPLOYEE'])(
      '%s cancela enquanto o pedido não for final',
      (role) => {
        for (const status of [
          PENDING,
          PREPARING,
          READY_FOR_PICKUP,
          DELIVERING,
        ]) {
          expect(checkCancel({ role, isOwner: false, status })).toEqual({
            ok: true,
          });
        }
        expect(
          checkCancel({ role, isOwner: false, status: DONE }),
        ).toMatchObject({ ok: false, status: 400 });
        expect(
          checkCancel({ role, isOwner: false, status: CANCELED }),
        ).toMatchObject({ ok: false, status: 400 });
      },
    );
  });

  describe('estorno no cancelamento', () => {
    it('só pedidos pagos online (paymentId + PAID) precisam de estorno', () => {
      expect(
        needsRefundOnCancel({
          payment_id: 987,
          payment_status: PaymentStatus.PAID,
        }),
      ).toBe(true);
      expect(
        needsRefundOnCancel({ payment_id: '987', payment_status: 'PAID' }),
      ).toBe(true);
      // Pago na entrega (sem paymentId), pendente, já estornado ou com estorno pendente: não
      expect(
        needsRefundOnCancel({ payment_id: null, payment_status: 'PAID' }),
      ).toBe(false);
      for (const status of [
        PaymentStatus.PENDING,
        PaymentStatus.REFUNDED,
        PaymentStatus.REFUND_PENDING,
        PaymentStatus.FAILED,
      ]) {
        expect(
          needsRefundOnCancel({ payment_id: 987, payment_status: status }),
        ).toBe(false);
      }
    });

    it('estornado → REFUNDED; falhou → REFUND_PENDING', () => {
      expect(paymentStatusAfterRefund(true)).toBe(PaymentStatus.REFUNDED);
      expect(paymentStatusAfterRefund(false)).toBe(
        PaymentStatus.REFUND_PENDING,
      );
    });
  });

  describe('GET /orders?scope=active', () => {
    const now = new Date('2026-10-11T12:00:00Z');

    it('lê o parâmetro: ausente = todos; "active"; outro valor = inválido', () => {
      expect(parseOrdersScope(undefined)).toBe('all');
      expect(parseOrdersScope('')).toBe('all');
      expect(parseOrdersScope('active')).toBe('active');
      expect(parseOrdersScope('ACTIVE')).toBeNull();
      expect(parseOrdersScope(['active'])).toBeNull();
    });

    it('em andamento sempre; concluídos/cancelados só nas últimas 24 h', () => {
      expect(activeScopeSince(now).toISOString()).toBe(
        '2026-10-10T12:00:00.000Z',
      );
      const old = new Date('2026-10-01T00:00:00Z');
      expect(isInActiveScope({ status: PENDING, updated_at: old }, now)).toBe(
        true,
      );
      expect(
        isInActiveScope({ status: DELIVERING, updated_at: old }, now),
      ).toBe(true);
      expect(isInActiveScope({ status: DONE, updated_at: old }, now)).toBe(
        false,
      );
      expect(
        isInActiveScope(
          { status: CANCELED, updated_at: '2026-10-10T13:00:00Z' },
          now,
        ),
      ).toBe(true);
      expect(
        isInActiveScope(
          { status: DONE, updated_at: '2026-10-10T11:59:59Z' },
          now,
        ),
      ).toBe(false);
    });

    it('estorno pendente fica no quadro de qualquer data, até a equipe resolver', () => {
      const old = new Date('2026-09-01T00:00:00Z');
      expect(
        isInActiveScope(
          {
            status: CANCELED,
            updated_at: old,
            payment_status: PaymentStatus.REFUND_PENDING,
          },
          now,
        ),
      ).toBe(true);
      expect(
        isInActiveScope(
          {
            status: CANCELED,
            updated_at: old,
            payment_status: PaymentStatus.REFUNDED,
          },
          now,
        ),
      ).toBe(false);
    });
  });

  describe('dias no fuso da loja', () => {
    it('STORE_TIME_ZONE válido vale; vazio ou inválido → America/Sao_Paulo', () => {
      expect(storeTimeZone({})).toBe(DEFAULT_STORE_TIME_ZONE);
      expect(storeTimeZone({ STORE_TIME_ZONE: 'America/Manaus' })).toBe(
        'America/Manaus',
      );
      expect(storeTimeZone({ STORE_TIME_ZONE: 'Lua/Base' })).toBe(
        'America/Sao_Paulo',
      );
    });

    it('o dia é o do calendário da loja (23:30 em São Paulo ainda é o dia anterior ao de UTC)', () => {
      const lateNight = new Date('2026-10-11T02:30:00Z');
      expect(dayKeyInZone(lateNight, 'America/Sao_Paulo')).toBe('10/10');
      expect(dayKeyInZone(lateNight, 'UTC')).toBe('11/10');
    });

    it('últimos 7 dias até hoje (inclusive na virada do mês) e uma janela de busca que cobre todos', () => {
      const now = new Date('2026-10-02T02:00:00Z'); // 01/10 23:00 em São Paulo
      const days = lastDayKeys(now, 'America/Sao_Paulo', 7);
      expect(days).toEqual([
        '25/09',
        '26/09',
        '27/09',
        '28/09',
        '29/09',
        '30/09',
        '01/10',
      ]);
      const start = chartWindowStart(now, 'America/Sao_Paulo', 7);
      // 25/09 00:00 em São Paulo = 25/09 03:00 UTC: a janela começa antes
      expect(start.getTime()).toBeLessThan(
        new Date('2026-09-25T03:00:00Z').getTime(),
      );
      expect(dayKeyInZone(start, 'America/Sao_Paulo')).toBe('24/09');
    });
  });

  describe('atribuição de entregador', () => {
    it('somente delivery em PREPARING, READY_FOR_PICKUP ou DELIVERING', () => {
      for (const status of [PREPARING, READY_FOR_PICKUP, DELIVERING]) {
        expect(checkAssign({ status, type: DELIVERY })).toEqual({ ok: true });
      }
      for (const status of [PENDING, DONE, CANCELED]) {
        expect(checkAssign({ status, type: DELIVERY })).toMatchObject({
          ok: false,
          status: 400,
        });
      }
      expect(
        checkAssign({ status: READY_FOR_PICKUP, type: TAKEOUT }),
      ).toMatchObject({ ok: false, status: 400 });
    });
  });

  describe('operação da loja', () => {
    const both = { delivery_enabled: true, takeout_enabled: true };

    it('entrega ou retirada desligada na loja → mensagem do 400 (só "true" libera)', () => {
      expect(orderTypeUnavailableMessage(DELIVERY, both)).toBeNull();
      expect(orderTypeUnavailableMessage(TAKEOUT, both)).toBeNull();
      expect(
        orderTypeUnavailableMessage(DELIVERY, {
          ...both,
          delivery_enabled: false,
        }),
      ).toBe(DELIVERY_DISABLED_MESSAGE);
      expect(
        orderTypeUnavailableMessage(TAKEOUT, {
          ...both,
          takeout_enabled: false,
        }),
      ).toBe(TAKEOUT_DISABLED_MESSAGE);
      // A outra modalidade continua valendo
      expect(
        orderTypeUnavailableMessage(TAKEOUT, {
          ...both,
          delivery_enabled: false,
        }),
      ).toBeNull();
      // Configuração ausente: falha fechada
      expect(orderTypeUnavailableMessage(DELIVERY, {})).toBe(
        DELIVERY_DISABLED_MESSAGE,
      );
    });

    it('zonas da loja substituem as da plataforma; sem zonas próprias valem as da plataforma', () => {
      const own = {
        fallback: { fee: 9, time: '40-50 min' },
        zones: [{ neighborhoods: ['Pinheiros'], fee: 6.5, time: '20-30 min' }],
      };
      const resolved = storeDeliveryZones(own, DEFAULT_DELIVERY_ZONES);
      expect(resolved.error).toBeUndefined();
      expect(deliveryEstimate('pinheiros', null, resolved.config)).toEqual({
        fee: 6.5,
        time: '20-30 min',
      });
      // Bairro da plataforma não vale para a loja com zonas próprias
      expect(deliveryEstimate('Centro', null, resolved.config)).toEqual({
        fee: 9,
        time: '40-50 min',
      });

      expect(storeDeliveryZones(null, DEFAULT_DELIVERY_ZONES)).toEqual({
        config: DEFAULT_DELIVERY_ZONES,
      });
      expect(storeDeliveryZones(undefined, DEFAULT_DELIVERY_ZONES)).toEqual({
        config: DEFAULT_DELIVERY_ZONES,
      });
    });

    it('zonas da loja sem "fallback" usam o da plataforma; zonas inválidas no banco → as da plataforma com o motivo', () => {
      const partial = storeDeliveryZones(
        { zones: [{ neighborhoods: ['Moema'], fee: 3, time: '15 min' }] },
        DEFAULT_DELIVERY_ZONES,
      );
      expect(partial.config.fallback).toEqual(DEFAULT_DELIVERY_ZONES.fallback);

      const broken = storeDeliveryZones(
        { zones: [{ neighborhoods: [], fee: -1 }] },
        DEFAULT_DELIVERY_ZONES,
      );
      expect(broken.config).toBe(DEFAULT_DELIVERY_ZONES);
      expect(broken.error).toEqual(expect.any(String));
    });

    it('prazo da retirada: o da loja ou o padrão (sempre sem taxa)', () => {
      expect(takeoutEstimateFor('10-15 min')).toEqual({
        fee: 0,
        time: '10-15 min',
      });
      expect(takeoutEstimateFor('  ')).toEqual(TAKEOUT_ESTIMATE);
      expect(takeoutEstimateFor(null)).toEqual(TAKEOUT_ESTIMATE);
      expect(takeoutEstimateFor(undefined)).toEqual(TAKEOUT_ESTIMATE);
    });

    it('pedidos próximos: mesmo bairro (nome inteiro) e, quando informada, a mesma cidade', () => {
      const centro = { neighborhood: 'Centro', city: 'Rio de Janeiro' };
      expect(
        isSameDeliveryArea(centro, {
          neighborhood: ' centro ',
          city: 'rio de janeiro',
        }),
      ).toBe(true);
      expect(isSameDeliveryArea(centro, { neighborhood: 'Centro' })).toBe(true);
      expect(
        isSameDeliveryArea(centro, {
          neighborhood: 'Centro',
          city: 'Niterói',
        }),
      ).toBe(false);
      expect(
        isSameDeliveryArea(centro, { neighborhood: 'Centro Histórico' }),
      ).toBe(false);
      expect(isSameDeliveryArea(centro, null)).toBe(false);
      expect(
        isSameDeliveryArea({ neighborhood: '' }, { neighborhood: '' }),
      ).toBe(false);
    });
  });

  describe('fuso da loja e períodos dos relatórios', () => {
    it('fuso da loja válido vale; vazio ou inválido → America/Sao_Paulo', () => {
      expect(resolveTimeZone('America/Manaus')).toBe('America/Manaus');
      expect(resolveTimeZone(' Asia/Tokyo ')).toBe('Asia/Tokyo');
      for (const invalid of [null, undefined, '', 'Lua/Base'])
        expect(resolveTimeZone(invalid)).toBe(DEFAULT_STORE_TIME_ZONE);
    });

    it('datas AAAA-MM-DD no calendário da loja e somas de dias (virada de mês e de ano)', () => {
      const lateNight = new Date('2026-10-11T02:30:00Z');
      expect(dateKeyInZone(lateNight, 'America/Sao_Paulo')).toBe('2026-10-10');
      expect(dateKeyInZone(lateNight, 'UTC')).toBe('2026-10-11');
      expect(addDaysToKey('2026-12-31', 1)).toBe('2027-01-01');
      expect(addDaysToKey('2024-03-01', -1)).toBe('2024-02-29');
      expect(dateKeysBetween('2026-09-29', '2026-10-02')).toEqual([
        '2026-09-29',
        '2026-09-30',
        '2026-10-01',
        '2026-10-02',
      ]);
      expect(dateKeysBetween('2026-10-02', '2026-10-01')).toEqual([]);
    });

    it('meia-noite no fuso da loja (inclusive na troca de horário de verão)', () => {
      expect(
        startOfDayInZone('2026-10-01', 'America/Sao_Paulo').toISOString(),
      ).toBe('2026-10-01T03:00:00.000Z');
      expect(startOfDayInZone('2026-10-01', 'Asia/Tokyo').toISOString()).toBe(
        '2026-09-30T15:00:00.000Z',
      );
      // Nova York: 08/03/2026 começa em EST (UTC−5); 09/03 já em EDT (UTC−4)
      expect(
        startOfDayInZone('2026-03-08', 'America/New_York').toISOString(),
      ).toBe('2026-03-08T05:00:00.000Z');
      expect(
        startOfDayInZone('2026-03-09', 'America/New_York').toISOString(),
      ).toBe('2026-03-09T04:00:00.000Z');
    });

    // Referência sem cache (o cálculo de antes): um formatador novo por instante
    const referenceDateKey = (date: Date, timeZone: string) => {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(date);
      const part = (type: string) =>
        parts.find((item) => item.type === type)?.value;
      return `${part('year')}-${part('month')}-${part('day')}`;
    };

    it('o cache de fusos dá o mesmo dia do cálculo direto, inclusive nas trocas de horário (30 min e 45 min)', () => {
      const zones = [
        'America/Sao_Paulo',
        'America/New_York',
        'Australia/Lord_Howe', // horário de verão de 30 min, trocado no meio da hora UTC
        'Asia/Kathmandu', // UTC+5:45
        'Pacific/Chatham', // UTC+12:45 / +13:45
        'Europe/London',
        'UTC',
      ];
      // A cada 7 min e 13 s por ~2 anos (inclui 2018, quando São Paulo ainda tinha horário de verão)
      const instants: Date[] = [];
      for (
        let time = Date.UTC(2018, 9, 1);
        time < Date.UTC(2019, 2, 1);
        time += 433_000
      )
        instants.push(new Date(time));
      for (
        let time = Date.UTC(2026, 2, 1);
        time < Date.UTC(2026, 11, 1);
        time += 433_000
      )
        instants.push(new Date(time));
      // Os segundos em volta das trocas de horário de 2026
      for (const edge of [
        '2026-03-08T07:00:00Z', // Nova York
        '2026-11-01T06:00:00Z', // Nova York
        '2026-04-04T15:00:00Z', // Lord Howe (02:00 → 01:30)
        '2026-10-03T15:30:00Z', // Lord Howe (02:00 → 02:30)
        '2026-03-29T01:00:00Z', // Londres
      ]) {
        const base = new Date(edge).getTime();
        for (let delta = -2_000; delta <= 2_000; delta += 500)
          instants.push(new Date(base + delta));
      }

      for (const zone of zones) {
        const mismatches = instants.filter(
          (date) => dateKeyInZone(date, zone) !== referenceDateKey(date, zone),
        );
        expect({ zone, mismatches }).toEqual({ zone, mismatches: [] });
      }
      // O formato "dd/MM" do gráfico sai do mesmo cálculo
      const sample = new Date('2026-04-04T15:20:00Z');
      const [, month, day] = referenceDateKey(
        sample,
        'Australia/Lord_Howe',
      ).split('-');
      expect(dayKeyInZone(sample, 'Australia/Lord_Howe')).toBe(
        `${day}/${month}`,
      );
    });

    it('converter 200 mil pedidos não formata instante a instante (antes: um Intl.DateTimeFormat novo por pedido, ~20 s)', () => {
      // Contagem determinística (não depende da carga da máquina): o Intl só é chamado nas horas
      // novas (2 vezes por hora UTC conferida), não a cada pedido
      const formatToParts = jest.spyOn(
        Intl.DateTimeFormat.prototype,
        'formatToParts',
      );
      try {
        const base = Date.UTC(2025, 10, 1);
        const keys = new Set<string>();
        // ~1 ano (200 mil instantes a cada 157 s) num fuso ainda não usado nos outros testes
        for (let index = 0; index < 200_000; index++)
          keys.add(
            dateKeyInZone(new Date(base + index * 157_000), 'America/Manaus'),
          );
        expect(keys.size).toBeGreaterThan(360);
        const hours = Math.ceil((200_000 * 157_000) / 3_600_000) + 1;
        expect(formatToParts.mock.calls.length).toBeLessThanOrEqual(
          2 * hours + 10,
        );
        expect(formatToParts.mock.calls.length).toBeLessThan(20_000);
      } finally {
        formatToParts.mockRestore();
      }
    });

    it('instante inválido continua sendo erro (como antes)', () => {
      expect(() =>
        dateKeyInZone(new Date('invalida'), 'America/Sao_Paulo'),
      ).toThrow(RangeError);
    });

    it('período do relatório: padrão dos últimos 30 dias; só "from" vai até hoje; só "to" pega os 30 dias até ele', () => {
      // 11/10 02:00 UTC = 10/10 23:00 em São Paulo: "hoje" é 10/10 na loja
      const now = new Date('2026-10-11T02:00:00Z');
      const zone = 'America/Sao_Paulo';
      expect(parseReportRange(undefined, undefined, now, zone)).toEqual({
        ok: true,
        from: '2026-09-11',
        to: '2026-10-10',
        days: 30,
      });
      expect(parseReportRange('2026-10-01', '', now, zone)).toEqual({
        ok: true,
        from: '2026-10-01',
        to: '2026-10-10',
        days: 10,
      });
      expect(parseReportRange(null, '2026-03-31', now, zone)).toEqual({
        ok: true,
        from: '2026-03-02',
        to: '2026-03-31',
        days: 30,
      });
      expect(parseReportRange('2026-10-05', '2026-10-05', now, zone)).toEqual({
        ok: true,
        from: '2026-10-05',
        to: '2026-10-05',
        days: 1,
      });
    });

    it('período do relatório: até 366 dias (ano bissexto inteiro); formato, datas inexistentes e ordem errada → erro', () => {
      const now = new Date('2026-10-11T12:00:00Z');
      const zone = 'America/Sao_Paulo';
      expect(
        parseReportRange('2024-01-01', '2024-12-31', now, zone),
      ).toMatchObject({ ok: true, days: REPORT_MAX_DAYS });
      expect(parseReportRange('2024-01-01', '2025-01-01', now, zone)).toEqual({
        ok: false,
        message: `O período do relatório pode ter no máximo ${REPORT_MAX_DAYS} dias.`,
      });
      expect(parseReportRange('2026-10-05', '2026-10-01', now, zone)).toEqual({
        ok: false,
        message:
          'A data inicial (from) não pode ser depois da data final (to).',
      });
      for (const [from, to] of [
        ['2026-02-30', '2026-03-01'],
        ['01/10/2026', '2026-10-02'],
        ['2026-10-01', '2026-10-1'],
        [['2026-10-01'], '2026-10-02'],
        [20261001, '2026-10-02'],
      ] as [unknown, unknown][]) {
        const range = parseReportRange(from, to, now, zone);
        expect(range.ok).toBe(false);
        if (!range.ok) expect(range.message).toContain('AAAA-MM-DD');
      }
    });
  });
});
