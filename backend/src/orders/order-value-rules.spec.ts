import { parseStoreDeliveryZones } from '../store/store-rules';
import {
  NO_PUBLIC_ORDER_RULES,
  applyOrderRules,
  orderBelowMinimumMessage,
  orderRulesQuoteFields,
  parseDeliveryZones,
  parseOrderValueRules,
  parseStoreOrderValueRules,
  publicOrderRules,
} from './order-rules';
import { OrderType } from './order.enums';
import { parseStoreDeliverySettings } from './store-delivery-settings';

const DELIVERY = OrderType.DELIVERY;
const TAKEOUT = OrderType.TAKEOUT;

/** Taxa de R$ 7,00 numa entrega com o subtotal informado (centavos). */
const deliveryOf = (subtotalCents: number, feeCents = 700) => ({
  type: DELIVERY,
  subtotalCents,
  feeCents,
});

describe('pedido mínimo e frete grátis (regra pura)', () => {
  describe('applyOrderRules', () => {
    it('sem regras (o padrão): a taxa fica como está e nada é informado', () => {
      for (const store of [undefined, null, {}]) {
        expect(applyOrderRules(deliveryOf(1000), store, null)).toEqual({
          feeCents: 700,
          originalFeeCents: 700,
          freeDeliveryApplied: false,
          freeDeliveryThresholdCents: null,
          missingForFreeDeliveryCents: null,
          minOrderCents: null,
          missingForMinOrderCents: null,
        });
      }
      expect(
        applyOrderRules({ type: TAKEOUT, subtotalCents: 1000, feeCents: 0 }),
      ).toMatchObject({ feeCents: 0, minOrderCents: null });
    });

    it('pedido mínimo: limites exatos em centavos (abaixo falta, igual passa)', () => {
      const store = { min_order: 30 };
      expect(applyOrderRules(deliveryOf(2590), store)).toMatchObject({
        minOrderCents: 3000,
        missingForMinOrderCents: 410,
      });
      expect(applyOrderRules(deliveryOf(2999), store)).toMatchObject({
        missingForMinOrderCents: 1,
      });
      expect(applyOrderRules(deliveryOf(3000), store)).toMatchObject({
        missingForMinOrderCents: 0,
      });
      expect(applyOrderRules(deliveryOf(3001), store)).toMatchObject({
        missingForMinOrderCents: 0,
      });
      // O mínimo nunca mexe na taxa
      expect(applyOrderRules(deliveryOf(100), store).feeCents).toBe(700);
    });

    it('frete grátis: a partir do valor (inclusive) zera a taxa; abaixo, informa quanto falta', () => {
      const store = { free_delivery_above: 50 };
      expect(applyOrderRules(deliveryOf(4999), store)).toEqual({
        feeCents: 700,
        originalFeeCents: 700,
        freeDeliveryApplied: false,
        freeDeliveryThresholdCents: 5000,
        missingForFreeDeliveryCents: 1,
        minOrderCents: null,
        missingForMinOrderCents: null,
      });
      expect(applyOrderRules(deliveryOf(5000), store)).toEqual({
        feeCents: 0,
        originalFeeCents: 700,
        freeDeliveryApplied: true,
        freeDeliveryThresholdCents: 5000,
        missingForFreeDeliveryCents: 0,
        minOrderCents: null,
        missingForMinOrderCents: null,
      });
    });

    it('valores quebrados (29,90) e a taxa da zona (6,50) em centavos exatos', () => {
      const outcome = applyOrderRules(deliveryOf(2989, 650), {
        min_order: 29.9,
        free_delivery_above: 29.9,
      });
      expect(outcome).toMatchObject({
        feeCents: 650,
        minOrderCents: 2990,
        missingForMinOrderCents: 1,
        missingForFreeDeliveryCents: 1,
      });
      expect(
        applyOrderRules(deliveryOf(2990, 650), { free_delivery_above: 29.9 }),
      ).toMatchObject({ feeCents: 0, freeDeliveryApplied: true });
    });

    it('a zona sobrescreve a loja; o que a zona não informa herda o da loja', () => {
      const store = { min_order: 30, free_delivery_above: 50 };
      expect(
        applyOrderRules(deliveryOf(4500), store, {
          min_order: 40,
          free_delivery_above: 80,
        }),
      ).toMatchObject({
        minOrderCents: 4000,
        missingForMinOrderCents: 0,
        freeDeliveryThresholdCents: 8000,
        missingForFreeDeliveryCents: 3500,
        feeCents: 700,
      });
      // Zona vazia ({}) ou sem zona (null, fora das zonas) → os da loja
      for (const area of [{}, null, undefined]) {
        expect(applyOrderRules(deliveryOf(5000), store, area)).toMatchObject({
          minOrderCents: 3000,
          freeDeliveryThresholdCents: 5000,
          feeCents: 0,
        });
      }
      // Só um dos dois na zona
      expect(
        applyOrderRules(deliveryOf(2000), store, { min_order: 15 }),
      ).toMatchObject({
        minOrderCents: 1500,
        missingForMinOrderCents: 0,
        freeDeliveryThresholdCents: 5000,
      });
    });

    it('zona com 0: sem mínimo nesta zona / frete sempre grátis nesta zona', () => {
      const store = { min_order: 30, free_delivery_above: 50 };
      expect(
        applyOrderRules(deliveryOf(1000), store, {
          min_order: 0,
          free_delivery_above: 0,
        }),
      ).toMatchObject({
        minOrderCents: null,
        missingForMinOrderCents: null,
        feeCents: 0,
        freeDeliveryApplied: true,
        freeDeliveryThresholdCents: 0,
      });
    });

    it('zona sem taxa: não há frete grátis a conquistar (nada falta, nada é "aplicado")', () => {
      expect(
        applyOrderRules(deliveryOf(1000, 0), { free_delivery_above: 50 }),
      ).toMatchObject({
        feeCents: 0,
        originalFeeCents: 0,
        freeDeliveryApplied: false,
        freeDeliveryThresholdCents: 5000,
        missingForFreeDeliveryCents: null,
      });
    });

    it('retirada: mínimo só com min_order_takeout (e sempre o da loja); nunca frete grátis', () => {
      const pickup = { type: TAKEOUT, subtotalCents: 2000, feeCents: 0 };
      const zone = { min_order: 99, free_delivery_above: 1 };
      expect(
        applyOrderRules(
          pickup,
          { min_order: 30, free_delivery_above: 10 },
          zone,
        ),
      ).toEqual({
        feeCents: 0,
        originalFeeCents: 0,
        freeDeliveryApplied: false,
        freeDeliveryThresholdCents: null,
        missingForFreeDeliveryCents: null,
        minOrderCents: null,
        missingForMinOrderCents: null,
      });
      expect(
        applyOrderRules(
          pickup,
          { min_order: 30, min_order_takeout: true },
          zone,
        ),
      ).toMatchObject({ minOrderCents: 3000, missingForMinOrderCents: 1000 });
    });
  });

  it('mensagem do 400 ORDER_BELOW_MINIMUM (entrega e retirada)', () => {
    expect(orderBelowMinimumMessage(DELIVERY, 3000, 410)).toBe(
      'O pedido mínimo desta loja para entrega é R$ 30,00. Faltam R$ 4,10.',
    );
    expect(orderBelowMinimumMessage(TAKEOUT, 123456, 1)).toBe(
      'O pedido mínimo desta loja para retirada é R$ 1.234,56. Faltam R$ 0,01.',
    );
  });

  it('campos do orçamento em reais', () => {
    expect(
      orderRulesQuoteFields(
        applyOrderRules(deliveryOf(5000), {
          min_order: 30,
          free_delivery_above: 50,
        }),
      ),
    ).toEqual({
      delivery_fee: 0,
      delivery_fee_original: 7,
      free_delivery_applied: true,
      free_delivery_threshold: 50,
      missing_for_free_delivery: 0,
      min_order_value: 30,
      missing_for_min_order: 0,
    });
    expect(orderRulesQuoteFields(applyOrderRules(deliveryOf(1)))).toEqual({
      delivery_fee: 7,
      delivery_fee_original: 7,
      free_delivery_applied: false,
      free_delivery_threshold: null,
      missing_for_free_delivery: null,
      min_order_value: null,
      missing_for_min_order: null,
    });
  });
});

