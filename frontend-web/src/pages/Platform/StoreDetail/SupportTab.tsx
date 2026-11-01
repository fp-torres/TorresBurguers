import { useState } from 'react';
import { Eye, Headset, LogOut, ShieldCheck, Timer } from 'lucide-react';
import {
  CARD_CLASS, DataTable, FilterTabs, Pagination, StatusBadge, buttonClass, cx, type DataTableColumn, type FilterTabOption,
} from '../../../components/ui';
import { usePaginatedQuery } from '../../../hooks/usePaginatedQuery';
import { platformSupportSessionsService, type PlatformSupportSession } from '../../../services/platform/supportSessionsService';
import type { PlatformStoreDetail } from '../../../services/platform/storesService';
import { formatDateTime } from '../../../utils/format';
import { EndSupportConfirm, StartSupportDialog } from './SupportDialogs';
import { supportSessionMeta } from './storeDisplay';

type ActiveFilter = 'ALL' | 'ACTIVE' | 'CLOSED';
type SupportFilters = { active: ActiveFilter };

const FILTER_TABS: FilterTabOption<ActiveFilter>[] = [
  { value: 'ALL', label: 'Todas' },
  { value: 'ACTIVE', label: 'Ativas' },
  { value: 'CLOSED', label: 'Encerradas ou expiradas' },
];

/**
 * Sessões de suporte da loja (GET /platform/support-sessions?store_id=): acesso assistido, somente leitura,
 * temporário e auditado ao painel da loja. Iniciar (com motivo) troca para o painel da loja; encerrar invalida o token.
 */
export default function SupportTab({ store }: { store: PlatformStoreDetail }) {
  const [startOpen, setStartOpen] = useState(false);
  const [toEnd, setToEnd] = useState<PlatformSupportSession | null>(null);
  const inactive = store.account_status === 'INACTIVE';

  const query = usePaginatedQuery<PlatformSupportSession, SupportFilters>({
    fetcher: ({ page, pageSize, filters, signal }) => platformSupportSessionsService.list({
      page,
      pageSize,
      store_id: store.id,
      active: filters.active === 'ALL' ? undefined : filters.active === 'ACTIVE',
    }, signal),
    initialFilters: { active: 'ALL' },
    initialPageSize: 10,
    errorMessage: 'Não foi possível carregar as sessões de suporte.',
  });

  const columns: DataTableColumn<PlatformSupportSession>[] = [
    {
      key: 'operator',
      header: 'Operador',
      cell: (session) => (
        <div className="min-w-0 max-w-56">
          <p className="font-semibold text-gray-800 dark:text-white truncate">{session.platform_user?.name || 'Superadministrador'}</p>
          {session.platform_user?.email && <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{session.platform_user.email}</p>}
        </div>
      ),
    },
    {
      key: 'reason',
      header: 'Motivo',
      cell: (session) => <p className="text-sm max-w-80 wrap-break-word">{session.reason || '—'}</p>,
    },
    {
      key: 'period',
      header: 'Início e fim',
      className: 'hidden md:table-cell text-xs whitespace-nowrap',
      headerClassName: 'hidden md:table-cell',
      cell: (session) => (
        <div className="space-y-0.5">
          <p>Início: {formatDateTime(session.started_at)}</p>
          {session.ended_at
            ? <p>Encerrada: {formatDateTime(session.ended_at)}</p>
            : <p>{session.status === 'EXPIRED' ? 'Expirou' : 'Expira'}: {formatDateTime(session.expires_at)}</p>}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Situação',
      cell: (session) => {
        const meta = supportSessionMeta(session.status);
        return <StatusBadge tone={meta.tone} dot={session.active}>{meta.label}</StatusBadge>;
      },
    },
    {
      key: 'ip',
      header: 'IP',
      className: 'hidden xl:table-cell font-mono text-xs',
      headerClassName: 'hidden xl:table-cell',
      cell: (session) => session.ip ?? '—',
    },
    {
      key: 'actions',
      header: <span className="sr-only">Ações</span>,
      align: 'right',
      cell: (session) => (session.active ? (
        <button
          type="button"
          onClick={() => setToEnd(session)}
          aria-label={`Encerrar a sessão de suporte de ${session.platform_user?.name || 'superadministrador'}`}
          className={buttonClass('ghost', 'sm', 'text-red-600 dark:text-red-400')}
        >
          <LogOut size={14} aria-hidden="true" /> <span className="hidden sm:inline">Encerrar</span>
        </button>
      ) : null),
    },
  ];

  return (
    <div className="space-y-4">
      <div className={cx(CARD_CLASS, 'p-5 sm:p-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4')}>
        <div className="space-y-2">
          <h2 className="text-base font-bold text-gray-800 dark:text-white flex items-center gap-2">
            <Headset size={18} className="text-orange-600 dark:text-orange-400" aria-hidden="true" /> Sessão de suporte
          </h2>
          <ul className="grid grid-cols-1 md:grid-cols-3 gap-2 text-sm text-gray-600 dark:text-gray-300">
            <li className="flex items-start gap-2"><Eye size={16} className="shrink-0 mt-0.5 text-blue-600 dark:text-blue-400" aria-hidden="true" /> Painel da loja como Administrador, somente leitura.</li>
            <li className="flex items-start gap-2"><Timer size={16} className="shrink-0 mt-0.5 text-blue-600 dark:text-blue-400" aria-hidden="true" /> Temporária: expira sozinha (Configurações da plataforma).</li>
            <li className="flex items-start gap-2"><ShieldCheck size={16} className="shrink-0 mt-0.5 text-blue-600 dark:text-blue-400" aria-hidden="true" /> Início, fim e motivo ficam na auditoria.</li>
          </ul>
          {inactive && <p className="text-sm text-amber-700 dark:text-amber-300">Estabelecimento desativado: restaure-o antes de abrir uma sessão de suporte.</p>}
        </div>
        <button
          type="button"
          onClick={() => setStartOpen(true)}
          disabled={inactive}
          className={buttonClass('primary', 'md', 'shrink-0')}
        >
          <Headset size={16} aria-hidden="true" /> Iniciar sessão de suporte
        </button>
      </div>

      <FilterTabs label="Filtrar sessões" options={FILTER_TABS} value={query.filters.active} onChange={(value) => query.setFilter('active', value)} className="-mx-2" />

      <DataTable
        stackOnMobile
        caption={`Sessões de suporte em ${store.name}`}
        columns={columns}
        rows={query.items}
        rowKey={(session) => session.id}
        loading={query.loading}
        error={query.error}
        onRetry={() => void query.reload()}
        skeletonRows={3}
        emptyIcon={<Headset size={28} />}
        emptyTitle={query.filters.active === 'ALL' ? 'Nenhuma sessão de suporte' : 'Nenhuma sessão nesta situação'}
        emptyDescription="As sessões abertas nesta loja (por qualquer superadministrador) aparecem aqui."
        footer={query.total > query.pageSize ? (
          <Pagination
            page={query.page}
            pageSize={query.pageSize}
            total={query.total}
            onPageChange={query.setPage}
            disabled={query.loading}
            itemLabel="sessões"
          />
        ) : undefined}
      />

      <StartSupportDialog open={startOpen} store={store} onClose={() => setStartOpen(false)} onFailed={() => void query.reload({ silent: true })} />
      <EndSupportConfirm session={toEnd} onClose={() => setToEnd(null)} onDone={() => void query.reload({ silent: true })} />
    </div>
  );
}
