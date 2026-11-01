import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { ParsePaymentIdPipe } from '../../payment/parse-payment-id.pipe';
import { CreatePixPaymentDto } from '../../payment/dto/create-payment.dto';
import { AssignDriverDto } from './assign-driver.dto';
import { CreateOrderDto, QuoteOrderDto } from './create-order.dto';

const MAX_INT = 2_147_483_647;
const OUT_OF_RANGE = 99_999_999_999;

/** Caminhos dos campos com erro (inclui os itens aninhados: "items.0.productId"). */
function failedPaths(errors: ValidationError[], parent = ''): string[] {
  return errors.flatMap((error) => {
    const path = parent ? `${parent}.${error.property}` : error.property;
    return [
      ...(error.constraints ? [path] : []),
      ...failedPaths(error.children ?? [], path),
    ];
  });
}

async function errorsOf<T extends object>(
  type: new () => T,
  body: object,
): Promise<string[]> {
  return failedPaths(await validate(plainToInstance(type, body)));
}

/** Mensagens de erro (inclui as dos itens aninhados). */
function messagesOf(errors: ValidationError[]): string[] {
  return errors.flatMap((error) => [
    ...Object.values(error.constraints ?? {}),
    ...messagesOf(error.children ?? []),
  ]);
}

describe('limites dos ids (400 em vez de erro 500 do Postgres)', () => {
  const item = (extra: object = {}) => ({
    productId: 1,
    quantity: 1,
    ...extra,
  });

  it('productId, addonIds e addressId acima do integer do Postgres são recusados', async () => {
    expect(
      await errorsOf(QuoteOrderDto, {
        items: [item({ productId: OUT_OF_RANGE })],
        type: 'TAKEOUT',
      }),
    ).toEqual(['items.0.productId']);
    expect(
      await errorsOf(QuoteOrderDto, {
        items: [item({ addonIds: [3, OUT_OF_RANGE] })],
        type: 'TAKEOUT',
      }),
    ).toEqual(['items.0.addonIds']);
    expect(
      await errorsOf(QuoteOrderDto, {
        items: [item()],
        type: 'DELIVERY',
        addressId: OUT_OF_RANGE,
      }),
    ).toEqual(['addressId']);
    expect(
      await errorsOf(QuoteOrderDto, {
        items: [item()],
        type: 'DELIVERY',
        addressId: 0,
      }),
    ).toEqual(['addressId']);
  });

  it('fora do intervalo a mensagem é "Id inválido."; tipo errado explica o formato', async () => {
    const outOfRange = await validate(
      plainToInstance(QuoteOrderDto, {
        items: [item({ productId: OUT_OF_RANGE, addonIds: [0] })],
        type: 'DELIVERY',
        addressId: -1,
      }),
    );
    expect(messagesOf(outOfRange)).toEqual([
      'Id inválido.',
      'Id inválido.',
      'Id inválido.',
    ]);

    const wrongType = await validate(
      plainToInstance(QuoteOrderDto, {
        items: [item({ productId: 1.5, addonIds: ['3'] })],
        type: 'TAKEOUT',
      }),
    );
    expect(messagesOf(wrongType).sort()).toEqual([
      'addonIds deve conter apenas números inteiros.',
      'productId deve ser um número inteiro.',
    ]);
  });

  it('o maior integer ainda é aceito', async () => {
    expect(
      await errorsOf(QuoteOrderDto, {
        items: [item({ productId: MAX_INT, addonIds: [MAX_INT] })],
        type: 'DELIVERY',
        addressId: MAX_INT,
      }),
    ).toEqual([]);
  });

  it('paymentId (bigint) aceita ids do Mercado Pago, mas não números sem precisão', async () => {
    const body = { items: [item()], type: 'TAKEOUT', paymentMethod: 'PIX' };
    expect(
      await errorsOf(CreateOrderDto, { ...body, paymentId: 123_456_789_012 }),
    ).toEqual([]);
    expect(
      await errorsOf(CreateOrderDto, { ...body, paymentId: 1e19 }),
    ).toEqual(['paymentId']);
  });

  it('driverId acima do integer é recusado', async () => {
    expect(await errorsOf(AssignDriverDto, { driverId: OUT_OF_RANGE })).toEqual(
      ['driverId'],
    );
    expect(await errorsOf(AssignDriverDto, { driverId: MAX_INT })).toEqual([]);
  });

  it('o corpo nunca escolhe a loja: storeId, store_id e storeSlug são recusados (como na API, forbidNonWhitelisted)', async () => {
    const strict = { whitelist: true, forbidNonWhitelisted: true };
    for (const extra of [
      { storeId: 2 },
      { store_id: 2 },
      { storeSlug: 'outra-loja' },
    ]) {
      const order = await validate(
        plainToInstance(CreateOrderDto, {
          items: [item()],
          type: 'TAKEOUT',
          paymentMethod: 'MONEY',
          ...extra,
        }),
        strict,
      );
      expect(failedPaths(order)).toEqual(Object.keys(extra));

      const payment = await validate(
        plainToInstance(CreatePixPaymentDto, {
          order: { items: [item()], type: 'TAKEOUT', ...extra },
          ...extra,
        }),
        strict,
      );
      expect(failedPaths(payment).sort()).toEqual(
        [Object.keys(extra)[0], `order.${Object.keys(extra)[0]}`].sort(),
      );
    }
  });

  it('ids na URL: pedidos usam integer; pagamentos aceitam bigint', () => {
    const orderId = new ParseIdPipe();
    expect(orderId.transform(String(MAX_INT))).toBe(MAX_INT);
    for (const raw of [String(OUT_OF_RANGE), '0', '-1', 'abc', '1.5']) {
      expect(() => orderId.transform(raw)).toThrow(BadRequestException);
    }

    const paymentId = new ParsePaymentIdPipe();
    expect(paymentId.transform('900000000000123')).toBe(900_000_000_000_123);
    for (const raw of ['0', 'abc', '1e3', '99999999999999999', '-5']) {
      expect(() => paymentId.transform(raw)).toThrow('Id inválido.');
    }
  });
});
