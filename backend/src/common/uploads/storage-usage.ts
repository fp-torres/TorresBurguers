import { Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { uploadsDir } from '../../config/paths';
import { isStoreFile } from './store-files';

/** 1 MB das cotas de armazenamento (binário: 1.048.576 bytes). */
export const BYTES_PER_MB = 1024 * 1024;

/**
 * Por quanto tempo o uso medido de uma loja vale sem medir de novo. Nesta instância, cada envio e cada
 * exclusão feitos pela API já atualizam o valor na hora; a nova medição pega o que mudou por fora
 * (outra instância da API, a limpeza de arquivos, alguém mexendo na pasta).
 */
export const STORAGE_USAGE_TTL_MS = 5 * 60 * 1000;

/** Lojas com o uso guardado em memória (as mais antigas saem primeiro). */
const MAX_CACHED_STORES = 5000;
/** Arquivos conferidos (lstat) ao mesmo tempo numa medição. */
const STAT_CONCURRENCY = 32;

/** Uso de armazenamento de uma loja: arquivos s<storeId>- da pasta de uploads. */
export interface StoreStorageUsage {
  bytes: number;
  files: number;
  /** Quando a pasta foi lida (os envios e exclusões desta instância depois disso já estão somados). */
  measuredAt: Date;
}

interface Entry {
  bytes: number;
  files: number;
  measuredAt: number;
}

/** MB (binário) com 2 casas, arredondado para cima: 1 byte já aparece como 0,01 MB. */
export function bytesToMb(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.ceil((bytes / BYTES_PER_MB) * 100) / 100;
}

/**
 * Uso de armazenamento por loja, calculado de forma barata: a pasta de uploads é plana e os arquivos de
 * cada loja têm o prefixo s<storeId>- (common/uploads/store-files.ts), então o uso é a soma dos arquivos
 * comuns com esse prefixo (pastas, atalhos e arquivos de outras lojas ou de clientes não contam).
 *
 * - Cache por loja: a pasta é lida no máximo uma vez a cada STORAGE_USAGE_TTL_MS por loja (e uma leitura
 *   por vez: quem pede durante a leitura espera a mesma);
 * - os envios (reserve) e exclusões (release/invalidate) feitos por esta instância atualizam o valor na
 *   hora, então envios seguidos da mesma loja são somados sem ler a pasta de novo;
 * - com várias instâncias, cada uma enxerga os envios das outras só na próxima medição (até o TTL).
 */
export class StorageUsageTracker {
  private readonly logger = new Logger('StorageUsage');
  private readonly entries = new Map<number, Entry>();
  private readonly pending = new Map<number, Promise<Entry>>();
  /** Muda a cada invalidação: uma medição que começou antes não grava um valor velho. */
  private readonly generations = new Map<number, number>();
  private generation = 0;

  constructor(
    private readonly options: {
      ttlMs?: number;
      dir?: () => string;
      clock?: () => number;
    } = {},
  ) {}

  private get ttlMs(): number {
    return this.options.ttlMs ?? STORAGE_USAGE_TTL_MS;
  }

  private now(): number {
    return this.options.clock?.() ?? Date.now();
  }

  private dir(): string {
    return this.options.dir?.() ?? uploadsDir();
  }

  /** Uso atual da loja (do cache, se ainda vale; senão, lendo a pasta). Erro de disco → rejeita. */
  async usage(storeId: number): Promise<StoreStorageUsage> {
    const entry = await this.ensure(storeId);
    return {
      bytes: entry.bytes,
      files: entry.files,
      measuredAt: new Date(entry.measuredAt),
    };
  }

  /**
   * Reserva o espaço de um arquivo que vai ser gravado: confere e soma de uma vez (sem espera entre as
   * duas coisas, então dois envios simultâneos desta instância não passam juntos do limite).
   * limitBytes null = sem limite (só soma). Não coube → { ok: false } com o uso atual.
   */
  async reserve(
    storeId: number,
    bytes: number,
    limitBytes: number | null,
  ): Promise<{ ok: true } | { ok: false; usedBytes: number }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.ensure(storeId);
      // Mesma volta do event loop do ensure: nada mudou a entrada entre a leitura e a soma
      const entry = this.entries.get(storeId);
      if (!entry) continue; // invalidada bem agora: mede de novo
      if (limitBytes !== null && entry.bytes + bytes > limitBytes) {
        return { ok: false, usedBytes: entry.bytes };
      }
      entry.bytes += bytes;
      entry.files += 1;
      return { ok: true };
    }
    // A loja foi invalidada três vezes seguidas: a próxima medição conta o arquivo
    return { ok: true };
  }

  /** Soma um arquivo gravado sem conferir limite (só se o uso da loja já estiver guardado: não lê a pasta). */
  add(storeId: number, bytes: number): void {
    const entry = this.entries.get(storeId);
    if (!entry) return;
    entry.bytes += bytes;
    entry.files += 1;
  }

  /** Devolve a reserva de um arquivo que não chegou a ficar na pasta (falha ao gravar ou cadastro recusado). */
  release(storeId: number, bytes: number): void {
    const entry = this.entries.get(storeId);
    if (!entry) return;
    entry.bytes = Math.max(0, entry.bytes - bytes);
    entry.files = Math.max(0, entry.files - 1);
  }

  /** Esquece o uso da loja (arquivo apagado por fora): a próxima consulta lê a pasta de novo. */
  invalidate(storeId: number): void {
    this.entries.delete(storeId);
    this.generations.set(storeId, (this.generations.get(storeId) ?? 0) + 1);
  }

  /** Esquece o uso de todas as lojas (ex.: depois da limpeza de arquivos sem uso). */
  invalidateAll(): void {
    this.entries.clear();
    this.generations.clear();
    this.generation += 1;
  }

  /** Lojas com uso guardado em memória (testes e diagnóstico). */
  cachedStores(): number {
    return this.entries.size;
  }

  private generationOf(storeId: number): string {
    return `${this.generation}:${this.generations.get(storeId) ?? 0}`;
  }

  private ensure(storeId: number): Promise<Entry> {
    const entry = this.entries.get(storeId);
    if (entry && this.now() - entry.measuredAt < this.ttlMs) {
      return Promise.resolve(entry);
    }
    const running = this.pending.get(storeId);
    if (running) return running;

    const startedAt = this.generationOf(storeId);
    const measuring = this.measure(storeId)
      .then((measured) => {
        // Invalidada durante a leitura (arquivo apagado no meio): não guarda o valor velho
        if (this.generationOf(storeId) === startedAt)
          this.store(storeId, measured);
        return this.entries.get(storeId) ?? measured;
      })
      .finally(() => this.pending.delete(storeId));
    this.pending.set(storeId, measuring);
    return measuring;
  }

  private store(storeId: number, entry: Entry): void {
    this.entries.delete(storeId);
    this.entries.set(storeId, entry);
    if (this.entries.size > MAX_CACHED_STORES) {
      // O Map guarda a ordem de inserção: a primeira chave é a medida há mais tempo
      for (const oldest of this.entries.keys()) {
        this.entries.delete(oldest);
        break;
      }
    }
  }

  /** Soma os arquivos comuns s<storeId>- do primeiro nível da pasta (lstat: atalhos e pastas não contam). */
  async measure(storeId: number): Promise<Entry> {
    const dir = this.dir();
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { bytes: 0, files: 0, measuredAt: this.now() };
      }
      throw error;
    }
    const own = names.filter((name) => isStoreFile(name, storeId));
    let bytes = 0;
    let files = 0;
    for (let start = 0; start < own.length; start += STAT_CONCURRENCY) {
      const stats = await Promise.all(
        own
          .slice(start, start + STAT_CONCURRENCY)
          .map((name) => fs.lstat(path.join(dir, name)).catch(() => null)),
      );
      for (const item of stats) {
        // Sumiu no meio da leitura, pasta ou atalho: não conta
        if (!item?.isFile()) continue;
        bytes += item.size;
        files += 1;
      }
    }
    this.logger.debug(
      `Loja ${storeId}: ${files} arquivo(s), ${bytes} bytes na pasta de uploads.`,
    );
    return { bytes, files, measuredAt: this.now() };
  }
}

/** Uso de armazenamento das lojas neste processo (o cache é por instância da API). */
export const storeStorageUsage = new StorageUsageTracker();
