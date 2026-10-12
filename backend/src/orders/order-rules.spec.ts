import { OrderStatus, OrderType, PaymentStatus } from './order.enums';
import {
  DEFAULT_STORE_TIME_ZONE,
  MAX_MONEY_CENTS,
  activeScopeSince,
  chartWindowStart,
  checkAssign,
  checkCancel,
  checkStatusChange,
  countAddonIds,
  dayKeyInZone,
  deliveryEstimate,
  effectiveUnitPriceCents,
  formatBRL,
  fromCents,
  isInActiveScope,
  isOrderManager,
  isStaffRole,
  isValidTransition,
  lastDayKeys,
  needsRefundOnCancel,
  orderTotalLimitError,
  parseDeliveryZones,
  parseMoneyInput,
  parseOrdersScope,
  paymentStatusAfterRefund,
  priceLine,
  resolveChangeFor,
  resolveDeliveryZones,
  shouldMarkPaidOnStatus,
  storeTimeZone,
  toCents,
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
});
