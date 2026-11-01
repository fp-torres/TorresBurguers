import axios from 'axios';
import api from '../api';
import { asRecord, isRecord, readArray, readDate, readEnum, readId, readNullableText, readNumber, readText } from '../panelParsers';

// Superpainel › Manutenção (backend: common/maintenance.controller.ts e maintenance.service.ts; somente SUPER_ADMIN).
//
// Rotinas em SEGUNDO PLANO, uma execução por vez de cada tipo em todas as instâncias da API:
// - Otimização de imagens: converte para WebP as imagens antigas de produtos, adicionais e fotos de perfil de TODAS
//   as lojas, em lotes e sem apagar os originais.
//   POST /platform/maintenance/optimize-images → 202 { job } ou 409 { message, job } com a execução em andamento;
//   GET  /platform/maintenance/optimize-images → { job | null }.
// - Limpeza dos arquivos sem uso: imagens da pasta de uploads que nenhum cadastro usa (produtos e adicionais, inclusive
//   na lixeira, fotos de perfil e logos) e que não mudam há mais de 24 h. "check" só conta; "delete" apaga.
//   POST /platform/maintenance/cleanup-uploads { mode: 'check' } ou { mode: 'delete', confirm: true } → 202 { job } / 409;
//   GET  /platform/maintenance/cleanup-uploads → { job | null } (a última verificação ou exclusão, manual ou agendada);
//   com ?include=schedule → { job, schedule } (limpeza agendada pela variável UPLOADS_CLEANUP_INTERVAL_HOURS da API).
// Ação imediata:
// - Credenciais Mercado Pago no formato antigo (v1) regravadas no atual, preso à loja (v2); idempotente:
//   GET  /platform/maintenance/store-credentials → { total, current, legacy, unknown };
//   POST /platform/maintenance/store-credentials/reencrypt → { total, migrated, already_current, changed, failed, failed_store_ids }.
// Tudo fica na auditoria (platform.maintenance.*), só com contagens.

export type MaintenanceJobStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED';

const JOB_STATUSES: readonly MaintenanceJobStatus[] = ['RUNNING', 'SUCCEEDED', 'FAILED'];

export interface ImageOptimizationSummary {
  /** Total convertido para WebP (produtos + adicionais + fotos de perfil). */
  items_processed: number;
  products: number;
  addons: number;
  avatars: number;
  /** Arquivo ausente no disco, ilegível ou fora da pasta de uploads. */
  skipped: number;
}

/** check = só relatório (nada é apagado); delete = apaga os arquivos sem uso. */
export type UploadsCleanupMode = 'check' | 'delete';

const CLEANUP_MODES: readonly UploadsCleanupMode[] = ['check', 'delete'];

/** Quem iniciou a limpeza: o superadmin (manual) ou o agendamento da API (schedule, sem started_by). */
export type UploadsCleanupTrigger = 'manual' | 'schedule';

/** Contagens da limpeza (só números: nunca nomes de arquivo). */
export interface UploadsCleanupSummary {
  mode: UploadsCleanupMode;
  trigger: UploadsCleanupTrigger;
  /** Idade mínima, em horas, para um arquivo sem uso entrar na limpeza. */
  min_age_hours: number;
  /** Imagens examinadas na pasta de uploads. */
  files_scanned: number;
  /** Usadas por algum cadastro: ficam. */
  in_use: number;
  /** Sem uso, mas modificadas há menos de min_age_hours: ficam. */
  recent: number;
  /** Sem uso e antigas (o que a limpeza apaga). */
  orphans: number;
  orphan_bytes: number;
  deleted: number;
  deleted_bytes: number;
  /** Não foi possível apagar (erro do disco). */
  failed: number;
  /** Pastas, atalhos, ocultos, nomes fora do padrão e arquivos que não são imagem: nunca apagados. */
  skipped: number;
}

export interface MaintenanceJob<S = ImageOptimizationSummary> {
  id: number;
  status: MaintenanceJobStatus;
  started_at: string | null;
  /** Última notícia da rotina (renovada a cada lote). */
  heartbeat_at: string | null;
  finished_at: string | null;
  /** Do início ao fim (ou até a consulta, se ainda em andamento). */
  duration_ms: number;
  /** Contagens (parciais enquanto RUNNING). */
  summary: S | null;
  /** Motivo curto da falha. */
  error: string | null;
  started_by: { id: number; name: string } | null;
}

export type UploadsCleanupJob = MaintenanceJob<UploadsCleanupSummary>;

