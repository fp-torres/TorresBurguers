import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { promises as fs } from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import {
  And,
  FindOperator,
  FindOptionsOrder,
  FindOptionsSelect,
  FindOptionsWhere,
  ILike,
  In,
  IsNull,
  LessThan,
  MoreThan,
  Not,
  Repository,
} from 'typeorm';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth-user';
import { uploadsDir } from '../config/paths';
import { Addon } from '../products/entities/addon.entity';
import { Product } from '../products/entities/product.entity';
import { Store } from '../store/entities/store.entity';
import { User } from '../users/entities/user.entity';
import {
  CredentialsKeyError,
  credentialsKey,
  secretFormatVersion,
  upgradeStoreSecret,
} from './crypto/secret-box';
import { isUniqueViolation } from './database-errors';
import {
  type ImageOptimizationCounts,
  MaintenanceJob,
  MaintenanceJobKind,
  MaintenanceJobStatus,
  type MaintenanceJobSummary,
  type UploadsCleanupCounts,
  type UploadsCleanupMode,
} from './entities/maintenance-job.entity';
import {
  UPLOADS_CLEANUP_MIN_AGE_HOURS,
  UPLOADS_CLEANUP_MIN_AGE_MS,
  type UploadFile,
  type UploadsCleanupScheduleConfig,
  type UploadsCleanupSummary,
  describeCleanup,
  emptyCleanupCounts,
  isCleanupCandidateName,
  isScheduledCleanupDue,
  readCleanupCounts,
  uploadFileKey,
  uploadReferenceKey,
  uploadReferenceVariants,
  uploadsCleanupScheduleConfig,
} from './maintenance.uploads-cleanup';
import { safeForLog } from './uploads/safe-log';
import { storeStorageUsage } from './uploads/storage-usage';
import { isAnyStoreFile, storeFilePrefix } from './uploads/store-files';

/** Linhas lidas por consulta: a tabela é percorrida em lotes, nunca carregada inteira. */
export const MAINTENANCE_BATCH_SIZE = 100;

/** Linhas por consulta ao reunir as referências de arquivos (só id e uma coluna curta). */
const REFERENCE_BATCH_SIZE = 1000;

/**
 * Heartbeat parado há mais que isso = a instância que processava a execução caiu: ela é marcada FAILED
 * ("interrompida") na próxima consulta ou tentativa de iniciar outra, e a trava é liberada.
 */
export const MAINTENANCE_JOB_STALE_MS = 10 * 60 * 1000;

/** Além de a cada lote, o heartbeat (com as contagens parciais) é renovado no máximo a cada 5 s. */
export const MAINTENANCE_HEARTBEAT_INTERVAL_MS = 5_000;

/** No desligamento ordenado da API, espera no máximo isso a execução parar e registrar a interrupção. */
const SHUTDOWN_WAIT_MS = 10_000;

/** Conflitos seguidos ao iniciar (a execução anterior terminando no meio da conferência). */
const CLAIM_ATTEMPTS = 3;

/** Início da otimização (ou recusa por já haver outra em andamento). */
export const OPTIMIZE_IMAGES_AUDIT_ACTION =
  'platform.maintenance.optimize_images';
/** Fim da otimização: SUCCESS (concluída) ou FAILURE (falha ou interrompida), com as contagens. */
export const OPTIMIZE_IMAGES_FINISHED_AUDIT_ACTION =
  'platform.maintenance.optimize_images.finish';
/** Início da limpeza de arquivos sem uso (metadata.mode: check ou delete) ou recusa. */
export const CLEANUP_UPLOADS_AUDIT_ACTION =
  'platform.maintenance.cleanup_uploads';
/** Fim da limpeza: SUCCESS ou FAILURE, só com as contagens (nunca nomes de arquivo). */
export const CLEANUP_UPLOADS_FINISHED_AUDIT_ACTION =
  'platform.maintenance.cleanup_uploads.finish';
/** Regravação das credenciais Mercado Pago no formato atual (só contagens). */
export const REENCRYPT_CREDENTIALS_AUDIT_ACTION =
  'platform.maintenance.reencrypt_credentials';

export const OPTIMIZATION_RUNNING_MESSAGE =
  'Já existe uma otimização de imagens em andamento. Aguarde a conclusão.';
export const CLEANUP_RUNNING_MESSAGE =
  'Já existe uma limpeza de arquivos em andamento. Aguarde a conclusão.';
export const OPTIMIZATION_DONE_MESSAGE = 'Otimização concluída!';
export const JOB_INTERRUPTED_MESSAGE =
  'Execução interrompida: a instância da API que a processava parou de responder.';
export const JOB_SHUTDOWN_MESSAGE =
  'Execução interrompida: a API foi encerrada antes do fim.';
export const CREDENTIALS_KEY_UNAVAILABLE_MESSAGE =
  'A chave de criptografia das credenciais (CREDENTIALS_ENCRYPTION_KEY) não está configurada: nenhuma credencial foi regravada.';

/** Lojas com credenciais ilegíveis devolvidas na resposta da regravação (a auditoria só guarda contagens). */
const FAILED_STORE_IDS_LIMIT = 100;

/** Contagens da otimização enquanto ela roda (o mesmo objeto é atualizado a cada imagem). */
export interface OptimizationCounts {
  products: number;
  addons: number;
  avatars: number;
  /** Arquivo ausente no disco, ilegível ou nome fora da pasta de uploads. */
  skipped: number;
}

export interface OptimizationSummary extends OptimizationCounts {
  message: string;
  /** Total de imagens convertidas (contrato da rota antiga). */
  itemsProcessed: number;
}

/**
 * Ganchos de uma rotina: a execução em segundo plano renova o heartbeat (com as contagens parciais) e
 * pode interromper por eles. A rotina passa sempre o MESMO objeto de contagens, que ela vai atualizando.
 */
export interface RoutineProgress<C> {
  /** Antes de cada lote (do banco ou da pasta). */
  batch(counts: Readonly<C>): Promise<void>;
  /** Antes de cada item. */
  item(counts: Readonly<C>): Promise<void>;
}

/** Ganchos da otimização de imagens. */
export type OptimizationProgress = RoutineProgress<OptimizationCounts>;

const idleProgress = <C>(): RoutineProgress<C> => ({
  batch: () => Promise.resolve(),
  item: () => Promise.resolve(),
});

/** Execução como a API devolve (GET/POST /platform/maintenance/... e o 409). */
export interface MaintenanceJobView {
  id: number;
  kind: MaintenanceJobKind;
  status: MaintenanceJobStatus;
  started_at: Date;
  heartbeat_at: Date;
  finished_at: Date | null;
  /** Do início ao fim (ou até agora, se ainda em andamento). */
  duration_ms: number;
  /** Contagens (parciais enquanto RUNNING); o formato depende do tipo. */
  summary: MaintenanceJobSummary | null;
  /** Motivo curto da falha (sem detalhes internos). */
  error: string | null;
  started_by: { id: number; name: string } | null;
}

export type FinishedStatus =
  | MaintenanceJobStatus.SUCCEEDED
  | MaintenanceJobStatus.FAILED;

export interface JobOutcome<
  S extends MaintenanceJobSummary = MaintenanceJobSummary,
> {
  status: FinishedStatus;
  summary: S;
  error: string | null;
}

export interface StartedJob<
  S extends MaintenanceJobSummary = MaintenanceJobSummary,
