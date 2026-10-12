import { Logger } from '@nestjs/common';
import {
  PaymentReconciler,
  RECONCILE_INTERVAL_MS,
} from './payment-reconciler.service';
import type { PaymentService } from './payment.service';

describe('PaymentReconciler', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });
  afterEach(() => jest.useRealTimers());

  function setup() {
    const payments = {
      reconcile: jest.fn().mockResolvedValue({ finalized: 0 }),
    };
    const reconciler = new PaymentReconciler(
      payments as unknown as PaymentService,
    );
    return { reconciler, payments };
  }

  it('roda a conciliação a cada 60 s e para quando a aplicação fecha (seed/testes não ficam presos)', async () => {
    jest.useFakeTimers();
    const { reconciler, payments } = setup();

    reconciler.onApplicationBootstrap();
    expect(payments.reconcile).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS);
    expect(payments.reconcile).toHaveBeenCalledTimes(1);

    reconciler.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS * 3);
    expect(payments.reconcile).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);

    // onApplicationShutdown sozinho também desliga
    reconciler.onApplicationBootstrap();
    reconciler.onApplicationShutdown();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('nunca roda duas conciliações ao mesmo tempo e sobrevive a erros', async () => {
    const { reconciler, payments } = setup();
    let finish: () => void = () => undefined;
    payments.reconcile.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );

    const first = reconciler.tick();
    await reconciler.tick(); // ignorada: a primeira ainda está rodando
    expect(payments.reconcile).toHaveBeenCalledTimes(1);
    finish();
    await first;

    payments.reconcile.mockRejectedValueOnce(new Error('banco fora do ar'));
    await expect(reconciler.tick()).resolves.toBeUndefined();
    await reconciler.tick();
    expect(payments.reconcile).toHaveBeenCalledTimes(3);
  });
});
