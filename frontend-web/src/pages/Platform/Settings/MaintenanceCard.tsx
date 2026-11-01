import { useEffect, useId, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ImageDown,
  Info,
  KeyRound,
  Loader2,
  ScanSearch,
  Trash2,
  Wrench,
  XCircle,
} from 'lucide-react';
import { CARD_CLASS, StatusBadge, buttonClass, cx, type StatusTone } from '../../../components/ui';
import ConfirmModal from '../../../components/ConfirmModal';
import { usePolling } from '../../../hooks/usePolling';
import { useResource } from '../../../hooks/useResource';
import { getApiErrorMessage } from '../../../services/api';
import {
  platformMaintenanceService,
  type ImageOptimizationSummary,
  type MaintenanceJob,
  type MaintenanceJobStatus,
  type StoreCredentialsReencryption,
  type UploadsCleanupJob,
  type UploadsCleanupMode,
  type UploadsCleanupSchedule,
  type UploadsCleanupSummary,
} from '../../../services/platform/maintenanceService';
import { formatDateTime, formatTime, formatInteger } from '../../../utils/format';
import { plural } from '../Dashboard/insightsFormat';
import { useNow } from '../../../hooks/useNow';

/** Acompanhamento da execução em andamento: GET a cada 3 s (sem acumular consultas; pausa com a aba oculta). */
const POLL_INTERVAL_MS = 3_000;

type Notice = {
  tone: 'info' | 'error' | 'success';
  message: string;
  /** Aviso sobre uma execução em andamento: some quando ela terminar. */
  jobId?: number;
};

const STATUS_META: Record<MaintenanceJobStatus, { label: string; tone: StatusTone; panel: string }> = {
  RUNNING: {
    label: 'Em andamento',
    tone: 'info',
    panel: 'border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-900/10',
  },
  SUCCEEDED: {
    label: 'Concluída',
    tone: 'success',
    panel: 'border-green-200 dark:border-green-800 bg-green-50/60 dark:bg-green-900/10',
  },
  FAILED: {
    label: 'Falhou',
    tone: 'danger',
    panel: 'border-red-200 dark:border-red-800 bg-red-50/60 dark:bg-red-900/10',
  },
};

const COUNTERS: Array<{ key: Exclude<keyof ImageOptimizationSummary, 'items_processed'>; label: string; hint?: string }> = [
  { key: 'products', label: 'Produtos' },
  { key: 'addons', label: 'Adicionais' },
  { key: 'avatars', label: 'Fotos de perfil' },
  { key: 'skipped', label: 'Ignoradas', hint: 'Arquivo ausente no disco, ilegível ou fora da pasta de uploads.' },
];

/** 65_000 → "1 min 05 s"; 3_725_000 → "1 h 02 min". */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return 'menos de 1 s';
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, '0')} min`;
  if (minutes > 0) return `${minutes} min ${String(seconds).padStart(2, '0')} s`;
  return `${seconds} s`;
}

const sizeFormatter = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

/** 1_536 → "1,5 KB"; 12_900_000 → "12,3 MB". */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${formatInteger(Math.max(0, Math.trunc(bytes || 0)))} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${sizeFormatter.format(value)} ${units[unit]}`;
}

const converted = (summary: ImageOptimizationSummary | null) =>
  plural(summary?.items_processed ?? 0, 'imagem convertida', 'imagens convertidas');

/** Texto lido pelos leitores de tela quando a situação muda (os contadores, que mudam a cada 3 s, não são lidos). */
function announcement(job: MaintenanceJob | null): string {
  if (!job) return '';
  if (job.status === 'RUNNING') return 'Otimização de imagens em andamento.';
  if (job.status === 'SUCCEEDED') return `Otimização de imagens concluída: ${converted(job.summary)}.`;
  return `A otimização de imagens falhou. ${job.error ?? ''}`.trim();
}

