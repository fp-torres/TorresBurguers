import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AuthGuard } from '@nestjs/passport';
import type { AuthUser } from '../auth/auth-user';
import { ClientOnlyGuard } from '../orders/client-only.guard';
import {
  PublicStoreGuard,
  REQUIRE_SELLABLE_STORE_KEY,
} from '../tenancy/guards';
import type { TenantContext } from '../tenancy/tenant-context';
import {
  PaymentController,
  PaymentWebhookController,
} from './payment.controller';
import type { PaymentService } from './payment.service';

type Handler = keyof PaymentController;

const handlerOf = (name: Handler) =>
  (PaymentController.prototype as unknown as Record<Handler, object>)[name];

const guardsOf = (name: Handler) =>
  (Reflect.getMetadata(GUARDS_METADATA, handlerOf(name)) as
    | unknown[]
    | undefined) ?? [];

describe('PaymentController (rotas e guards)', () => {
  it('pagamentos nas rotas antigas (/payment) e da loja (/stores/:storeSlug/payment)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PaymentController)).toEqual([
      'payment',
      'stores/:storeSlug/payment',
    ]);
  });

  it.each(['createCardPayment', 'createPixPayment'] as Handler[])(
    '%s: JWT e "só clientes" ANTES de resolver a loja; só em loja que vende',
    (name) => {
      expect(guardsOf(name)).toEqual([
        AuthGuard('jwt'),
        ClientOnlyGuard,
        PublicStoreGuard,
      ]);
      expect(
        Reflect.getMetadata(REQUIRE_SELLABLE_STORE_KEY, handlerOf(name)),
      ).toBe(true);
    },
  );

  it('consulta e cancelamento exigem login; a loja é conferida no serviço', () => {
    for (const name of ['checkStatus', 'cancel'] as Handler[])
      expect(guardsOf(name)).toEqual([AuthGuard('jwt')]);
  });

  it('o webhook do delivery fica só em POST /payment/webhook (público)', () => {
    const webhook = Reflect.get(
      PaymentWebhookController.prototype,
      'handleWebhook',
    ) as object;
    expect(Reflect.getMetadata(PATH_METADATA, PaymentWebhookController)).toBe(
      'payment',
    );
    expect(Reflect.getMetadata(PATH_METADATA, webhook)).toBe('webhook');
    expect(Reflect.getMetadata(GUARDS_METADATA, webhook)).toBeUndefined();
    expect(
      Object.getOwnPropertyNames(PaymentController.prototype),
    ).not.toContain('handleWebhook');
  });

  it('repassa a loja da vitrine e o :storeSlug da URL para o serviço', async () => {
    const service = {
      createPixPayment: jest.fn().mockResolvedValue({}),
      getStatusFor: jest.fn().mockResolvedValue({}),
      cancelFor: jest.fn().mockResolvedValue({}),
      handleNotification: jest.fn(),
    };
    const controller = new PaymentController(
      service as unknown as PaymentService,
    );
    const client = { id: 7, role: 'CLIENT' } as AuthUser;
    const store = { storeId: 3 } as TenantContext;
    const dto = { order: { items: [], type: 'TAKEOUT' } } as never;

    // O IP da requisição vai para o limite de cobranças por IP
    await controller.createPixPayment(
      dto,
      { user: client, ip: '203.0.113.9' },
      store,
    );
    expect(service.createPixPayment).toHaveBeenCalledWith(
      dto,
      client,
      store,
      '203.0.113.9',
    );
    await controller.checkStatus(55, { user: client }, 'loja-3');
    expect(service.getStatusFor).toHaveBeenCalledWith(55, client, 'loja-3');
    await controller.cancel(55, { user: client }, undefined);
    expect(service.cancelFor).toHaveBeenCalledWith(55, client, undefined);

    const webhook = new PaymentWebhookController(
      service as unknown as PaymentService,
    );
    expect(
      webhook.handleWebhook({ data: { id: '1' } }, {}, {
        ip: '198.51.100.7',
      } as never),
    ).toEqual({ status: 'ok' });
    // Limite por IP do webhook: o IP vai junto para o serviço
    expect(service.handleNotification).toHaveBeenCalledWith(
      { data: { id: '1' } },
      {},
      '198.51.100.7',
    );
  });
});
