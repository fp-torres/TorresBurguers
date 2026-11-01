import { ForbiddenException, Logger } from '@nestjs/common';
import {
  BYTES_PER_MB,
  bytesToMb,
  storeStorageUsage,
  type StorageUsageTracker,
} from './storage-usage';

/** Limite de armazenamento do plano vigente de uma loja. */
export interface StoreStorageLimit {
  /** Nome do plano (vai na mensagem do 403). */
  planName: string;
  /** Limite do plano, em MB (1 MB = 1.048.576 bytes). */
  limitMb: number;
}

/**
 * Quem conhece os planos (PlanLimitsService, no BillingModule) informa o limite de cada loja.
 * null = sem limite: plano ilimitado (max_storage_mb nulo) ou loja sem assinatura vigente (a situação da
 * loja já bloqueia as alterações do painel nesse caso).
 */
export interface StoreStorageLimitProvider {
  storageLimit(storeId: number): Promise<StoreStorageLimit | null>;
}

const logger = new Logger('StorageQuota');
let provider: StoreStorageLimitProvider | null = null;

/**
 * Liga a cota às gravações de imagens (chamado na subida da API pelo PlanLimitsService). Sem provedor
 * registrado (testes de unidade de outros módulos), as imagens são gravadas sem conferir a cota.
 */
export function registerStoreStorageLimits(
  next: StoreStorageLimitProvider,
): void {
  provider = next;
}

/** Desliga a cota (desligamento da API ou fim de um teste); só se ainda for o mesmo provedor. */
export function unregisterStoreStorageLimits(
  current: StoreStorageLimitProvider,
): void {
  if (provider === current) provider = null;
}

const decimal = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });

/** "120,5 KB" / "1,25 MB" (binário, como a cota). */
export function formatStorageSize(bytes: number): string {
  if (bytes < BYTES_PER_MB) {
    return `${decimal.format(Math.max(0.1, Math.ceil((bytes / 1024) * 10) / 10))} KB`;
  }
  return `${decimal.format(bytesToMb(bytes))} MB`;
}

/** Mensagem do 403 (com "plano": o painel mostra o aviso de limite com o link para a assinatura). */
export function storageQuotaMessage(
  limit: StoreStorageLimit,
  usedBytes: number,
  incomingBytes = 0,
): string {
  const used = `${decimal.format(bytesToMb(usedBytes))} de ${decimal.format(limit.limitMb)} MB em uso`;
  const incoming =
    incomingBytes > 0
      ? `; a imagem otimizada tem ${formatStorageSize(incomingBytes)}`
      : '';
  return (
    `Limite de armazenamento do plano ${limit.planName} atingido: ${used}${incoming}. ` +
    'Fale com a administração da plataforma para mudar de plano ou liberar espaço.'
  );
}

/**
 * Cota de armazenamento das imagens da loja (produtos, adicionais, logo e POST /uploads), conferida ANTES
 * de gravar o arquivo (OptimizeImagePipe):
 * 1. precheck, antes da conversão: loja que já está no limite (ou acima) → 403 sem gastar a conversão;
 * 2. reserve, com o tamanho final (WebP) e antes de gravar: não cabe → 403 e nada é gravado; cabe → o
 *    espaço fica reservado no uso da loja (envios simultâneos desta instância não passam juntos);
 * 3. release, se a gravação falhar ou o cadastro for recusado depois (o arquivo é apagado).
 * Se a pasta não puder ser lida para medir o uso, o envio segue (a cota não derruba os envios; fica o log).
 */
export class StoreStorageGate {
  constructor(
    private readonly tracker: StorageUsageTracker = storeStorageUsage,
    private readonly limits: () => StoreStorageLimitProvider | null = () =>
      provider,
  ) {}

  /** Antes de converter. Devolve o limite da loja (null = sem limite) para a reserva. */
  async precheck(storeId: number): Promise<StoreStorageLimit | null> {
    const limit = (await this.limits()?.storageLimit(storeId)) ?? null;
    if (!limit) return null;
    let usedBytes: number;
    try {
      usedBytes = (await this.tracker.usage(storeId)).bytes;
    } catch (error) {
      this.warnUnmeasured(storeId, error);
      return null;
    }
    if (usedBytes >= limit.limitMb * BYTES_PER_MB) {
      throw new ForbiddenException(storageQuotaMessage(limit, usedBytes));
    }
    return limit;
  }

  /** Depois de converter e antes de gravar: reserva os bytes do arquivo (403 se não couber). */
  async reserve(
    storeId: number,
    bytes: number,
    limit: StoreStorageLimit | null,
  ): Promise<void> {
    if (!limit) {
      // Sem limite: só mantém o uso guardado em dia (sem ler a pasta por causa disso)
      this.tracker.add(storeId, bytes);
      return;
    }
    let result: Awaited<ReturnType<StorageUsageTracker['reserve']>>;
    try {
      result = await this.tracker.reserve(
        storeId,
        bytes,
        limit.limitMb * BYTES_PER_MB,
      );
    } catch (error) {
      this.warnUnmeasured(storeId, error);
      return;
    }
    if (!result.ok) {
      throw new ForbiddenException(
        storageQuotaMessage(limit, result.usedBytes, bytes),
      );
    }
  }

  /** O arquivo reservado não ficou na pasta. */
  release(storeId: number, bytes: number): void {
    this.tracker.release(storeId, bytes);
  }

  private warnUnmeasured(storeId: number, error: unknown): void {
    const code = (error as NodeJS.ErrnoException)?.code;
    logger.warn(
      `Não foi possível medir o armazenamento da loja ${storeId}${code ? ` (${code})` : ''}: o envio segue sem conferir a cota.`,
    );
  }
}

/** A cota usada pelas gravações de imagens deste processo. */
export const storeStorageGate = new StoreStorageGate();