/** Moldura comum da execução: situação, quem iniciou, duração e o aviso de falha na atualização. */
function JobFrame({
  job,
  refreshFailed,
  label,
  children,
}: {
  job: MaintenanceJob<unknown>;
  refreshFailed: boolean;
  /** Ex.: "Verificação" (aparece antes da situação). */
  label?: string;
  children: ReactNode;
}) {
  const meta = STATUS_META[job.status];
  const startedBy = job.started_by?.name ? ` por ${job.started_by.name}` : '';

  return (
    <div className={cx('rounded-2xl border p-4 space-y-3', meta.panel)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <StatusBadge
          tone={meta.tone}
          icon={
            job.status === 'RUNNING' ? <Loader2 size={12} className="animate-spin" />
              : job.status === 'SUCCEEDED' ? <CheckCircle2 size={12} />
                : <XCircle size={12} />
          }
        >
          {label ? `${label}: ${meta.label.toLowerCase()}` : meta.label}
        </StatusBadge>
        <span className="text-sm text-gray-600 dark:text-gray-300">
          {job.status === 'RUNNING'
            ? `Iniciada às ${formatTime(job.started_at)}${startedBy} · há ${formatDuration(job.duration_ms)}`
            : `Última execução: ${formatDateTime(job.started_at)}${startedBy} · duração ${formatDuration(job.duration_ms)}`}
        </span>
      </div>

      {children}

      {refreshFailed && (
        <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle size={14} aria-hidden="true" /> Não foi possível atualizar agora; tentando de novo em instantes.
        </p>
      )}
    </div>
  );
}

function Counter({ label, value, detail, hint }: { label: string; value: number; detail?: string; hint?: string }) {
  return (
    <div title={hint} className="rounded-xl border border-gray-200 dark:border-slate-700 bg-white/80 dark:bg-slate-800/60 px-3 py-2">
      <dt className="text-xs text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="text-lg font-bold text-gray-800 dark:text-white tabular-nums">
        {formatInteger(value)}
        {detail && <span className="ml-1 text-xs font-medium text-gray-500 dark:text-gray-400">{detail}</span>}
      </dd>
    </div>
  );
}

function NoticeLine({ notice }: { notice: Notice }) {
  return (
    <p
      role={notice.tone === 'error' ? 'alert' : 'status'}
      className={cx(
        'flex items-start gap-2 px-3 py-2 rounded-xl text-sm border',
        notice.tone === 'info' && 'bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800',
        notice.tone === 'error' && 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 border-red-200 dark:border-red-800',
        notice.tone === 'success' && 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300 border-green-200 dark:border-green-800',
      )}
    >
      {notice.tone === 'error'
        ? <XCircle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
        : notice.tone === 'success'
          ? <CheckCircle2 size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
          : <Info size={16} className="shrink-0 mt-0.5" aria-hidden="true" />}
      <span>{notice.message}</span>
    </p>
  );
}

/** Carregando / erro / nunca rodou: o que aparece no lugar da execução. */
function JobPlaceholder({
  loading,
  error,
  onRetry,
  emptyMessage,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  emptyMessage: string;
}) {
  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Carregando o último resultado...
      </p>
    );
  }
  if (error) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 px-3 py-2 rounded-xl text-sm bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
        <AlertTriangle size={16} className="shrink-0" aria-hidden="true" />
        <span className="flex-1 min-w-48">{error}</span>
        <button type="button" onClick={onRetry} className="font-bold hover:underline">Tentar novamente</button>
      </div>
    );
  }
  return <p className="text-sm text-gray-500 dark:text-gray-400">{emptyMessage}</p>;
}

/** Título e descrição de uma rotina, com os botões ao lado. */
function SectionHeader({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <h3 className="text-sm font-bold text-gray-800 dark:text-gray-100">{title}</h3>
        <p className="text-sm text-gray-600 dark:text-gray-300">{description}</p>
      </div>
      <div className="flex flex-wrap gap-2 shrink-0">{children}</div>
    </div>
  );
}

