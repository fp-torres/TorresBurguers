import type {
  UploadsCleanupCounts,
  UploadsCleanupMode,
} from './entities/maintenance-job.entity';

/**
 * Regras da limpeza dos arquivos sem uso da pasta de uploads (a rotina fica em maintenance.service.ts).
 *
 * Um arquivo só é apagado quando TUDO vale:
 * - está no primeiro nível da pasta de uploads e é um arquivo comum (pastas e atalhos nunca são seguidos);
 * - o nome é dos que a API grava (letras, números, ponto, hífen e sublinhado; nada de ocultos) e a
 *   extensão é de imagem (assim, nem uma pasta mal configurada perde um .json, .env ou .txt);
 * - nenhum cadastro o usa: products.image e addons.image (inclusive na lixeira), users.avatar (inclusive
 *   contas apagadas) e stores.logo;
 * - foi modificado há pelo menos 24 h (um envio recente pode ainda não ter sido salvo no cadastro).
 */

/** Idade mínima (pela data de modificação) de um arquivo sem uso para entrar na limpeza. */
export const UPLOADS_CLEANUP_MIN_AGE_HOURS = 24;
export const UPLOADS_CLEANUP_MIN_AGE_MS =
  UPLOADS_CLEANUP_MIN_AGE_HOURS * 60 * 60 * 1000;

export const UPLOADS_CLEANUP_MODES: readonly UploadsCleanupMode[] = [
  'check',
  'delete',
];

/** Nome gravado pela API: começa com letra ou número (nada de ocultos como .gitkeep). */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Só imagens podem ser apagadas. */
const IMAGE_EXTENSION =
  /\.(?:webp|png|jpe?g|gif|avif|bmp|tiff?|heic|heif|svg|ico)$/i;

/** O arquivo da pasta de uploads pode ser apagado se estiver sem uso? (só pelo nome) */
export function isCleanupCandidateName(name: string): boolean {
  return (
    name.length <= 255 && SAFE_NAME.test(name) && IMAGE_EXTENSION.test(name)
  );
}

/**
 * Chave de comparação de uma referência gravada no banco: o último trecho do caminho ou da URL, sem
 * ?query nem #âncora, em minúsculas. Cobre "arquivo.webp", "/uploads/arquivo.webp" e
 * "http://servidor/uploads/arquivo.webp". Uma URL externa com o mesmo nome de um arquivo local só
 * faz a limpeza manter o arquivo (erra sempre para o lado de não apagar). Minúsculas porque, em
 * disco que não diferencia maiúsculas (Windows), "Foto.PNG" serve o arquivo "foto.png".
 */