describe('pedido mínimo e frete grátis (configuração)', () => {
  it('por zona: ausente ou null herda; números normalizados em centavos; 0 vale', () => {
    expect(parseOrderValueRules({}, 'da zona 1')).toEqual({});
    expect(
      parseOrderValueRules(
        { min_order: null, free_delivery_above: undefined },
        'da zona 1',
      ),
    ).toEqual({});
    expect(
      parseOrderValueRules(
        { min_order: 29.999, free_delivery_above: 0 },
        'da zona 1',
      ),
    ).toEqual({ min_order: 30, free_delivery_above: 0 });
  });

  it.each([
    [{ min_order: -1 }, '"min_order" da zona 2'],
    [{ min_order: '30' }, '"min_order" da zona 2'],
    [{ free_delivery_above: Number.NaN }, '"free_delivery_above" da zona 2'],
    [{ free_delivery_above: 100_000_000 }, '"free_delivery_above" da zona 2'],
    [{ free_delivery_above: true }, '"free_delivery_above" da zona 2'],
  ])('valor inválido %j → erro claro', (raw, field) => {
    expect(() => parseOrderValueRules(raw, 'da zona 2')).toThrow(
      `${field} precisa ser um valor em reais de 0 a 99999999.99 (ex.: 30 ou 29.9).`,
    );
  });

  it('da loja: mínimo 0 = sem mínimo; "vale na retirada" só com um mínimo', () => {
    expect(parseStoreOrderValueRules({})).toEqual({});
    expect(parseStoreOrderValueRules(null)).toEqual({});
    expect(
      parseStoreOrderValueRules({ min_order: 0, min_order_takeout: true }),
    ).toEqual({});
    expect(
      parseStoreOrderValueRules({
        min_order: 30,
        free_delivery_above: 60,
        min_order_takeout: true,
      }),
    ).toEqual({
      min_order: 30,
      free_delivery_above: 60,
      min_order_takeout: true,
    });
    expect(
      parseStoreOrderValueRules({ min_order: 30, min_order_takeout: false }),
    ).toEqual({ min_order: 30 });
    expect(() =>
      parseStoreOrderValueRules({ min_order: 30, min_order_takeout: 'sim' }),
    ).toThrow('"min_order_takeout" deve ser true');
    expect(() => parseStoreOrderValueRules({ min_order: -5 })).toThrow(
      '"min_order" da loja',
    );
  });

  it('parseDeliveryZones guarda as regras da loja e das zonas; sem elas, o mesmo formato de antes', () => {
    const plain = {
      fallback: { fee: 10, time: '50 min' },
      zones: [{ neighborhoods: ['Centro'], fee: 5, time: '30 min' }],
    };
    expect(parseDeliveryZones(plain)).toEqual({
      fallback: { fee: 10, time: '50 min' },
      zones: [{ neighborhoods: ['Centro'], fee: 5, time: '30 min' }],
    });
    expect(
      parseDeliveryZones({
        ...plain,
        min_order: 25,
        free_delivery_above: 70,
        zones: [
          {
            neighborhoods: ['Centro'],
            fee: 5,
            time: '30 min',
            min_order: 0,
            free_delivery_above: 40.5,
          },
        ],
      }),
    ).toEqual({
      fallback: { fee: 10, time: '50 min' },
      min_order: 25,
      free_delivery_above: 70,
      zones: [
        {
          neighborhoods: ['Centro'],
          fee: 5,
          time: '30 min',
          min_order: 0,
          free_delivery_above: 40.5,
        },
      ],
    });
    expect(() =>
      parseDeliveryZones({
        ...plain,
        zones: [{ ...plain.zones[0], min_order: -1 }],
      }),
    ).toThrow('"min_order" da zona 1');
  });

  describe('PATCH /store/settings (delivery_zones): parseStoreDeliverySettings', () => {
    const base = {
      fallback: { fee: 10, time: '50 min' },
      zones: [{ neighborhoods: ['Centro'], fee: 5, time: '30 min' }],
    };

    it('sem regras: exatamente o que as zonas já gravavam (o padrão não muda)', () => {
      expect(parseStoreDeliverySettings(base)).toEqual(
        parseStoreDeliveryZones(base),
      );
      expect(parseStoreDeliverySettings(null)).toBeNull();
      expect(parseStoreDeliverySettings(undefined)).toBeNull();
    });

    it('guarda as regras da loja e das zonas; aplicar de novo dá o mesmo resultado (também em texto JSON)', () => {
      const input = {
        ...base,
        min_order: 30,
        free_delivery_above: 80,
        min_order_takeout: true,
        zones: [{ ...base.zones[0], free_delivery_above: 50 }],
      };
      const parsed = parseStoreDeliverySettings(input);
      expect(parsed).toEqual({
        fallback: { fee: 10, time: '50 min' },
        zones: [
          {
            neighborhoods: ['Centro'],
            fee: 5,
            time: '30 min',
            free_delivery_above: 50,
          },
        ],
        min_order: 30,
        free_delivery_above: 80,
        min_order_takeout: true,
      });
      expect(parseStoreDeliverySettings(parsed)).toEqual(parsed);
      expect(parseStoreDeliverySettings(JSON.stringify(input))).toEqual(parsed);
    });

    it('valor inválido → erro (vira 400 "Zonas de entrega inválidas: ...")', () => {
      expect(() =>
        parseStoreDeliverySettings({ ...base, free_delivery_above: -1 }),
      ).toThrow('"free_delivery_above" da loja');
      expect(() =>
        parseStoreDeliverySettings({
          ...base,
          zones: [{ ...base.zones[0], min_order: 'muito' }],
        }),
      ).toThrow('"min_order" da zona 1');
      // As regras das zonas continuam sujeitas às regras de sempre
      expect(() =>
        parseStoreDeliverySettings({ zones: [], min_order: 20 }),
      ).toThrow('fallback');
    });
  });

  describe('perfil público (vitrine)', () => {
    it('sem zonas próprias, JSON inválido ou nada configurado → nada', () => {
      expect(publicOrderRules(null)).toEqual(NO_PUBLIC_ORDER_RULES);
      expect(publicOrderRules('texto')).toEqual(NO_PUBLIC_ORDER_RULES);
      expect(publicOrderRules({ zones: [], min_order: -3 })).toEqual(
        NO_PUBLIC_ORDER_RULES,
      );
      expect(
        publicOrderRules({ zones: [{ neighborhoods: ['Centro'] }] }),
      ).toEqual(NO_PUBLIC_ORDER_RULES);
    });

    it('as regras da loja e se alguma zona muda os valores', () => {
      const config = {
        fallback: { fee: 9, time: '40 min' },
        min_order: 25,
        free_delivery_above: 60,
        min_order_takeout: true,
        zones: [
          { neighborhoods: ['A'], fee: 5, time: '30 min', min_order: 25 },
          { neighborhoods: ['B'], fee: 5, time: '30 min' },
        ],
      };
      expect(publicOrderRules(config)).toEqual({
        min_order: 25,
        min_order_takeout: true,
        free_delivery_above: 60,
        varies_by_zone: false,
      });
      expect(
        publicOrderRules({
          ...config,
          zones: [{ ...config.zones[1], free_delivery_above: 90 }],
        }).varies_by_zone,
      ).toBe(true);
      // Zona com mínimo próprio numa loja sem mínimo
      expect(
        publicOrderRules({
          fallback: { fee: 9, time: '40 min' },
          zones: [{ ...config.zones[1], min_order: 15 }],
        }),
      ).toEqual({
        min_order: null,
        min_order_takeout: false,
        free_delivery_above: null,
        varies_by_zone: true,
      });
    });
  });
});