// -------------------------------------------------------------------------------------------------
// Otimizar imagens
// -------------------------------------------------------------------------------------------------

/** Converte para WebP as imagens antigas de todas as lojas, em segundo plano (os originais ficam). */
function ImageOptimizationSection() {
  const resource = useResource((signal) => platformMaintenanceService.latestImageOptimization(signal), {
    errorMessage: 'Não foi possível carregar o último resultado da otimização.',
  });
  const job = resource.data;
  const running = job?.status === 'RUNNING';
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Sem iniciar enquanto a consulta não volta: a resposta antiga sobrescreveria a execução nova
  const busy = running || starting || resource.loading || resource.refreshing;
  const visibleNotice = notice && (notice.jobId === undefined || (running && job?.id === notice.jobId)) ? notice : null;
  const summary = job?.summary ?? null;

  usePolling(() => resource.reload({ silent: true }), POLL_INTERVAL_MS, { enabled: running });

  async function start() {
    setStarting(true);
    setNotice(null);
    try {
      const result = await platformMaintenanceService.startImageOptimization();
      if (result.job) resource.setData(result.job);
      if (!result.started) {
        setNotice(
          result.job
            ? { tone: 'info', message: `${result.message} Acompanhe o andamento abaixo.`, jobId: result.job.id }
            : { tone: 'info', message: result.message },
        );
        // A outra execução terminou bem no meio da conferência: mostra o resultado dela
        if (!result.job) void resource.reload();
      }
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error, 'Não foi possível iniciar a otimização das imagens.') });
    } finally {
      setStarting(false);
      setConfirmOpen(false);
    }
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Otimizar imagens"
        description="Converte para WebP (arquivos menores) as imagens antigas em JPG/PNG de produtos, adicionais e fotos de perfil, inclusive de itens na lixeira. Os arquivos originais não são apagados; imagens enviadas hoje já são salvas em WebP. A rotina roda em segundo plano, uma de cada vez."
      >
        <button
          type="button"
          onClick={() => {
            setNotice(null);
            setConfirmOpen(true);
          }}
          disabled={busy}
          aria-busy={running || starting || undefined}
          className={buttonClass('primary', 'md')}
        >
          {running || starting ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <ImageDown size={16} aria-hidden="true" />}
          {running ? 'Em andamento...' : starting ? 'Iniciando...' : 'Otimizar imagens'}
        </button>
      </SectionHeader>

      {visibleNotice && <NoticeLine notice={visibleNotice} />}
      <p className="sr-only" aria-live="polite">{announcement(job)}</p>

      {job ? (
        <JobFrame job={job} refreshFailed={running && !!resource.error}>
          {job.status === 'RUNNING' && (
            <p className="text-sm text-blue-900 dark:text-blue-200">
              Convertendo em segundo plano: {converted(summary)} até agora. Esta tela acompanha sozinha até terminar; você pode
              sair e voltar depois.
              {job.heartbeat_at && <span className="block text-xs opacity-80 mt-0.5">Última atividade da rotina às {formatTime(job.heartbeat_at)}.</span>}
            </p>
          )}
          {job.status === 'SUCCEEDED' && (
            <p className="text-sm text-green-900 dark:text-green-200">
              <span className="font-bold">Otimização concluída.</span>{' '}
              {(summary?.items_processed ?? 0) === 0
                ? 'Nenhuma imagem precisava de conversão.'
                : `${converted(summary)} para WebP.`}
              {job.finished_at && ` Terminou às ${formatTime(job.finished_at)}.`}
            </p>
          )}
          {job.status === 'FAILED' && (
            <p className="text-sm text-red-900 dark:text-red-200">
              <span className="font-bold">{job.error ?? 'A execução falhou.'}</span>{' '}
              {(summary?.items_processed ?? 0) > 0
                ? `As conversões feitas antes da falha (${converted(summary)}) continuam valendo; rode de novo para concluir as demais.`
                : 'Você pode rodar de novo.'}
            </p>
          )}
          {summary && (
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {COUNTERS.map(({ key, label, hint }) => (
                <Counter key={key} label={label} value={summary[key]} hint={hint} />
              ))}
            </dl>
          )}
        </JobFrame>
      ) : (
        <JobPlaceholder
          loading={resource.loading}
          error={resource.error}
          onRetry={() => void resource.reload()}
          emptyMessage="Nenhuma otimização executada ainda."
        />
      )}

      <ConfirmModal
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void start()}
        closeOnConfirm={false}
        loading={starting}
        title="Otimizar as imagens agora?"
        confirmLabel="Otimizar imagens"
        message="A rotina percorre as imagens de todas as lojas em segundo plano e pode levar alguns minutos, usando processamento da API. Os originais são mantidos; o andamento aparece aqui e a execução fica registrada na auditoria."
      />
    </div>
  );
}