/** Limpeza agendada (GET /platform/maintenance/cleanup-uploads?include=schedule → schedule). */
export interface UploadsCleanupSchedule {
  /** UPLOADS_CLEANUP_INTERVAL_HOURS configurada (maior que zero) na API. */
  enabled: boolean;
  /** De quantas em quantas horas (null = desligada). */
  interval_hours: number | null;
  /** A agendada sempre apaga (só imagens sem uso há mais de min_age_hours). */
  mode: UploadsCleanupMode;
  min_age_hours: number;
  /** Próxima execução prevista (aproximada); null = desligada. */
  next_run_at: string | null;
  /** A última limpeza agendada (null se nunca rodou). */
  last_run: UploadsCleanupJob | null;
}

export type StartJobResult<S> =
  | { started: true; job: MaintenanceJob<S> }
  /** 409: já existe uma execução em andamento (job = ela; null se ela terminou no meio da conferência). */
  | { started: false; job: MaintenanceJob<S> | null; message: string };

export type StartImageOptimizationResult = StartJobResult<ImageOptimizationSummary>;
export type StartUploadsCleanupResult = StartJobResult<UploadsCleanupSummary>;

/** Lojas com Access Token gravado, por formato (o token nunca sai da API). */
export interface StoreCredentialsStatus {
  total: number;
  /** Formato atual (preso à loja). */
  current: number;
  /** Formato antigo: a regravação passa para o atual. */
  legacy: number;
  /** Ilegíveis: a loja precisa salvar as credenciais de novo. */
  unknown: number;
}

export interface StoreCredentialsReencryption {
  total: number;
  /** Regravadas agora no formato atual. */
  migrated: number;
  /** Já estavam no formato atual (não mudam). */
  already_current: number;
  /** A loja salvou ou removeu as credenciais durante a ação: ficam como ela deixou. */
  changed: number;
  /** Ilegíveis: ficam como estão. */
  failed: number;
  /** Lojas com credenciais ilegíveis (até 100). */
  failed_store_ids: number[];
}

const count = (value: unknown) => Math.max(0, Math.trunc(readNumber(value, 0)));

function toSummary(value: unknown): ImageOptimizationSummary | null {
  if (!isRecord(value)) return null;
  return {
    items_processed: count(value.items_processed),
    products: count(value.products),
    addons: count(value.addons),
    avatars: count(value.avatars),
    skipped: count(value.skipped),
  };
}

function toCleanupSummary(value: unknown): UploadsCleanupSummary | null {
  if (!isRecord(value)) return null;
  return {
    mode: readEnum(value.mode, CLEANUP_MODES, 'check'),
    trigger: value.trigger === 'schedule' ? 'schedule' : 'manual',
    min_age_hours: count(value.min_age_hours) || 24,
    files_scanned: count(value.files_scanned),
    in_use: count(value.in_use),
    recent: count(value.recent),
    orphans: count(value.orphans),
    orphan_bytes: count(value.orphan_bytes),
    deleted: count(value.deleted),
    deleted_bytes: count(value.deleted_bytes),
    failed: count(value.failed),
    skipped: count(value.skipped),
  };
}

function toJob<S>(value: unknown, readSummary: (raw: unknown) => S | null): MaintenanceJob<S> | null {
  if (!isRecord(value)) return null;
  const id = readId(value.id);
  if (!id) return null;
  const startedBy = isRecord(value.started_by) ? value.started_by : null;
  return {
    id,
    // Situação desconhecida conta como terminada (a tela não fica acompanhando para sempre)
    status: readEnum(value.status, JOB_STATUSES, 'FAILED'),
    started_at: readDate(value.started_at),
    heartbeat_at: readDate(value.heartbeat_at),
    finished_at: readDate(value.finished_at),
    duration_ms: count(value.duration_ms),
    summary: readSummary(value.summary),
    error: readNullableText(value.error),
    started_by: startedBy ? { id: readId(startedBy.id), name: readText(startedBy.name) } : null,
  };
}

/** Execução da otimização (null se a resposta não trouxer uma execução válida). */
export function toMaintenanceJob(value: unknown): MaintenanceJob | null {
  return toJob(value, toSummary);
}

/** Execução da limpeza de arquivos (null se a resposta não trouxer uma execução válida). */
export function toUploadsCleanupJob(value: unknown): UploadsCleanupJob | null {
  return toJob(value, toCleanupSummary);
}

