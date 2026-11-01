/** Peso de cada medição nova na média móvel. */
const SMOOTHING = 0.2;
/** Teto de uma medição (um banco lento não faz toda recusa esperar demais). */
const MAX_SAMPLE_MS = 2_000;

/**
 * Duração típica de uma conferência de senha do login (busca da conta + bcrypt), em média móvel.
 * As recusas que acontecem ANTES da conferência (429 dos limites de tentativas) esperam esse tempo
 * antes de responder: pelo tempo de resposta não se distingue uma tentativa recusada direto de uma
 * cuja senha foi conferida (ex.: a exceção das origens conhecidas no teto por conta). A espera é um
 * timer, sem CPU: uma rajada de tentativas recusadas não vira carga de bcrypt.
 */
export class LoginTiming {
  private typical: number | null = null;
  private calibration: Promise<void> | null = null;

  /** calibrate: uma conferência de referência (bcrypt com o hash fictício), usada antes da primeira medição. */
  constructor(private readonly calibrate: () => Promise<unknown>) {}

  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    const sample = Math.min(ms, MAX_SAMPLE_MS);
    this.typical =
      this.typical === null
        ? sample
        : this.typical + SMOOTHING * (sample - this.typical);
  }

  /** Tempo típico atual (ms); antes da primeira medição, mede uma conferência de referência (uma vez). */
  async typicalMs(): Promise<number> {
    if (this.typical === null) {
      this.calibration ??= (async () => {
        const started = performance.now();
        try {
          await this.calibrate();
        } catch {
          // Sem referência: a espera fica em 0 até a primeira conferência de verdade
        }
        if (this.typical === null) this.record(performance.now() - started);
      })();
      await this.calibration;
    }
    return this.typical ?? 0;
  }

  /** Espera o tempo típico (±10%, como a variação de uma conferência de verdade). */
  async pad(): Promise<void> {
    const ms = (await this.typicalMs()) * (0.9 + Math.random() * 0.2);
    if (ms <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}