// -------------------------------------------------------------------------------------------------
// Limpar arquivos sem uso
// -------------------------------------------------------------------------------------------------

const unused = (amount: number) => plural(amount, 'arquivo sem uso', 'arquivos sem uso');

function cleanupAnnouncement(job: UploadsCleanupJob | null): string {
  if (!job) return '';
  const action = job.summary?.mode === 'delete' ? 'Exclusão dos arquivos sem uso' : 'Verificação dos arquivos sem uso';
  if (job.status === 'RUNNING') return `${action} em andamento.`;
  if (job.status === 'FAILED') return `${action} falhou. ${job.error ?? ''}`.trim();
  const summary = job.summary;
  return summary?.mode === 'delete'
    ? `${action} concluída: ${plural(summary.deleted, 'arquivo apagado', 'arquivos apagados')}.`
    : `${action} concluída: ${unused(summary?.orphans ?? 0)}.`;
}

function CleanupDetails({ job }: { job: UploadsCleanupJob }) {
  const summary: UploadsCleanupSummary | null = job.summary;
  const deleting = summary?.mode === 'delete';
  const hours = summary?.min_age_hours ?? 24;

  return (
    <>
      {job.status === 'RUNNING' && (
        <p className="text-sm text-blue-900 dark:text-blue-200">
          {deleting
            ? `Apagando em segundo plano: ${plural(summary?.deleted ?? 0, 'arquivo apagado', 'arquivos apagados')} até agora.`
            : `Verificando em segundo plano: ${plural(summary?.files_scanned ?? 0, 'imagem examinada', 'imagens examinadas')} até agora.`}{' '}
          Esta tela acompanha sozinha até terminar.
        </p>
      )}
      {job.status === 'SUCCEEDED' && summary && (
        <p className="text-sm text-green-900 dark:text-green-200">
          {deleting ? (
            <>
              <span className="font-bold">Limpeza concluída.</span>{' '}
              {summary.deleted === 0
                ? 'Nenhum arquivo precisava ser apagado.'
                : `${plural(summary.deleted, 'arquivo apagado', 'arquivos apagados')} (${formatBytes(summary.deleted_bytes)} liberados).`}
              {summary.failed > 0 &&
                ` ${plural(summary.failed, 'arquivo não pôde ser apagado', 'arquivos não puderam ser apagados')}; os detalhes estão no log da API.`}
            </>
          ) : (
            <>
              <span className="font-bold">Verificação concluída.</span>{' '}
              {summary.orphans === 0
                ? 'Nenhum arquivo sem uso para apagar.'
                : `${unused(summary.orphans)} há mais de ${hours} h (${formatBytes(summary.orphan_bytes)}) pode${summary.orphans === 1 ? '' : 'm'} ser apagado${summary.orphans === 1 ? '' : 's'}. Nada foi apagado.`}
            </>
          )}
        </p>
      )}
      {job.status === 'FAILED' && (
        <p className="text-sm text-red-900 dark:text-red-200">
          <span className="font-bold">{job.error ?? 'A execução falhou.'}</span>{' '}
          {deleting && (summary?.deleted ?? 0) > 0
            ? `Os arquivos apagados antes da falha (${formatInteger(summary?.deleted ?? 0)}) não voltam; rode de novo para concluir.`
            : 'Você pode rodar de novo.'}
        </p>
      )}
      {summary && (
        <dl className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2">
          <Counter label="Imagens examinadas" value={summary.files_scanned} />
          <Counter label="Em uso" value={summary.in_use} hint="Usadas por produtos, adicionais (inclusive na lixeira), fotos de perfil ou logos: ficam." />
          <Counter label={`Recentes (< ${hours} h)`} value={summary.recent} hint={`Sem uso, mas modificadas há menos de ${hours} horas (um envio ainda não salvo): ficam.`} />
          <Counter label="Sem uso" value={summary.orphans} detail={formatBytes(summary.orphan_bytes)} hint={`Sem uso e modificadas há mais de ${hours} horas.`} />
          {deleting && <Counter label="Apagadas" value={summary.deleted} detail={formatBytes(summary.deleted_bytes)} />}
          {deleting && summary.failed > 0 && <Counter label="Falhas ao apagar" value={summary.failed} hint="Continuam na pasta; veja o log da API." />}
          <Counter label="Ignorados" value={summary.skipped} hint="Pastas, atalhos, arquivos ocultos, nomes fora do padrão e arquivos que não são imagem: nunca são apagados." />
        </dl>
      )}
    </>
  );
}