> {
  job: MaintenanceJobView;
  /** Resolve (nunca rejeita) quando a execução termina: a rota antiga espera por ele. */
  done: Promise<JobOutcome<S>>;
}

/** Qual rota iniciou (vai para a auditoria). */
export type MaintenanceRoute = 'platform' | 'legacy';

/** Situação das credenciais Mercado Pago gravadas pelas lojas (só contagens; o token nunca sai). */
export interface StoreCredentialsStatus {
  /** Lojas com Access Token gravado. */
  total: number;
  /** No formato atual (v2, preso à loja). */
  current: number;
  /** No formato antigo (v1, sem vínculo com a loja): a regravação passa para o atual. */
  legacy: number;
  /** Formato desconhecido (valor corrompido): a loja precisa salvar as credenciais de novo. */
  unknown: number;
}

/** Resultado da regravação das credenciais no formato atual. */
export interface StoreCredentialsReencryption {
  /** Lojas com Access Token gravado (todas conferidas). */
  total: number;
  /** Regravadas agora no formato atual. */
  migrated: number;
  /** Já estavam no formato atual: não mudam (a ação é idempotente). */
  already_current: number;
  /** Mudaram durante a regravação (a loja salvou ou removeu as credenciais): ficam como a loja deixou. */
  changed: number;
  /** Ilegíveis (outra chave, valor corrompido ou formato desconhecido): ficam como estão. */
  failed: number;
  /** Lojas com credenciais ilegíveis (até 100), para pedir que salvem as credenciais de novo. */
  failed_store_ids: number[];
}

/** Limpeza agendada (GET /platform/maintenance/cleanup-uploads?include=schedule → schedule). */
export interface UploadsCleanupScheduleView {
  /** UPLOADS_CLEANUP_INTERVAL_HOURS válido e maior que zero nesta instância da API. */
  enabled: boolean;
  /** Intervalo configurado, em horas (null = desligada). */
  interval_hours: number | null;
  /** A limpeza agendada sempre apaga (as mesmas regras da manual: só imagens sem uso há mais de 24 h). */
  mode: UploadsCleanupMode;
  min_age_hours: number;
  /** Próxima execução prevista (aproximada: a API confere a cada alguns minutos); null = desligada. */
  next_run_at: Date | null;
  /** A última limpeza agendada (de qualquer instância), ou null se nunca rodou. */
  last_run: MaintenanceJobView | null;
}

/** Já existe uma execução em andamento (job = ela; null se terminou bem no meio da conferência). */
export class MaintenanceJobConflictError extends Error {
  constructor(
    readonly job: MaintenanceJobView | null,
    message = OPTIMIZATION_RUNNING_MESSAGE,
  ) {
    super(message);
    this.name = 'MaintenanceJobConflictError';
  }
}

/** Outra instância marcou a execução como interrompida (heartbeat vencido): esta para de processar. */
class JobLostError extends Error {}

/** Parada pedida pelo desligamento da API. */
class JobAbortedError extends Error {}

/** O que muda de um tipo de execução para outro: textos, auditoria e o formato do resumo. */
interface KindInfo {
  /** Nome no log ("Otimização de imagens #12 ..."). */
  label: string;
  /** 409: já existe uma execução deste tipo em andamento. */
  runningMessage: string;
  startAction: string;
  finishAction: string;
  /** Começo do motivo gravado numa falha inesperada. */
  failurePrefix: string;
  /** summary (jsonb) lido do banco. */
  readSummary(raw: unknown): MaintenanceJobSummary | null;
  /** Contagens no log do fim. */
  describe(summary: MaintenanceJobSummary): string;
}

/** Uma rotina em segundo plano: contagens iniciais, como gravá-las e o trabalho em si. */
interface Routine<C> {
  initial(): C;
  summarize(counts: Readonly<C>): MaintenanceJobSummary;
  run(progress: RoutineProgress<C>): Promise<C>;
}

/** Execução processada por ESTA instância. */
interface JobRun {
  readonly jobId: number;
  readonly kind: MaintenanceJobKind;
  /** Superadmin que iniciou; null = o sistema (limpeza agendada), auditado com escopo SYSTEM. */
  readonly actor: AuthUser | null;
  readonly startedAt: number;
  lastBeatAt: number;
  /** Resumo atual (das contagens que a rotina vai atualizando): gravado no fim, inclusive se falhar. */
  summary: () => MaintenanceJobSummary;
  /** Parada pedida (desligamento): a rotina para no próximo item. */
  abortReason: string | null;
}

/** Linha de um cadastro que guarda a referência de um arquivo de uploads. */
interface ReferenceRow {
  id: number;
  ref: unknown;
}

/** Coluna que guarda arquivos de uploads (produtos, adicionais, avatares, logos). */
interface ReferenceSource {
  /** Linhas com referência, por id crescente, inclusive lixeira e contas apagadas. */
  page(afterId: number, take: number): Promise<ReferenceRow[]>;
  /** Linhas que gravam exatamente um destes valores (inclusive lixeira). */
  matching(values: string[]): Promise<ReferenceRow[]>;
}

const emptyCounts = (): OptimizationCounts => ({
  products: 0,
  addons: 0,
  avatars: 0,
  skipped: 0,
});

/** Contagens no formato gravado (summary) e devolvido pela API. */
function toJobSummary(counts: OptimizationCounts): ImageOptimizationCounts {
  return {
    items_processed: counts.products + counts.addons + counts.avatars,
    products: counts.products,
    addons: counts.addons,
    avatars: counts.avatars,
    skipped: counts.skipped,
  };
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;

/** summary (jsonb) da otimização lido do banco: só as contagens conhecidas, sempre números. */
function readJobSummary(raw: unknown): ImageOptimizationCounts | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  return {
    items_processed: count(value.items_processed),
    products: count(value.products),
    addons: count(value.addons),
    avatars: count(value.avatars),
    skipped: count(value.skipped),
  };
}

const KINDS: Record<MaintenanceJobKind, KindInfo> = {
  [MaintenanceJobKind.OPTIMIZE_IMAGES]: {
    label: 'Otimização de imagens',
    runningMessage: OPTIMIZATION_RUNNING_MESSAGE,
    startAction: OPTIMIZE_IMAGES_AUDIT_ACTION,
    finishAction: OPTIMIZE_IMAGES_FINISHED_AUDIT_ACTION,
    failurePrefix: 'Falha inesperada na otimização',
    readSummary: readJobSummary,
    describe: (summary) => {
      const counts = summary as ImageOptimizationCounts;
      return `${counts.items_processed} convertidas, ${counts.skipped} ignoradas`;
    },
  },
  [MaintenanceJobKind.CLEANUP_UPLOADS]: {
    label: 'Limpeza de arquivos sem uso',
    runningMessage: CLEANUP_RUNNING_MESSAGE,
    startAction: CLEANUP_UPLOADS_AUDIT_ACTION,
    finishAction: CLEANUP_UPLOADS_FINISHED_AUDIT_ACTION,
    failurePrefix: 'Falha inesperada na limpeza de arquivos',
    readSummary: readCleanupCounts,
    describe: (summary) => describeCleanup(summary as UploadsCleanupCounts),
  },
};

const timeOf = (value: Date | string): number => new Date(value).getTime();

