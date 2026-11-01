import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { FileSearch, History } from 'lucide-react';
import { DataTable, StatusBadge, buttonClass, type DataTableColumn } from '../../../components/ui';
import { formatDate } from '../../../utils/dates';
import type { AuditLogEntry } from '../../../services/platform/auditService';
import { formatDateTime, formatTime } from '../../../utils/format';
import {
  actionLabel, maskSensitive, metadataSummary, resultMeta, scopeLabel, targetLabel, targetPath, userAgentSummary,
} from './auditLabels';

interface AuditLogTableProps {
  caption: string;
  rows: AuditLogEntry[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** Abre o detalhe (metadados completos). */
  onSelect: (entry: AuditLogEntry) => void;
  /** "audit": trilha completa; "auth": eventos de autenticação (conta e tentativa em destaque). */
  variant?: 'audit' | 'auth';
  /** Esconde a coluna do estabelecimento (ex.: auditoria de uma loja só, na aba do detalhe dela). */
  hideStore?: boolean;
  emptyTitle?: string;
  emptyDescription?: ReactNode;
  emptyAction?: ReactNode;
  footer?: ReactNode;
  scrollClassName?: string;
}

const LINK_CLASS = 'hover:text-orange-600 dark:hover:text-orange-400 hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500';

function ActorCell({ entry }: { entry: AuditLogEntry }) {
  const actor = entry.actor;
  if (!actor) {
    return (
      <span className="text-xs text-gray-500 dark:text-gray-400">
        {entry.actor_scope === 'SYSTEM' ? 'Rotina automática' : 'Não identificado'}
      </span>
    );
  }
  const name = actor.name || actor.email || (actor.id ? `Conta #${actor.id}` : '—');
  return (
    <div className="min-w-0 max-w-48">
      {actor.id ? (
        <Link to={`/platform/users?usuario=${actor.id}`} className={`block truncate font-semibold text-gray-800 dark:text-white ${LINK_CLASS}`}>
          {name}
        </Link>
      ) : (
        <span className="block truncate font-semibold text-gray-800 dark:text-white">{name}</span>
      )}
      {actor.name && actor.email && <span className="block truncate text-xs text-gray-500 dark:text-gray-400">{actor.email}</span>}
      {!actor.id && actor.email && <span className="block text-xs text-gray-500 dark:text-gray-400">sem conta identificada</span>}
    </div>
  );
}

function StoreCell({ entry }: { entry: AuditLogEntry }) {
  if (entry.store) {
    return (
      <Link to={`/platform/stores/${entry.store.id}`} className={`block truncate max-w-48 font-semibold text-gray-700 dark:text-gray-200 ${LINK_CLASS}`}>
        {entry.store.name}
      </Link>
    );
  }
  return <span className="text-xs text-gray-500 dark:text-gray-400">{entry.store_id ? `Loja #${entry.store_id}` : 'Plataforma'}</span>;
}

/**
 * Tabela da trilha de auditoria (e dos eventos de autenticação): quando, o quê, resultado, quem, onde e
 * de onde. "Detalhes" abre o registro completo com os metadados em JSON.
 */
export default function AuditLogTable({
  caption,
  rows,
  loading,
  error,
  onRetry,
  onSelect,
  variant = 'audit',
  hideStore = false,
  emptyTitle = 'Nenhum registro encontrado',
  emptyDescription,
  emptyAction,
  footer,
  scrollClassName,
}: AuditLogTableProps) {
  const columns: DataTableColumn<AuditLogEntry>[] = [
    {
      key: 'when',
      header: 'Quando',
      className: 'whitespace-nowrap tabular-nums text-sm',
      cell: (entry) => (
        <time dateTime={entry.created_at ?? undefined} title={formatDateTime(entry.created_at)}>
          <span className="block">{formatDate(entry.created_at)}</span>
          <span className="block text-xs text-gray-500 dark:text-gray-400">{formatTime(entry.created_at)}</span>
        </time>
      ),
    },
    {
      key: 'action',
      mobile: 'primary',
      header: variant === 'auth' ? 'Evento' : 'Ação',
      cell: (entry) => {
        const summary = metadataSummary(entry.metadata);
        const meta = resultMeta(entry.result);
        return (
          <div className="min-w-48 max-w-72">
            <p className="font-bold text-gray-800 dark:text-white">{actionLabel(entry.action)}</p>
            <code className="block text-[11px] font-mono text-gray-500 dark:text-gray-400 truncate" title={entry.action}>{entry.action}</code>
            {summary && <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-300 line-clamp-2" title={summary}>{summary}</p>}
            {entry.metadata && Object.keys(entry.metadata).length > 0 && (
              <details className="mt-1">
                <summary className="w-fit cursor-pointer select-none text-[11px] font-bold text-gray-500 dark:text-gray-400 hover:text-orange-600 dark:hover:text-orange-400 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
                  Metadados (JSON)
                </summary>
                <pre className="mt-1 max-h-60 overflow-auto custom-scrollbar p-2 rounded-lg text-[11px] leading-relaxed font-mono whitespace-pre-wrap wrap-break-word bg-gray-50 dark:bg-slate-950 text-gray-800 dark:text-gray-200 border border-gray-100 dark:border-slate-700">
                  {JSON.stringify(maskSensitive(entry.metadata), null, 2)}
                </pre>
              </details>
            )}
            {/* Celular: resultado e autor aqui (as colunas próprias aparecem a partir do tablet) */}
            <div className="md:hidden mt-1.5 space-y-1">
              <StatusBadge tone={meta.tone} dot>{meta.label}</StatusBadge>
              <ActorCell entry={entry} />
            </div>
          </div>
        );
      },
    },
    {
      key: 'result',
      mobile: 'hidden',
      header: 'Resultado',
      className: 'hidden md:table-cell',
      headerClassName: 'hidden md:table-cell',
      cell: (entry) => {
        const meta = resultMeta(entry.result);
        return <StatusBadge tone={meta.tone} dot>{meta.label}</StatusBadge>;
      },
    },
    {
      key: 'actor',
      mobile: 'hidden',
      header: variant === 'auth' ? 'Conta / e-mail' : 'Quem fez',
      className: 'hidden md:table-cell',
      headerClassName: 'hidden md:table-cell',
      cell: (entry) => (
        <div>
          <ActorCell entry={entry} />
          {variant === 'audit' && <span className="block text-[11px] text-gray-500 dark:text-gray-400">{scopeLabel(entry.actor_scope)}</span>}
        </div>
      ),
    },
    ...(hideStore
      ? []
      : [{
        key: 'store',
        header: 'Estabelecimento',
        className: 'hidden lg:table-cell',
        headerClassName: 'hidden lg:table-cell',
        cell: (entry: AuditLogEntry) => <StoreCell entry={entry} />,
      } satisfies DataTableColumn<AuditLogEntry>]),
    // Alvo e origem (IP/navegador) só em telas largas; sempre estão no detalhe do registro
    ...(variant === 'audit'
      ? [{
        key: 'target',
        header: 'Alvo',
        className: 'hidden 2xl:table-cell whitespace-nowrap',
        headerClassName: 'hidden 2xl:table-cell',
        cell: (entry: AuditLogEntry) => {
          const label = targetLabel(entry);
          const path = targetPath(entry);
          if (!label) return <span className="text-gray-400">—</span>;
          return path ? <Link to={path} className={`text-sm ${LINK_CLASS}`}>{label}</Link> : <span className="text-sm">{label}</span>;
        },
      } satisfies DataTableColumn<AuditLogEntry>]
      : []),
    {
      key: 'origin',
      header: 'Origem',
      className: 'hidden 2xl:table-cell',
      headerClassName: 'hidden 2xl:table-cell',
      cell: (entry) => (
        <div className="text-xs">
          <code className="font-mono text-gray-700 dark:text-gray-200">{entry.ip ?? '—'}</code>
          {entry.user_agent && (
            <span className="block text-gray-500 dark:text-gray-400" title={entry.user_agent}>{userAgentSummary(entry.user_agent)}</span>
          )}
        </div>
      ),
    },
    {
      key: 'details',
      mobile: 'actions',
      header: <span className="sr-only">Detalhes</span>,
      align: 'right',
      cell: (entry) => (
        <button
          type="button"
          onClick={() => onSelect(entry)}
          aria-label={`Ver detalhes do registro ${entry.id}: ${actionLabel(entry.action)}`}
          title="Ver detalhes e metadados"
          className={buttonClass('secondary', 'sm')}
        >
          <FileSearch size={14} aria-hidden="true" /> <span className="hidden max-sm:inline 2xl:inline">Detalhes</span>
        </button>
      ),
    },
  ];

  return (
    <DataTable
      stackOnMobile
      caption={caption}
      columns={columns}
      rows={rows}
      rowKey={(entry) => entry.id}
      loading={loading}
      error={error}
      onRetry={onRetry}
      emptyIcon={<History size={28} />}
      emptyTitle={emptyTitle}
      emptyDescription={emptyDescription}
      emptyAction={emptyAction}
      footer={footer}
      scrollClassName={scrollClassName}
      rowClassName={(entry) => (entry.result === 'FAILURE' || entry.result === 'DENIED' ? 'bg-red-50/40 dark:bg-red-900/5' : undefined)}
    />
  );
}