/** "a cada 24 h", "a cada 30 min" (o intervalo vem em horas, com decimais). */
function intervalLabel(hours: number): string {
  if (hours >= 1) return `a cada ${sizeFormatter.format(hours)} h`;
  const minutes = hours * 60;
  return minutes >= 1 ? `a cada ${sizeFormatter.format(minutes)} min` : `a cada ${sizeFormatter.format(minutes * 60)} s`;
}

/** Resultado de uma limpeza automática em uma linha. */
function scheduledRunLabel(job: UploadsCleanupJob): string {
  const when = formatDateTime(job.started_at);
  if (job.status === 'RUNNING') return `${when} (em andamento)`;
  if (job.status === 'FAILED') return `${when} (falhou${job.error ? `: ${job.error}` : ''})`;
  const deleted = job.summary?.deleted ?? 0;
  return deleted === 0
    ? `${when} (nada a apagar)`
    : `${when} (${plural(deleted, 'arquivo apagado', 'arquivos apagados')}, ${formatBytes(job.summary?.deleted_bytes ?? 0)} liberados)`;
}

/**
 * Limpeza automática (UPLOADS_CLEANUP_INTERVAL_HOURS na API): se está ligada, de quanto em quanto tempo roda, a
 * última execução automática e a próxima prevista. Ela segue as mesmas regras de "Apagar sem uso".
 */
