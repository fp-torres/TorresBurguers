import { LoginTiming } from './login-timing';

describe('LoginTiming (espera das recusas 429 do login)', () => {
  afterEach(() => jest.useRealTimers());

  it('média móvel das conferências medidas, com teto por medição; valores inválidos são ignorados', async () => {
    const calibrate = jest.fn().mockResolvedValue(true);
    const timing = new LoginTiming(calibrate);
    timing.record(100);
    await expect(timing.typicalMs()).resolves.toBe(100);
    timing.record(200);
    await expect(timing.typicalMs()).resolves.toBeCloseTo(120);
    for (const invalid of [Number.NaN, -5, Number.POSITIVE_INFINITY])
      timing.record(invalid);
    await expect(timing.typicalMs()).resolves.toBeCloseTo(120);
    for (let i = 0; i < 100; i++) timing.record(60_000);
    await expect(timing.typicalMs()).resolves.toBeCloseTo(2_000);
    // Já havia medição: nenhuma calibração
    expect(calibrate).not.toHaveBeenCalled();
  });

  it('antes da primeira medição calibra UMA vez, mesmo numa rajada; falha na calibração não derruba a recusa', async () => {
    let finish: () => void = () => undefined;
    const calibrate = jest.fn(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const timing = new LoginTiming(calibrate);
    const burst = Array.from({ length: 50 }, () => timing.typicalMs());
    finish();
    const values = await Promise.all(burst);
    expect(calibrate).toHaveBeenCalledTimes(1);
    expect(new Set(values).size).toBe(1);

    const broken = new LoginTiming(() =>
      Promise.reject(new Error('sem bcrypt')),
    );
    await expect(broken.typicalMs()).resolves.toBeGreaterThanOrEqual(0);
  });

  it('pad espera o tempo típico (±10%) num timer', async () => {
    jest.useFakeTimers();
    const timing = new LoginTiming(() => Promise.resolve());
    timing.record(1_000);
    let done = false;
    const waiting = timing.pad().then(() => {
      done = true;
    });
    await jest.advanceTimersByTimeAsync(850);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(300);
    expect(done).toBe(true);
    await waiting;
  });
});