export function uploadReferenceKey(ref: unknown): string | null {
  if (typeof ref !== 'string') return null;
  const value = ref.trim().split(/[?#]/, 1)[0];
  const name = value.slice(
    Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1,
  );
  return name ? name.toLowerCase() : null;
}

/** Chave de um arquivo da pasta (mesma regra das referências). */
export const uploadFileKey = (name: string): string => name.toLowerCase();

/**
 * Formas exatas com que um arquivo é gravado pelos cadastros: a conferência final, feita logo antes
 * de apagar cada lote, procura estes valores no banco.
 */
export function uploadReferenceVariants(name: string): string[] {
  return [name, `/uploads/${name}`, `uploads/${name}`];
}

/** Arquivo da pasta de uploads examinado pela limpeza. */
export interface UploadFile {
  name: string;
  size: number;
  mtimeMs: number;
}

/** Quem iniciou a limpeza: o superadmin pelo superpainel (manual) ou o agendamento (schedule). */
export type UploadsCleanupTrigger = 'manual' | 'schedule';

/** Resumo gravado da limpeza: as contagens + de onde ela veio (nada de nomes ou caminhos). */
export interface UploadsCleanupSummary extends UploadsCleanupCounts {
  trigger: UploadsCleanupTrigger;
}

export function emptyCleanupCounts(
  mode: UploadsCleanupMode,
  trigger: UploadsCleanupTrigger = 'manual',
): UploadsCleanupSummary {
  return {
    mode,
    trigger,
    min_age_hours: UPLOADS_CLEANUP_MIN_AGE_HOURS,
    files_scanned: 0,
    in_use: 0,
    recent: 0,
    orphans: 0,
    orphan_bytes: 0,
    deleted: 0,
    deleted_bytes: 0,
    failed: 0,
    skipped: 0,
  };
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;

/** summary (jsonb) de uma limpeza lido do banco: só os campos conhecidos, sempre números (e os dois enums). */
export function readCleanupCounts(raw: unknown): UploadsCleanupSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  return {
    mode: value.mode === 'delete' ? 'delete' : 'check',
    // Execuções anteriores ao agendamento não tinham o campo: todas foram manuais
    trigger: value.trigger === 'schedule' ? 'schedule' : 'manual',
    min_age_hours: count(value.min_age_hours) || UPLOADS_CLEANUP_MIN_AGE_HOURS,
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

// -------------------------------------------------------------------------------------------------
// Limpeza agendada (UPLOADS_CLEANUP_INTERVAL_HOURS)
// -------------------------------------------------------------------------------------------------

/** Menor intervalo aceito (valores menores sobem para este; útil só em testes). */
export const UPLOADS_CLEANUP_MIN_INTERVAL_MS = 10_000;
/** A API confere se está na hora no máximo a cada 5 min (ou a cada intervalo, se ele for menor). */
export const UPLOADS_CLEANUP_MAX_CHECK_MS = 5 * 60 * 1000;

export interface UploadsCleanupScheduleConfig {
  enabled: boolean;
  /** Intervalo configurado em horas (null = desligado). */
  intervalHours: number | null;
  /** Intervalo efetivo em ms (com o mínimo aplicado). */
  intervalMs: number | null;
  /** De quanto em quanto tempo a API confere se está na hora. */
  checkMs: number | null;
  /** Valor inválido na variável (vai para o log na subida); null = válido ou vazio. */
  problem: string | null;
}

const DISABLED: UploadsCleanupScheduleConfig = {
  enabled: false,
  intervalHours: null,
  intervalMs: null,
  checkMs: null,
  problem: null,
};

/**
 * UPLOADS_CLEANUP_INTERVAL_HOURS: de quantas em quantas horas a limpeza dos arquivos sem uso roda sozinha,
 * no modo que apaga (só imagens sem uso há mais de 24 h, como a manual). Vazio, 0 ou off = desligada (o
 * padrão). Aceita decimais ("0.5" ou "0,5" = 30 min); abaixo de 10 s vale 10 s. Inválido = desligada,
 * com aviso no log.
 */
export function uploadsCleanupScheduleConfig(
  env: NodeJS.ProcessEnv = process.env,
): UploadsCleanupScheduleConfig {
  const raw = env.UPLOADS_CLEANUP_INTERVAL_HOURS?.trim();
  if (!raw || /^(0+([.,]0*)?|off|false|no|nao|não)$/i.test(raw)) {
    return DISABLED;
  }
  const hours = /^\d+([.,]\d+)?$/.test(raw)
    ? Number(raw.replace(',', '.'))
    : Number.NaN;
  if (!Number.isFinite(hours) || hours <= 0) {
    return {
      ...DISABLED,
      problem: `UPLOADS_CLEANUP_INTERVAL_HOURS="${raw.slice(0, 40)}" inválido (use um número de horas, ex.: 24): limpeza agendada desligada.`,
    };
  }
  const intervalMs = Math.max(
    Math.round(hours * 60 * 60 * 1000),
    UPLOADS_CLEANUP_MIN_INTERVAL_MS,
  );
  return {
    enabled: true,
    intervalHours: hours,
    intervalMs,
    checkMs: Math.min(intervalMs, UPLOADS_CLEANUP_MAX_CHECK_MS),
    problem: null,
  };
}

/**
 * Está na hora da limpeza agendada? Sim se nunca rodou ou se a última execução agendada (de qualquer
 * instância) começou há pelo menos um intervalo — com folga de meia conferência, para a conferência que
 * cai logo antes do horário não empurrar a execução para a seguinte.
 */
export function isScheduledCleanupDue(
  lastStartedAt: Date | string | null,
  now: Date,
  config: Pick<UploadsCleanupScheduleConfig, 'intervalMs' | 'checkMs'>,
): boolean {
  if (config.intervalMs === null || config.checkMs === null) return false;
  if (lastStartedAt === null) return true;
  const elapsed = now.getTime() - new Date(lastStartedAt).getTime();
  return elapsed >= config.intervalMs - config.checkMs / 2;
}

/** Resumo de uma linha para o log. */
export function describeCleanup(counts: UploadsCleanupCounts): string {
  const found = `${counts.orphans} sem uso (${counts.orphan_bytes} bytes)`;
  return counts.mode === 'delete'
    ? `${found}, ${counts.deleted} apagados (${counts.deleted_bytes} bytes), ${counts.failed} falhas`
    : `${found}, ${counts.in_use} em uso, ${counts.recent} recentes`;
}
