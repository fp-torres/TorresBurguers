/**
 * Cache curto dos indicadores do superpainel (GET /platform/dashboard e /platform/finance). Cada
 * carga agrega a tabela de pedidos de TODAS as lojas (~20 consultas em paralelo, que ocupam o pool
 * do banco): com o cache, recarregar a página ou vários superadmins olhando ao mesmo tempo reaproveitam
 * o resultado por PLATFORM_INSIGHTS_CACHE_MS (padrão 30 s; 0 desliga). Os números podem ficar esse
 * tempo atrasados. Pedidos iguais simultâneos esperam a mesma carga (uma só ida ao banco); falhas não
 * ficam no cache. Em memória, por instância da API, com no máximo MAX_ENTRIES chaves (ex.: períodos
 * do financeiro).
 */
const MAX_ENTRIES = 50;

interface Entry {
  value: Promise<unknown>;
  expiresAt: number;
}

export class InsightsCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (this.ttlMs <= 0) return load();
    const current = this.now();
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > current) return cached.value as Promise<T>;
    if (cached) this.entries.delete(key);

    const value = load();
    this.entries.set(key, { value, expiresAt: current + this.ttlMs });
    // Falha não fica guardada: a próxima chamada tenta de novo
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    return value;
  }
}