/** Código curto de um erro de banco ou de disco (ex.: EACCES, 23505), quando houver. */
function errorCode(error: unknown): string | undefined {
  const raw = error as { code?: unknown; driverError?: { code?: unknown } };
  return [raw?.code, raw?.driverError?.code].find(
    (value): value is string =>
      typeof value === 'string' && /^[A-Z0-9_]{2,32}$/.test(value),
  );
}

/**
 * Motivo gravado na execução e na auditoria: curto e sem stack, caminhos ou segredos (a mensagem de um
 * erro de banco ou de disco pode trazer SQL e caminhos do servidor). Só o código do erro, quando houver.
 */
function failureMessage(error: unknown, prefix: string): string {
  if (error instanceof JobAbortedError) return error.message;
  const code = errorCode(error);
  return `${prefix}${code ? ` (código ${code})` : ''}. Os detalhes estão no log da API.`;
}

const isExternalUrl = (value: string) => /^https?:\/\//i.test(value);

/** Imagem que ainda pode virar WebP: arquivo local que não é .webp. */
function needsConversion(image: string | null | undefined): image is string {
  return (
    !!image && !image.toLowerCase().endsWith('.webp') && !isExternalUrl(image)
  );
}

/** Filtro no banco das imagens candidatas (o lote só traz o que talvez precise de conversão). */
function convertibleImage(): FindOperator<string> {
  return And<string>(
    Not<string>(IsNull()),
    Not(ILike('%.webp')),
    Not(ILike('http://%')),
    Not(ILike('https://%')),
  );
}

/**
 * Manutenção da plataforma (somente o superadministrador: a pasta de uploads e as credenciais são de
 * todas as lojas):
 * - otimização das imagens: converte para WebP as imagens antigas de produtos, adicionais e avatares —
 *   inclusive de itens na lixeira — sem apagar os originais;
 * - limpeza dos arquivos sem uso: encontra (e, no modo delete, apaga) as imagens da pasta de uploads que
 *   nenhum cadastro usa e que têm mais de 24 h;
 * - regravação das credenciais Mercado Pago antigas (v1) no formato atual, preso à loja (v2).
 *
 * A otimização e a limpeza rodam em SEGUNDO PLANO (tabela maintenance_jobs): iniciar devolve a execução
 * na hora e a rotina segue sozinha, renovando heartbeat_at a cada lote. A trava é do banco (índice único
 * parcial de RUNNING por tipo): uma execução por vez de cada tipo entre todas as instâncias da API.
 * Execução sem heartbeat há mais de MAINTENANCE_JOB_STALE_MS (instância que caiu) vira FAILED ao
 * consultar ou ao iniciar outra. Início e fim ficam na auditoria (contagens, nunca caminhos ou segredos).
 *
 * Limpeza agendada (UPLOADS_CLEANUP_INTERVAL_HOURS, desligada por padrão): cada instância confere de tempos
 * em tempos se a última limpeza agendada (de qualquer instância, pelo banco) já tem um intervalo e, se tem,
 * inicia uma no modo delete, sem ator (auditada como SYSTEM) e com a MESMA trava das manuais: com uma
 * limpeza em andamento, espera a próxima conferência.
 */