function CleanupScheduleLine({ schedule, loading, error }: {
  schedule: UploadsCleanupSchedule | null;
  loading: boolean;
  error: string | null;
}) {
  const now = useNow(30_000);
  if (loading && !schedule) return null;
  if (!schedule) {
    return error ? <p className="text-xs text-amber-700 dark:text-amber-300">{error}</p> : null;
  }
  const nextRun = schedule.next_run_at ? new Date(schedule.next_run_at) : null;
  const nextLabel = nextRun && nextRun.getTime() - now <= 60_000 ? 'em instantes' : `por volta de ${formatDateTime(schedule.next_run_at)}`;
  return (
    <div className="flex items-start gap-2 px-3 py-2 rounded-xl text-sm border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-900/40 text-gray-700 dark:text-gray-200">
      <CalendarClock size={16} className="shrink-0 mt-0.5 text-gray-500 dark:text-gray-400" aria-hidden="true" />
      <div className="space-y-0.5 min-w-0">
        {schedule.enabled && schedule.interval_hours !== null ? (
          <>
            <p className="flex flex-wrap items-center gap-2">
              <StatusBadge tone="success">Limpeza automática ligada</StatusBadge>
              <span>
                {intervalLabel(schedule.interval_hours)}, apaga as imagens sem uso há mais de {schedule.min_age_hours} h (as mesmas regras de
                {' '}&quot;Apagar sem uso&quot;).
              </span>
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Última automática: {schedule.last_run ? scheduledRunLabel(schedule.last_run) : 'ainda não rodou'}
              {nextRun && ` · Próxima: ${nextLabel}`}
            </p>
          </>
        ) : (
          <>
            <p className="flex flex-wrap items-center gap-2">
              <StatusBadge tone="neutral">Limpeza automática desligada</StatusBadge>
              <span>Para ligar, defina UPLOADS_CLEANUP_INTERVAL_HOURS na API (ex.: 24, em horas).</span>
            </p>
            {schedule.last_run && (
              <p className="text-xs text-gray-500 dark:text-gray-400">Última automática: {scheduledRunLabel(schedule.last_run)}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Imagens da pasta de uploads sem uso há mais de 24 h: verificar (só contar) ou apagar (com confirmação). */
function UploadsCleanupSection() {
  const resource = useResource((signal) => platformMaintenanceService.latestUploadsCleanup(signal), {
    errorMessage: 'Não foi possível carregar o último resultado da limpeza.',
  });
  const scheduleResource = useResource((signal) => platformMaintenanceService.uploadsCleanupSchedule(signal), {
    errorMessage: 'Não foi possível carregar a situação da limpeza automática.',
  });
  const job = resource.data;
  const running = job?.status === 'RUNNING';
  // Uma execução que terminou (inclusive a automática) muda a "última automática": atualiza a linha do agendamento
  const finishedKey = job && job.status !== 'RUNNING' ? `${job.id}:${job.status}` : null;
  const reloadSchedule = scheduleResource.reload;
  useEffect(() => {
    if (finishedKey) void reloadSchedule({ silent: true });
  }, [finishedKey, reloadSchedule]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [starting, setStarting] = useState<UploadsCleanupMode | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const busy = running || starting !== null || resource.loading || resource.refreshing;
  const visibleNotice = notice && (notice.jobId === undefined || (running && job?.id === notice.jobId)) ? notice : null;
  const runningMode = running ? job?.summary?.mode ?? null : null;
  const lastCheck = job && job.status === 'SUCCEEDED' && job.summary?.mode === 'check' ? job : null;

  usePolling(() => resource.reload({ silent: true }), POLL_INTERVAL_MS, { enabled: running });

  async function start(mode: UploadsCleanupMode) {
    setStarting(mode);
    setNotice(null);
    try {
      const result = await platformMaintenanceService.startUploadsCleanup(mode);
      if (result.job) resource.setData(result.job);
      if (!result.started) {
        setNotice(
          result.job
            ? { tone: 'info', message: `${result.message} Acompanhe o andamento abaixo.`, jobId: result.job.id }
            : { tone: 'info', message: result.message },
        );
        if (!result.job) void resource.reload();
      }
    } catch (error) {
      setNotice({
        tone: 'error',
        message: getApiErrorMessage(
          error,
          mode === 'delete' ? 'Não foi possível iniciar a exclusão dos arquivos sem uso.' : 'Não foi possível iniciar a verificação.',
        ),
      });
    } finally {
      setStarting(null);
      setConfirmOpen(false);
    }
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Limpar arquivos sem uso"
        description="Procura na pasta de uploads as imagens que nenhum cadastro usa (produtos e adicionais, inclusive na lixeira, fotos de perfil e logos das lojas) e que não mudam há mais de 24 horas. Verificar só conta os arquivos e o espaço; Apagar remove esses arquivos de vez. Roda em segundo plano, uma de cada vez."
      >
        <button
          type="button"
          onClick={() => void start('check')}
          disabled={busy}
          aria-busy={runningMode === 'check' || starting === 'check' || undefined}
          className={buttonClass('secondary', 'md')}
        >
          {runningMode === 'check' || starting === 'check'
            ? <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            : <ScanSearch size={16} aria-hidden="true" />}
          {runningMode === 'check' ? 'Verificando...' : 'Verificar'}
        </button>
        <button
          type="button"
          onClick={() => {
            setNotice(null);
            setConfirmOpen(true);
          }}
          disabled={busy}
          aria-busy={runningMode === 'delete' || starting === 'delete' || undefined}
          className={buttonClass('danger', 'md')}
        >
          {runningMode === 'delete' || starting === 'delete'
            ? <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            : <Trash2 size={16} aria-hidden="true" />}
          {runningMode === 'delete' ? 'Apagando...' : 'Apagar sem uso'}
        </button>
      </SectionHeader>

      <CleanupScheduleLine schedule={scheduleResource.data} loading={scheduleResource.loading} error={scheduleResource.error} />

      {visibleNotice && <NoticeLine notice={visibleNotice} />}
      <p className="sr-only" aria-live="polite">{cleanupAnnouncement(job)}</p>

      {job ? (
        <JobFrame
          job={job}
          refreshFailed={running && !!resource.error}
          label={job.summary?.trigger === 'schedule' ? 'Exclusão automática' : job.summary?.mode === 'delete' ? 'Exclusão' : 'Verificação'}
        >
          <CleanupDetails job={job} />
        </JobFrame>
      ) : (
        <JobPlaceholder
          loading={resource.loading}
          error={resource.error}
          onRetry={() => void resource.reload()}
          emptyMessage="Nenhuma verificação executada ainda."
        />
      )}

      <ConfirmModal
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void start('delete')}
        closeOnConfirm={false}
        loading={starting === 'delete'}
        isDestructive
        title="Apagar os arquivos sem uso?"
        confirmLabel="Apagar arquivos"
        message={
          <>
            As imagens da pasta de uploads que nenhum cadastro usa e que não mudam há mais de 24 horas serão apagadas de vez, de
            todas as lojas. Não dá para desfazer: confira se o backup da pasta está em dia.
            {lastCheck?.summary && (
              <span className="block mt-2">
                {`A última verificação (${formatDateTime(lastCheck.started_at)}) encontrou ${unused(lastCheck.summary.orphans)} (${formatBytes(lastCheck.summary.orphan_bytes)}).`}
              </span>
            )}
          </>
        }
      />
    </div>
  );
}

// -------------------------------------------------------------------------------------------------
// Credenciais do Mercado Pago
// -------------------------------------------------------------------------------------------------

function reencryptionNotice(result: StoreCredentialsReencryption): Notice {
  const parts = [
    `${plural(result.migrated, 'credencial regravada', 'credenciais regravadas')} no formato atual`,
    `${plural(result.already_current, 'já estava atualizada', 'já estavam atualizadas')}`,
  ];
  if (result.changed > 0) {
    parts.push(`${plural(result.changed, 'foi alterada', 'foram alteradas')} pela loja durante a ação e ficou como a loja salvou`);
  }
  let message = `${parts.join('; ')}.`;
  if (result.failed > 0) {
    const ids = result.failed_store_ids.map((id) => `#${id}`).join(', ');
    message += ` ${plural(result.failed, 'loja tem', 'lojas têm')} credenciais ilegíveis${ids ? ` (${ids})` : ''}: peça que salvem as credenciais de pagamento de novo.`;
  }
  return { tone: result.failed > 0 ? 'info' : 'success', message };
}

/** Access Tokens no formato antigo (sem vínculo com a loja) regravados no atual. Idempotente; o token nunca aparece. */
function StoreCredentialsSection() {
  const status = useResource((signal) => platformMaintenanceService.storeCredentialsStatus(signal), {
    errorMessage: 'Não foi possível carregar a situação das credenciais.',
  });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const data = status.data;
  const nothingToDo = !!data && data.legacy === 0;

  async function reencrypt() {
    setWorking(true);
    setNotice(null);
    try {
      setNotice(reencryptionNotice(await platformMaintenanceService.reencryptStoreCredentials()));
      void status.reload({ silent: true });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error, 'Não foi possível regravar as credenciais.') });
    } finally {
      setWorking(false);
      setConfirmOpen(false);
    }
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Credenciais do Mercado Pago"
        description="Regrava no formato atual, preso a cada loja, os Access Tokens salvos no formato antigo. O token nunca é exibido e as credenciais já atualizadas não mudam, então a ação pode ser repetida."
      >
        <button
          type="button"
          onClick={() => {
            setNotice(null);
            setConfirmOpen(true);
          }}
          disabled={working || status.loading || nothingToDo}
          aria-busy={working || undefined}
          title={nothingToDo ? 'Nenhuma credencial no formato antigo.' : undefined}
          className={buttonClass('secondary', 'md')}
        >
          {working ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <KeyRound size={16} aria-hidden="true" />}
          {working ? 'Regravando...' : 'Regravar credenciais'}
        </button>
      </SectionHeader>

      {notice && <NoticeLine notice={notice} />}

      {data ? (
        <p className="text-sm text-gray-600 dark:text-gray-300" aria-live="polite">
          {data.total === 0
            ? 'Nenhuma loja tem credenciais próprias do Mercado Pago.'
            : `${plural(data.total, 'loja com credenciais', 'lojas com credenciais')}: ${formatInteger(data.current)} no formato atual, ${formatInteger(data.legacy)} no formato antigo${data.unknown > 0 ? `, ${formatInteger(data.unknown)} ilegíve${data.unknown === 1 ? 'l' : 'is'}` : ''}.`}
        </p>
      ) : (
        <JobPlaceholder
          loading={status.loading}
          error={status.error}
          onRetry={() => void status.reload()}
          emptyMessage=""
        />
      )}

      <ConfirmModal
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void reencrypt()}
        closeOnConfirm={false}
        loading={working}
        title="Regravar as credenciais agora?"
        confirmLabel="Regravar"
        message="Os Access Tokens no formato antigo serão regravados no formato atual, presos a cada loja. Nenhum token é exibido e a ação fica registrada na auditoria (só as contagens)."
      />
    </div>
  );
}

/**
 * Manutenção (superpainel): rotinas sobre os arquivos e as credenciais de TODAS as lojas.
 * - Otimizar imagens e limpar arquivos sem uso rodam em segundo plano na API (uma execução por vez de cada tipo em
 *   todas as instâncias): iniciar devolve a execução na hora, a tela acompanha (GET a cada 3 s) até terminar e mostra
 *   o resumo. Ao abrir, aparece o último resultado (ou a execução em andamento, já acompanhada).
 * - Regravar as credenciais do Mercado Pago é imediato e mostra só contagens.
 */
export default function MaintenanceCard() {
  const titleId = useId();

  return (
    <section aria-labelledby={titleId} className={CARD_CLASS}>
      <div className="flex items-start gap-3 px-5 sm:px-6 py-4 border-b border-gray-100 dark:border-slate-700">
        <div className="shrink-0 p-2 rounded-xl bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400" aria-hidden="true">
          <Wrench size={20} />
        </div>
        <div className="min-w-0">
          <h2 id={titleId} className="text-lg font-bold text-gray-800 dark:text-white">Manutenção</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Rotinas sobre os arquivos e as credenciais de todas as lojas.</p>
        </div>
      </div>

      <div className="p-5 sm:p-6 space-y-6 divide-y divide-gray-100 dark:divide-slate-700 [&>*+*]:pt-6">
        <ImageOptimizationSection />
        <UploadsCleanupSection />
        <StoreCredentialsSection />
      </div>
    </section>
  );
}