/** schedule da resposta (null quando a API não informou: versão anterior ao agendamento). */
export function toUploadsCleanupSchedule(value: unknown): UploadsCleanupSchedule | null {
  if (!isRecord(value)) return null;
  const hours = Number(value.interval_hours);
  return {
    enabled: value.enabled === true,
    interval_hours: Number.isFinite(hours) && hours > 0 ? hours : null,
    mode: readEnum(value.mode, CLEANUP_MODES, 'delete'),
    min_age_hours: count(value.min_age_hours) || 24,
    next_run_at: readDate(value.next_run_at),
    last_run: toUploadsCleanupJob(value.last_run),
  };
}

/** POST que inicia uma execução: 202 { job }; 409 não é erro aqui (devolve a execução em andamento). */
async function startJob<S>(
  path: string,
  body: Record<string, unknown> | undefined,
  parse: (value: unknown) => MaintenanceJob<S> | null,
  runningMessage: string,
): Promise<StartJobResult<S>> {
  try {
    const { data } = await api.post<unknown>(path, body);
    const job = parse(asRecord(data).job);
    if (!job) throw new Error('A API não devolveu a execução iniciada.');
    return { started: true, job };
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 409) {
      const payload = asRecord(error.response.data);
      return { started: false, job: parse(payload.job), message: readText(payload.message, runningMessage) };
    }
    throw error;
  }
}

export const platformMaintenanceService = {
  /** GET /platform/maintenance/optimize-images: a última execução (null se nunca rodou). */
  async latestImageOptimization(signal?: AbortSignal): Promise<MaintenanceJob | null> {
    const { data } = await api.get<unknown>('/platform/maintenance/optimize-images', { signal });
    return toMaintenanceJob(asRecord(data).job);
  },

  /**
   * POST /platform/maintenance/optimize-images: inicia em segundo plano (202) e devolve a execução, sem esperar o fim.
   * 409 não é erro aqui: devolve a execução que já está em andamento. Os demais erros são lançados.
   */
  startImageOptimization(): Promise<StartImageOptimizationResult> {
    return startJob(
      '/platform/maintenance/optimize-images',
      undefined,
      toMaintenanceJob,
      'Já existe uma otimização de imagens em andamento. Aguarde a conclusão.',
    );
  },

  /** GET /platform/maintenance/cleanup-uploads: a última verificação ou exclusão (null se nunca rodou). */
  async latestUploadsCleanup(signal?: AbortSignal): Promise<UploadsCleanupJob | null> {
    const { data } = await api.get<unknown>('/platform/maintenance/cleanup-uploads', { signal });
    return toUploadsCleanupJob(asRecord(data).job);
  },

  /** GET /platform/maintenance/cleanup-uploads?include=schedule: a situação da limpeza agendada (null = API sem ela). */
  async uploadsCleanupSchedule(signal?: AbortSignal): Promise<UploadsCleanupSchedule | null> {
    const { data } = await api.get<unknown>('/platform/maintenance/cleanup-uploads', { params: { include: 'schedule' }, signal });
    return toUploadsCleanupSchedule(asRecord(data).schedule);
  },

  /**
   * POST /platform/maintenance/cleanup-uploads: check só conta; delete apaga (a confirmação vai junto, depois do
   * diálogo da tela). 409 devolve a limpeza em andamento.
   */
  startUploadsCleanup(mode: UploadsCleanupMode): Promise<StartUploadsCleanupResult> {
    return startJob(
      '/platform/maintenance/cleanup-uploads',
      mode === 'delete' ? { mode, confirm: true } : { mode },
      toUploadsCleanupJob,
      'Já existe uma limpeza de arquivos em andamento. Aguarde a conclusão.',
    );
  },

  /** GET /platform/maintenance/store-credentials: quantas lojas têm credenciais em cada formato. */
  async storeCredentialsStatus(signal?: AbortSignal): Promise<StoreCredentialsStatus> {
    const { data } = await api.get<unknown>('/platform/maintenance/store-credentials', { signal });
    const value = asRecord(data);
    return {
      total: count(value.total),
      current: count(value.current),
      legacy: count(value.legacy),
      unknown: count(value.unknown),
    };
  },

  /** POST /platform/maintenance/store-credentials/reencrypt: regrava as antigas no formato atual (idempotente). */
  async reencryptStoreCredentials(): Promise<StoreCredentialsReencryption> {
    const { data } = await api.post<unknown>('/platform/maintenance/store-credentials/reencrypt');
    const value = asRecord(data);
    return {
      total: count(value.total),
      migrated: count(value.migrated),
      already_current: count(value.already_current),
      changed: count(value.changed),
      failed: count(value.failed),
      failed_store_ids: readArray(value.failed_store_ids)
        .map((id) => readId(id))
        .filter((id) => id > 0),
    };
  },
};