@Injectable()
export class MaintenanceService
  implements BeforeApplicationShutdown, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(MaintenanceService.name);
  /** Execuções processadas por esta instância e o fim de cada uma (para o desligamento ordenado). */
  private readonly runs = new Map<JobRun, Promise<JobOutcome>>();
  /** Agendamento da limpeza nesta instância (lido do ambiente na subida). */
  private schedule: UploadsCleanupScheduleConfig =
    uploadsCleanupScheduleConfig();
  private scheduleTimer: NodeJS.Timeout | null = null;
  /** Quando o timer começou (para prever a próxima conferência). */
  private scheduleStartedAt: number | null = null;
  private scheduleChecking = false;

  constructor(
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    @InjectRepository(Addon)
    private readonly addonRepository: Repository<Addon>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(MaintenanceJob)
    private readonly jobs: Repository<MaintenanceJob>,
    private readonly audit: AuditService,
  ) {}

  /** Relógio das execuções (substituído nos testes). */
  protected now(): Date {
    return new Date();
  }

  /** Lojas (logos e credenciais), pelo mesmo EntityManager das execuções. */
  protected storeRepository(): Repository<Store> {
    return this.jobs.manager.getRepository(Store);
  }

  // ---------------------------------------------------------------------------------------------
  // Agendamento da limpeza (timer desta instância)
  // ---------------------------------------------------------------------------------------------

  /** Na subida da API: liga o timer da limpeza agendada (se UPLOADS_CLEANUP_INTERVAL_HOURS pedir). */
  onApplicationBootstrap(): void {
    this.startCleanupSchedule();
  }

  onModuleDestroy(): void {
    this.stopCleanupSchedule();
  }

  /** (Re)lê a configuração do ambiente e liga o timer; desligada = só registra (nada roda sozinho). */
  startCleanupSchedule(
    config: UploadsCleanupScheduleConfig = uploadsCleanupScheduleConfig(),
  ): void {
    this.stopCleanupSchedule();
    this.schedule = config;
    if (config.problem) this.logger.warn(config.problem);
    if (!config.enabled || config.checkMs === null) return;
    this.scheduleStartedAt = this.now().getTime();
    this.scheduleTimer = setInterval(
      () => void this.checkScheduledCleanup(),
      config.checkMs,
    );
    // Não segura o processo aberto (scripts, testes e desligamento)
    this.scheduleTimer.unref?.();
    this.logger.log(
      `Limpeza agendada dos arquivos sem uso: a cada ${config.intervalHours} h (conferência a cada ${Math.round(config.checkMs / 1000)} s).`,
    );
  }

  stopCleanupSchedule(): void {
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    this.scheduleTimer = null;
    this.scheduleStartedAt = null;
  }

  /**
   * Conferência do timer: inicia a limpeza agendada se estiver na hora. Nunca lança (o erro vai para o
   * log e a próxima conferência tenta de novo); uma conferência por vez nesta instância.
   */
  async checkScheduledCleanup(): Promise<StartedJob<UploadsCleanupSummary> | null> {
    if (this.scheduleChecking || !this.schedule.enabled) return null;
    this.scheduleChecking = true;
    try {
      const last = await this.lastScheduledCleanup();
      if (
        !isScheduledCleanupDue(
          last?.started_at ?? null,
          this.now(),
          this.schedule,
        )
      ) {
        return null;
      }
      return await this.startScheduledUploadsCleanup();
    } catch (error) {
      this.logger.warn(
        `Limpeza agendada: não foi possível conferir ou iniciar (${(error as Error)?.message}).`,
      );
      return null;
    } finally {
      this.scheduleChecking = false;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Otimização de imagens
  // ---------------------------------------------------------------------------------------------

  /**
   * Inicia a otimização em segundo plano e devolve a execução (RUNNING) sem esperar o fim.
   * Já em andamento (nesta ou em outra instância) → MaintenanceJobConflictError com a execução.
   */
  async startImageOptimization(
    actor: AuthUser,
    request?: Request | null,
    route: MaintenanceRoute = 'platform',
  ): Promise<StartedJob<ImageOptimizationCounts>> {
    const started = await this.startJob<OptimizationCounts>(
      MaintenanceJobKind.OPTIMIZE_IMAGES,
      actor,
      request,
      { route },
      {
        initial: emptyCounts,
        summarize: toJobSummary,
        run: async (progress) => {
          // As imagens convertidas viram arquivos novos das lojas (s<id>-): o uso é medido de novo
          const result = await this.optimizeEverything(progress).finally(() =>
            storeStorageUsage.invalidateAll(),
          );
          return {
            products: result.products,
            addons: result.addons,
            avatars: result.avatars,
            skipped: result.skipped,
          };
        },
      },
    );
    return started as StartedJob<ImageOptimizationCounts>;
  }

  /** A última otimização (em andamento ou terminada), depois de expirar as que pararam de responder. */
  latestImageOptimization(): Promise<MaintenanceJobView | null> {
    return this.latestJob(MaintenanceJobKind.OPTIMIZE_IMAGES);
  }

  // ---------------------------------------------------------------------------------------------
  // Limpeza dos arquivos sem uso
  // ---------------------------------------------------------------------------------------------

  /**
   * Inicia a limpeza em segundo plano: check só conta (quantidade e tamanho), delete apaga. Uma por vez
   * (check e delete dividem a trava). Já em andamento → MaintenanceJobConflictError com a execução.
   */
  async startUploadsCleanup(
    actor: AuthUser,
    mode: UploadsCleanupMode,
    request?: Request | null,
  ): Promise<StartedJob<UploadsCleanupSummary>> {
    return this.startCleanup(actor, mode, 'manual', request);
  }

  /**
   * Limpeza agendada: modo delete, sem ator (auditada com escopo SYSTEM e trigger 'schedule'), com a mesma
   * trava das manuais. Já há uma limpeza em andamento (manual ou de outra instância) → null, sem auditar
   * a recusa (a próxima conferência tenta de novo).
   */
  async startScheduledUploadsCleanup(): Promise<StartedJob<UploadsCleanupSummary> | null> {
    try {
      return await this.startCleanup(null, 'delete', 'schedule', null, {
        quietConflict: true,
      });
    } catch (error) {
      if (!(error instanceof MaintenanceJobConflictError)) throw error;
      this.logger.log(
        `Limpeza agendada adiada: já existe uma limpeza em andamento${error.job ? ` (#${error.job.id})` : ''}.`,
      );
      return null;
    }
  }

  private async startCleanup(
    actor: AuthUser | null,
    mode: UploadsCleanupMode,
    trigger: UploadsCleanupSummary['trigger'],
    request?: Request | null,
    options: { quietConflict?: boolean } = {},
  ): Promise<StartedJob<UploadsCleanupSummary>> {
    const started = await this.startJob<UploadsCleanupSummary>(
      MaintenanceJobKind.CLEANUP_UPLOADS,
      actor,
      request,
      { mode, trigger },
      {
        initial: () => emptyCleanupCounts(mode, trigger),
        summarize: (counts) => ({ ...counts }),
        run: (progress) => this.cleanUploads(mode, progress, trigger),
      },
      options,
    );
    return started as StartedJob<UploadsCleanupSummary>;
  }

  /** A última limpeza (verificação ou exclusão), depois de expirar as que pararam de responder. */
  latestUploadsCleanup(): Promise<MaintenanceJobView | null> {
    return this.latestJob(MaintenanceJobKind.CLEANUP_UPLOADS);
  }

  /** Situação do agendamento nesta instância + a última limpeza agendada (de qualquer instância). */
  async uploadsCleanupSchedule(): Promise<UploadsCleanupScheduleView> {
    await this.expireStale(MaintenanceJobKind.CLEANUP_UPLOADS);
    const last = await this.lastScheduledCleanup();
    return {
      enabled: this.schedule.enabled,
      interval_hours: this.schedule.intervalHours,
      mode: 'delete',
      min_age_hours: UPLOADS_CLEANUP_MIN_AGE_HOURS,
      next_run_at: this.nextScheduledRun(last),
      last_run: last ? this.present(last) : null,
    };
  }

  /**
   * A última limpeza agendada. Sem ator (started_by_user_id nulo) e com trigger 'schedule' no resumo: uma
   * manual cujo superadmin foi apagado também fica sem ator, por isso o resumo decide.
   */
  private async lastScheduledCleanup(): Promise<MaintenanceJob | null> {
    const candidates = await this.jobs.find({
      where: {
        kind: MaintenanceJobKind.CLEANUP_UPLOADS,
        started_by_user_id: IsNull(),
      },
      order: { id: 'DESC' },
      take: 20,
      relations: { started_by: true },
    });
    return (
      candidates.find(
        (job) => readCleanupCounts(job.summary)?.trigger === 'schedule',
      ) ?? null
    );
  }

  /** Previsão da próxima limpeza agendada: a primeira conferência do timer depois do horário devido. */
  private nextScheduledRun(last: MaintenanceJob | null): Date | null {
    const { enabled, intervalMs, checkMs } = this.schedule;
    if (!enabled || intervalMs === null || checkMs === null) return null;
    const now = this.now().getTime();
    const dueAt = last
      ? timeOf(last.started_at) + intervalMs - checkMs / 2
      : now;
    const target = Math.max(dueAt, now);
    if (this.scheduleStartedAt === null) return new Date(target);
    const checks = Math.max(
      1,
      Math.ceil((target - this.scheduleStartedAt) / checkMs),
    );
    return new Date(this.scheduleStartedAt + checks * checkMs);
  }

  // ---------------------------------------------------------------------------------------------
  // Credenciais Mercado Pago das lojas
  // ---------------------------------------------------------------------------------------------

  /** Quantas lojas têm credenciais em cada formato (nada é decifrado). */
  async storeCredentialsStatus(): Promise<StoreCredentialsStatus> {
    const status: StoreCredentialsStatus = {
      total: 0,
      current: 0,
      legacy: 0,
      unknown: 0,
    };
    for await (const batch of this.storeCredentialBatches()) {
      for (const store of batch) {
        const stored = store.mp_access_token_encrypted;
        if (!stored) continue;
        status.total += 1;
        const version = secretFormatVersion(stored);
        if (version === 'v2') status.current += 1;
        else if (version === 'v1') status.legacy += 1;
        else status.unknown += 1;
      }
    }
    return status;
  }

  /**
   * Regrava no formato atual (v2, preso à loja) os Access Tokens gravados no formato antigo (v1).
   * Idempotente: o que já está em v2 não muda. A gravação é condicional (só se o valor não mudou desde
   * a leitura), então uma loja que salvar as credenciais no meio fica com o que salvou. O token nunca
   * sai daqui (nem na resposta, nem no log, nem na auditoria, que guarda só contagens).
   * Sem a chave de criptografia (produção sem CREDENTIALS_ENCRYPTION_KEY) → CredentialsKeyError.
   */
  async reencryptStoreCredentials(
    actor: AuthUser,
    request?: Request | null,
  ): Promise<StoreCredentialsReencryption> {
    const result: StoreCredentialsReencryption = {
      total: 0,
      migrated: 0,
      already_current: 0,
      changed: 0,
      failed: 0,
      failed_store_ids: [],
    };
    const counts = () => ({
      total: result.total,
      migrated: result.migrated,
      already_current: result.already_current,
      changed: result.changed,
      failed: result.failed,
    });
    const stores = this.storeRepository();

    try {
      // Sem a chave nada pode ser lido: falha antes de começar (e não confunde com valor ilegível)
      credentialsKey();
      for await (const batch of this.storeCredentialBatches()) {
        for (const store of batch) {
          const stored = store.mp_access_token_encrypted;
          if (!stored) continue;
          result.total += 1;
          let upgraded: string | null;
          try {
            upgraded = upgradeStoreSecret(store.id, stored);
          } catch (error) {
            if (error instanceof CredentialsKeyError) throw error;
            result.failed += 1;
            if (result.failed_store_ids.length < FAILED_STORE_IDS_LIMIT) {
              result.failed_store_ids.push(store.id);
            }
            this.logger.warn(
              `Credenciais Mercado Pago da loja ${store.id} ilegíveis: não regravadas (${safeForLog((error as Error)?.message, 120)}). A loja precisa salvá-las de novo.`,
            );
            continue;
          }
          if (upgraded === null) {
            result.already_current += 1;
            continue;
          }
          const { affected } = await stores.update(
            { id: store.id, mp_access_token_encrypted: stored },
            { mp_access_token_encrypted: upgraded },
          );
          if (affected) result.migrated += 1;
          else result.changed += 1;
        }
      }
    } catch (error) {
      const keyMissing = error instanceof CredentialsKeyError;
      if (!keyMissing) {
        this.logger.error(
          `Regravação das credenciais Mercado Pago falhou: ${(error as Error)?.message}`,
          (error as Error)?.stack,
        );
      }
      await this.audit.record({
        actor,
        scope: 'PLATFORM',
        action: REENCRYPT_CREDENTIALS_AUDIT_ACTION,
        result: 'FAILURE',
        metadata: {
          reason: keyMissing
            ? CREDENTIALS_KEY_UNAVAILABLE_MESSAGE
            : failureMessage(error, 'Falha inesperada na regravação'),
          ...counts(),
        },
        request,
      });
      throw error;
    }

    await this.audit.record({
      actor,
      scope: 'PLATFORM',
      action: REENCRYPT_CREDENTIALS_AUDIT_ACTION,
      metadata: counts(),
      request,
    });
    this.logger.log(
      `Credenciais Mercado Pago: ${result.migrated} regravadas no formato atual, ${result.already_current} já atuais, ${result.changed} alteradas no meio, ${result.failed} ilegíveis (de ${result.total}).`,
    );
    return result;
  }

  /** Lojas com Access Token gravado, em lotes por id (a coluna é select: false na entidade). */
  private storeCredentialBatches() {
    const stores = this.storeRepository();
    return this.batches((afterId) =>
      stores.find({
        select: { id: true, mp_access_token_encrypted: true },
        where: {
          id: MoreThan(afterId),
          mp_access_token_encrypted: Not(IsNull()),
        },
        order: { id: 'ASC' },
        take: MAINTENANCE_BATCH_SIZE,
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Execuções em segundo plano
  // ---------------------------------------------------------------------------------------------

  /**
   * Desligamento ordenado (app.close() ou enableShutdownHooks): pede a parada das execuções desta
   * instância e espera elas registrarem a interrupção (o banco ainda está aberto nesta fase).
   */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.runs.size === 0) return;
    for (const run of this.runs.keys())
      run.abortReason ??= JOB_SHUTDOWN_MESSAGE;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SHUTDOWN_WAIT_MS);
      timer.unref?.();
    });
    try {
      await Promise.race([Promise.all(this.runs.values()), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Grava a execução RUNNING, audita o início (ou a recusa) e começa a processar em segundo plano. */
  private async startJob<C>(
    kind: MaintenanceJobKind,
    actor: AuthUser | null,
    request: Request | null | undefined,
    auditContext: Record<string, unknown>,
    routine: Routine<C>,
    options: { quietConflict?: boolean } = {},
  ): Promise<StartedJob> {
    const info = KINDS[kind];
    // Sem ator = o sistema (limpeza agendada)
    const scope = actor ? 'PLATFORM' : 'SYSTEM';
    let job: MaintenanceJob;
    try {
      job = await this.claim(kind, actor, routine.summarize(routine.initial()));
    } catch (error) {
      const conflict = error instanceof MaintenanceJobConflictError;
      if (conflict && options.quietConflict) throw error;
      await this.audit.record({
        actor,
        scope,
        action: info.startAction,
        targetType: 'maintenance_job',
        targetId: conflict ? (error.job?.id ?? null) : null,
        result: 'FAILURE',
        metadata: conflict
          ? {
              reason: info.runningMessage,
              running_job_id: error.job?.id ?? null,
              ...auditContext,
            }
          : {
              reason: 'Erro inesperado (detalhes no log da API).',
              ...auditContext,
            },
        request,
      });
      throw error;
    }

    await this.audit.record({
      actor,
      scope,
      action: info.startAction,
      targetType: 'maintenance_job',
      targetId: job.id,
      metadata: { job_id: job.id, ...auditContext },
      request,
    });
    this.logger.log(
      `${info.label} #${job.id} iniciada em segundo plano (${actor ? `usuário ${actor.id}` : 'agendamento'}).`,
    );

    return {
      job: this.present(job, actor ? { id: actor.id, name: actor.name } : null),
      done: this.launch(job, actor, routine),
    };
  }

  /** A última execução do tipo (em andamento ou terminada), depois de expirar as que pararam. */
  private async latestJob(
    kind: MaintenanceJobKind,
  ): Promise<MaintenanceJobView | null> {
    await this.expireStale(kind);
    const job = await this.findJob({ kind });
    return job ? this.present(job) : null;
  }

  /** Grava a execução RUNNING; a trava é o índice único parcial (uma RUNNING por tipo). */
  private async claim(
    kind: MaintenanceJobKind,
    actor: AuthUser | null,
    summary: MaintenanceJobSummary,
  ): Promise<MaintenanceJob> {
    for (let attempt = 1; ; attempt += 1) {
      await this.expireStale(kind);
      const now = this.now();
      try {
        return await this.jobs.save(
          this.jobs.create({
            kind,
            status: MaintenanceJobStatus.RUNNING,
            started_by_user_id: actor?.id ?? null,
            started_at: now,
            heartbeat_at: now,
            finished_at: null,
            summary,
            error: null,
          }),
        );
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const running = await this.findJob({
          kind,
          status: MaintenanceJobStatus.RUNNING,
        });
        if (running) {
          throw new MaintenanceJobConflictError(
            this.present(running),
            KINDS[kind].runningMessage,
          );
        }
        // A execução anterior terminou entre o INSERT e a consulta: tenta de novo
        if (attempt >= CLAIM_ATTEMPTS) {
          throw new MaintenanceJobConflictError(
            null,
            KINDS[kind].runningMessage,
          );
        }
      }
    }
  }

  /** Marca FAILED ("interrompida") as execuções RUNNING sem heartbeat recente: libera a trava. */
  private async expireStale(kind: MaintenanceJobKind): Promise<void> {
    const info = KINDS[kind];
    const cutoff = new Date(this.now().getTime() - MAINTENANCE_JOB_STALE_MS);
    const stale = await this.jobs.find({
      where: {
        kind,
        status: MaintenanceJobStatus.RUNNING,
        heartbeat_at: LessThan(cutoff),
      },
    });
    for (const job of stale) {
      const finishedAt = this.now();
      // Condicional: outra instância pode ter marcado antes (ou o heartbeat ter voltado)
      const { affected } = await this.jobs.update(
        {
          id: job.id,
          status: MaintenanceJobStatus.RUNNING,
          heartbeat_at: LessThan(cutoff),
        },
        {
          status: MaintenanceJobStatus.FAILED,
          finished_at: finishedAt,
          error: JOB_INTERRUPTED_MESSAGE,
        },
      );
      if (!affected) continue;
      this.logger.warn(
        `${info.label} #${job.id} sem notícias desde ${new Date(job.heartbeat_at).toISOString()}: marcada como interrompida.`,
      );
      await this.audit.record({
        scope: 'SYSTEM',
        action: info.finishAction,
        targetType: 'maintenance_job',
        targetId: job.id,
        result: 'FAILURE',
        metadata: {
          reason: JOB_INTERRUPTED_MESSAGE,
          ...info.readSummary(job.summary),
          duration_ms: finishedAt.getTime() - timeOf(job.started_at),
          last_heartbeat_at: job.heartbeat_at,
          started_by_user_id: job.started_by_user_id,
          job_id: job.id,
        },
      });
    }
  }

  private findJob(
    where: FindOptionsWhere<MaintenanceJob>,
  ): Promise<MaintenanceJob | null> {
    return this.jobs.findOne({
      where,
      order: { id: 'DESC' },
      relations: { started_by: true },
    });
  }

  /** Começa a processar em segundo plano; a promessa devolvida nunca rejeita. */
  private launch<C>(
    job: MaintenanceJob,
    actor: AuthUser | null,
    routine: Routine<C>,
  ): Promise<JobOutcome> {
    const initial = routine.initial();
    const run: JobRun = {
      jobId: job.id,
      kind: job.kind,
      actor,
      startedAt: timeOf(job.started_at),
      lastBeatAt: timeOf(job.heartbeat_at),
      summary: () => routine.summarize(initial),
      abortReason: null,
    };
    const done = this.execute(run, routine)
      .catch((error: unknown): JobOutcome => {
        // Rede de segurança: execute() já trata tudo; nada pode virar unhandled rejection
        this.logger.error(
          `${KINDS[run.kind].label} #${run.jobId}: erro ao encerrar (${(error as Error)?.message}).`,
        );
        return {
          status: MaintenanceJobStatus.FAILED,
          summary: run.summary(),
          error: failureMessage(error, KINDS[run.kind].failurePrefix),
        };
      })
      .finally(() => this.runs.delete(run));
    this.runs.set(run, done);
    return done;
  }

  private async execute<C>(
    run: JobRun,
    routine: Routine<C>,
  ): Promise<JobOutcome> {
    const info = KINDS[run.kind];
    try {
      const result = await routine.run({
        batch: (counts) =>
          this.beat(run, () => routine.summarize(counts), true),
        item: (counts) =>
          this.beat(run, () => routine.summarize(counts), false),
      });
      run.summary = () => routine.summarize(result);
      return await this.finish(run, MaintenanceJobStatus.SUCCEEDED, null);
    } catch (error) {
      if (error instanceof JobLostError) {
        this.logger.warn(
          `${info.label} #${run.jobId} foi marcada como interrompida por outra instância (heartbeat vencido): processamento parado.`,
        );
        return {
          status: MaintenanceJobStatus.FAILED,
          summary: run.summary(),
          error: JOB_INTERRUPTED_MESSAGE,
        };
      }
      if (!(error instanceof JobAbortedError)) {
        this.logger.error(
          `${info.label} #${run.jobId} falhou: ${(error as Error)?.message}`,
          (error as Error)?.stack,
        );
      }
      return await this.finish(
        run,
        MaintenanceJobStatus.FAILED,
        failureMessage(error, info.failurePrefix),
      );
    }
  }

  /**
   * Heartbeat: a cada lote (force) e, dentro do lote, no máximo a cada MAINTENANCE_HEARTBEAT_INTERVAL_MS.
   * Grava também as contagens parciais (acompanhamento no superpainel). Se a execução já não está
   * RUNNING (outra instância a marcou como interrompida), para.
   */
  private async beat(
    run: JobRun,
    summary: () => MaintenanceJobSummary,
    force: boolean,
  ): Promise<void> {
    run.summary = summary;
    if (run.abortReason) throw new JobAbortedError(run.abortReason);
    const now = this.now();
    if (
      !force &&
      now.getTime() - run.lastBeatAt < MAINTENANCE_HEARTBEAT_INTERVAL_MS
    ) {
      return;
    }
    const { affected } = await this.jobs.update(
      { id: run.jobId, status: MaintenanceJobStatus.RUNNING },
      { heartbeat_at: now, summary: summary() },
    );
    if (!affected) throw new JobLostError();
    run.lastBeatAt = now.getTime();
  }

  /** Grava o fim (só se ainda RUNNING) e audita o resultado com as contagens. */
  private async finish(
    run: JobRun,
    status: FinishedStatus,
    error: string | null,
  ): Promise<JobOutcome> {
    const info = KINDS[run.kind];
    const summary = run.summary();
    const reason = error?.slice(0, 300) ?? null;
    const finishedAt = this.now();
    try {
      const { affected } = await this.jobs.update(
        { id: run.jobId, status: MaintenanceJobStatus.RUNNING },
        {
          status,
          finished_at: finishedAt,
          heartbeat_at: finishedAt,
          summary,
          error: reason,
        },
      );
      if (!affected) {
        this.logger.warn(
          `${info.label} #${run.jobId} já estava marcada como interrompida: o resultado (${status}) não foi gravado.`,
        );
        return {
          status: MaintenanceJobStatus.FAILED,
          summary,
          error: JOB_INTERRUPTED_MESSAGE,
        };
      }
    } catch (updateError) {
      // Sem gravar o fim, a execução fica RUNNING até o heartbeat vencer (e então vira interrompida)
      this.logger.error(
        `${info.label} #${run.jobId}: não foi possível gravar o fim (${(updateError as Error)?.message}).`,
      );
    }

    await this.audit.record({
      actor: run.actor,
      scope: run.actor ? 'PLATFORM' : 'SYSTEM',
      action: info.finishAction,
      targetType: 'maintenance_job',
      targetId: run.jobId,
      result: status === MaintenanceJobStatus.SUCCEEDED ? 'SUCCESS' : 'FAILURE',
      metadata: {
        ...(reason ? { reason } : {}),
        ...summary,
        duration_ms: finishedAt.getTime() - run.startedAt,
        job_id: run.jobId,
      },
    });
    this.logger.log(
      `${info.label} #${run.jobId}: ${status} (${info.describe(summary)}).`,
    );
    return { status, summary, error: reason };
  }

  private present(
    job: MaintenanceJob,
    startedBy?: { id: number; name: string } | null,
  ): MaintenanceJobView {
    const end = job.finished_at
      ? timeOf(job.finished_at)
      : this.now().getTime();
    const by =
      startedBy ??
      (job.started_by
        ? { id: job.started_by.id, name: job.started_by.name }
        : null);
    return {
      id: job.id,
      kind: job.kind,
      status: job.status,
      started_at: job.started_at,
      heartbeat_at: job.heartbeat_at,
      finished_at: job.finished_at,
      duration_ms: Math.max(0, end - timeOf(job.started_at)),
      summary: KINDS[job.kind]?.readSummary(job.summary) ?? null,
      error: job.error,
      started_by: by,
    };
  }

  /**
   * Percorre uma tabela em lotes por id crescente (paginação por chave: as linhas convertidas saem
   * do filtro sem fazer o lote seguinte pular ninguém, o que aconteceria com OFFSET).
   */
  private async *batches<T extends { id: number }>(
    load: (afterId: number) => Promise<T[]>,
    size = MAINTENANCE_BATCH_SIZE,
  ): AsyncGenerator<T[]> {
    let afterId = 0;
    for (;;) {
      const batch = await load(afterId);
      if (batch.length === 0) return;
      yield batch;
      if (batch.length < size) return;
      afterId = batch[batch.length - 1].id;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // A rotina da limpeza (sem trava própria: use startUploadsCleanup)
  // ---------------------------------------------------------------------------------------------

  /**
   * Encontra as imagens da pasta de uploads sem uso há mais de 24 h; no modo delete, apaga.
   * Ordem: primeiro a pasta, depois as referências do banco (um cadastro salvo durante a leitura da
   * pasta entra na conta). No modo delete, cada lote é conferido de novo no banco e no disco logo
   * antes de apagar. Nada fora da pasta de uploads é lido ou apagado.
   */
  async cleanUploads(
    mode: UploadsCleanupMode,
    progress: RoutineProgress<UploadsCleanupSummary> = idleProgress(),
    trigger: UploadsCleanupSummary['trigger'] = 'manual',
  ): Promise<UploadsCleanupSummary> {
    const dir = uploadsDir();
    const counts = emptyCleanupCounts(mode, trigger);
    const cutoff = this.now().getTime() - UPLOADS_CLEANUP_MIN_AGE_MS;
    this.logger.log(
      `Limpeza de arquivos sem uso (${mode === 'delete' ? 'apagar' : 'só verificar'}) em ${dir}`,
    );

    const files = await this.listUploadFiles(dir, counts, progress);
    const referenced = await this.uploadReferences(counts, progress);

    const orphans: UploadFile[] = [];
    for (const file of files) {
      if (referenced.has(uploadFileKey(file.name))) counts.in_use += 1;
      else if (file.mtimeMs > cutoff) counts.recent += 1;
      else {
        counts.orphans += 1;
        counts.orphan_bytes += file.size;
        orphans.push(file);
      }
    }
    if (mode !== 'delete') return counts;

    try {
      for (
        let start = 0;
        start < orphans.length;
        start += MAINTENANCE_BATCH_SIZE
      ) {
        const batch = orphans.slice(start, start + MAINTENANCE_BATCH_SIZE);
        await progress.batch(counts);
        const inUse = await this.referencedNow(batch.map((file) => file.name));
        for (const file of batch) {
          await progress.item(counts);
          await this.removeOrphan(dir, file, cutoff, inUse, counts);
        }
      }
    } finally {
      // Arquivos apagados (inclusive se parou no meio): o uso de armazenamento das lojas é medido de novo
      if (counts.deleted > 0) storeStorageUsage.invalidateAll();
    }
    return counts;
  }

  /** Imagens do primeiro nível da pasta (o resto é contado como ignorado e nunca apagado). */
  private async listUploadFiles(
    dir: string,
    counts: UploadsCleanupCounts,
    progress: RoutineProgress<UploadsCleanupCounts>,
  ): Promise<UploadFile[]> {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.logger.warn('Pasta de uploads não encontrada: nada a limpar.');
        return [];
      }
      throw error;
    }

    const files: UploadFile[] = [];
    for (let index = 0; index < names.length; index += 1) {
      if (index % MAINTENANCE_BATCH_SIZE === 0) await progress.batch(counts);
      await progress.item(counts);
      const name = names[index];
      if (!isCleanupCandidateName(name)) {
        counts.skipped += 1;
        continue;
      }
      // lstat: um atalho (symlink) nunca é seguido; pastas e afins ficam de fora
      const stats = await fs.lstat(path.join(dir, name)).catch(() => null);
      if (!stats) continue; // sumiu no meio da leitura
      if (!stats.isFile()) {
        counts.skipped += 1;
        continue;
      }
      counts.files_scanned += 1;
      files.push({ name, size: stats.size, mtimeMs: stats.mtimeMs });
    }
    return files;
  }

  /** Chaves de todos os arquivos referenciados pelos cadastros (inclusive lixeira e contas apagadas). */
  private async uploadReferences(
    counts: UploadsCleanupCounts,
    progress: RoutineProgress<UploadsCleanupCounts>,
  ): Promise<Set<string>> {
    const keys = new Set<string>();
    for (const source of this.referenceSources()) {
      for await (const batch of this.batches(
        (afterId) => source.page(afterId, REFERENCE_BATCH_SIZE),
        REFERENCE_BATCH_SIZE,
      )) {
        await progress.batch(counts);
        for (const row of batch) {
          const key = uploadReferenceKey(row.ref);
          if (key) keys.add(key);
        }
      }
    }
    return keys;
  }

  /** Conferência final de um lote: quais destes arquivos algum cadastro passou a usar. */
  private async referencedNow(names: string[]): Promise<Set<string>> {
    const values = names.flatMap(uploadReferenceVariants);
    const keys = new Set<string>();
    for (const source of this.referenceSources()) {
      for (const row of await source.matching(values)) {
        const key = uploadReferenceKey(row.ref);
        if (key) keys.add(key);
      }
    }
    return keys;
  }

  /** Apaga o arquivo se ele continua sem uso, antigo e um arquivo comum dentro da pasta de uploads. */
  private async removeOrphan(
    dir: string,
    file: UploadFile,
    cutoff: number,
    inUse: Set<string>,
    counts: UploadsCleanupCounts,
  ): Promise<void> {
    const forget = () => {
      counts.orphans -= 1;
      counts.orphan_bytes -= file.size;
    };
    if (inUse.has(uploadFileKey(file.name))) {
      forget();
      counts.in_use += 1;
      return;
    }
    const target = path.join(dir, file.name);
    // O nome já foi validado (sem barras nem "..") e a pasta é absoluta: conferência redundante
    if (path.dirname(target) !== dir || !isCleanupCandidateName(file.name)) {
      forget();
      counts.skipped += 1;
      return;
    }
    const stats = await fs.lstat(target).catch(() => null);
    if (!stats) {
      // Sumiu desde a leitura da pasta (outra limpeza ou remoção manual)
      forget();
      counts.files_scanned -= 1;
      return;
    }
    if (!stats.isFile()) {
      forget();
      counts.files_scanned -= 1;
      counts.skipped += 1;
      return;
    }
    if (stats.mtimeMs > cutoff) {
      forget();
      counts.recent += 1;
      return;
    }
    try {
      await fs.unlink(target);
    } catch (error) {
      counts.failed += 1;
      const code = errorCode(error);
      this.logger.warn(
        `Não foi possível apagar ${safeForLog(file.name)}${code ? ` (${code})` : ''}.`,
      );
      return;
    }
    counts.deleted += 1;
    counts.deleted_bytes += stats.size;
    this.logger.log(`Arquivo sem uso apagado: ${safeForLog(file.name)}`);
  }

  /** As colunas que guardam arquivos de uploads. */
  private referenceSources(): ReferenceSource[] {
    return [
      this.referenceSource(this.productRepository, 'image'),
      this.referenceSource(this.addonRepository, 'image'),
      this.referenceSource(this.userRepository, 'avatar'),
      this.referenceSource(this.storeRepository(), 'logo'),
    ];
  }

  private referenceSource<T extends { id: number }>(
    repository: Repository<T>,
    column: keyof T & string,
  ): ReferenceSource {
    const read = (where: Record<string, unknown>, take?: number) =>
      repository
        .find({
          withDeleted: true,
          select: {
            id: true,
            [column]: true,
          } as unknown as FindOptionsSelect<T>,
          where: where as FindOptionsWhere<T>,
          order: { id: 'ASC' } as FindOptionsOrder<T>,
          take,
        })
        .then((rows) =>
          rows.map((row): ReferenceRow => ({ id: row.id, ref: row[column] })),
        );
    return {
      page: (afterId, take) =>
        read({ id: MoreThan(afterId), [column]: Not(IsNull()) }, take),
      matching: (values) => read({ [column]: In(values) }),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // A rotina da otimização (sem trava própria: use startImageOptimization)
  // ---------------------------------------------------------------------------------------------

  /** Converte as imagens antigas de produtos, adicionais e avatares, em lotes. */
  async optimizeEverything(
    progress: OptimizationProgress = idleProgress(),
  ): Promise<OptimizationSummary> {
    const dir = uploadsDir();
    this.logger.log(`Otimizando imagens em ${dir}`);
    const counts = emptyCounts();

    await this.optimizeProducts(dir, counts, progress);
    await this.optimizeAddons(dir, counts, progress);
    await this.optimizeAvatars(dir, counts, progress);

    return {
      message: OPTIMIZATION_DONE_MESSAGE,
      itemsProcessed: counts.products + counts.addons + counts.avatars,
      ...counts,
    };
  }

  // 1. Imagens de produtos (o banco guarda só o nome do arquivo)
  private async optimizeProducts(
    dir: string,
    counts: OptimizationCounts,
    progress: OptimizationProgress,
  ): Promise<void> {
    for await (const batch of this.batches((afterId) =>
      this.productRepository.find({
        withDeleted: true,
        select: { id: true, store_id: true, name: true, image: true },
        where: { id: MoreThan(afterId), image: convertibleImage() },
        order: { id: 'ASC' },
        take: MAINTENANCE_BATCH_SIZE,
      }),
    )) {
      await progress.batch(counts);
      for (const product of batch) {
        await progress.item(counts);
        const image = await this.convert(dir, product.image, product.store_id);
        if (!image) {
          counts.skipped++;
          continue;
        }
        // Só grava se a imagem não mudou desde a leitura (a loja pode ter trocado a foto no meio)
        const { affected } = await this.productRepository.update(
          { id: product.id, image: product.image },
          { image },
        );
        if (!affected) {
          await this.discard(dir, image);
          continue;
        }
        this.logger.log(
          `Produto ${product.id} [${safeForLog(product.name)}] → WebP`,
        );
        counts.products++;
      }
    }
  }

  // 2. Imagens de adicionais (mesmo formato dos produtos)
  private async optimizeAddons(
    dir: string,
    counts: OptimizationCounts,
    progress: OptimizationProgress,
  ): Promise<void> {
    for await (const batch of this.batches((afterId) =>
      this.addonRepository.find({
        withDeleted: true,
        select: { id: true, store_id: true, image: true },
        where: { id: MoreThan(afterId), image: convertibleImage() },
        order: { id: 'ASC' },
        take: MAINTENANCE_BATCH_SIZE,
      }),
    )) {
      await progress.batch(counts);
      for (const addon of batch) {
        await progress.item(counts);
        const image = await this.convert(dir, addon.image, addon.store_id);
        if (!image) {
          counts.skipped++;
          continue;
        }
        const { affected } = await this.addonRepository.update(
          { id: addon.id, image: addon.image },
          { image },
        );
        if (!affected) {
          await this.discard(dir, image);
          continue;
        }
        this.logger.log(`Adicional ${addon.id} → WebP`);
        counts.addons++;
      }
    }
  }

  // 3. Avatares (o banco guarda "/uploads/<arquivo>" ou uma URL externa). Conta global: sem loja.
  private async optimizeAvatars(
    dir: string,
    counts: OptimizationCounts,
    progress: OptimizationProgress,
  ): Promise<void> {
    for await (const batch of this.batches((afterId) =>
      this.userRepository.find({
        withDeleted: true,
        select: { id: true, avatar: true },
        where: { id: MoreThan(afterId), avatar: convertibleImage() },
        order: { id: 'ASC' },
        take: MAINTENANCE_BATCH_SIZE,
      }),
    )) {
      await progress.batch(counts);
      for (const user of batch) {
        await progress.item(counts);
        const file = user.avatar.replace(/^\/?uploads\//, '');
        const image = await this.convert(dir, file, null);
        if (!image) {
          counts.skipped++;
          continue;
        }
        const { affected } = await this.userRepository.update(
          { id: user.id, avatar: user.avatar },
          { avatar: `/uploads/${image}` },
        );
        if (!affected) {
          await this.discard(dir, image);
          continue;
        }
        this.logger.log(`Avatar do usuário ${user.id} → WebP`);
        counts.avatars++;
      }
    }
  }

  /**
   * Converte a imagem e devolve o nome do novo .webp (ou null se não deu).
   * O arquivo de uma loja mantém o prefixo dela (s<id>-); a imagem antiga, sem prefixo, de um item
   * do cardápio ganha o prefixo da loja dona (ownerStoreId) e passa a ser um arquivo da loja.
   */
  private convert(
    dir: string,
    image: string | null | undefined,
    ownerStoreId: number | null,
  ): Promise<string | null> {
    if (!needsConversion(image)) return Promise.resolve(null);
    const prefix =
      ownerStoreId === null || isAnyStoreFile(image)
        ? ''
        : storeFilePrefix(ownerStoreId);
    return this.compressFile(dir, image, prefix);
  }

  private async compressFile(
    dir: string,
    filename: string,
    prefix: string,
  ): Promise<string | null> {
    // basename impede caminhos fora da pasta de uploads (ex.: "../arquivo"). Um nome com pastas não
    // é convertido: apontaria para outro arquivo que só tem o mesmo nome
    const safeName = path.basename(filename);
    if (!safeName || safeName !== filename || safeName.startsWith('.')) {
      // Valor vindo do banco (ex.: avatar antigo em texto livre): escapado, sem forjar linhas no log
      this.logger.warn(
        `Imagem ignorada (fora da pasta de uploads): ${safeForLog(filename)}`,
      );
      return null;
    }
    const source = path.join(dir, safeName);

    try {
      await fs.access(source);
    } catch {
      this.logger.warn(
        `Arquivo não encontrado no disco: ${safeForLog(safeName)}`,
      );
      return null;
    }

    // Novo nome: [prefixo da loja]<original>-<timestamp>.webp (o original já traz o prefixo, se tinha)
    const newFilename = `${prefix}${path.parse(safeName).name}-${Date.now()}.webp`;

    try {
      await sharp(source)
        .rotate()
        .resize({ width: 800, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(path.join(dir, newFilename));
      return newFilename;
    } catch (error) {
      this.logger.error(
        `Erro ao processar ${safeForLog(safeName)}: ${safeForLog((error as Error).message, 200)}`,
      );
      return null;
    }
  }

  /** Remove um .webp recém-gerado que não chegou a ser usado. */
  private async discard(dir: string, filename: string): Promise<void> {
    await fs.unlink(path.join(dir, filename)).catch(() => undefined);
  }
}
