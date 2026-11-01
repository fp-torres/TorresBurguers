import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Crown, ShieldCheck, UserCog, Users } from 'lucide-react';
import { DataTable, Pagination, SearchInput, StatusBadge, buttonClass, type DataTableColumn } from '../../../components/ui';
import { usePaginatedQuery } from '../../../hooks/usePaginatedQuery';
import {
  platformStoresService, type PlatformStoreDetail, type PlatformStoreMember, type StoreMutationResult,
} from '../../../services/platform/storesService';
import { formatDateTime } from '../../../utils/format';
import { roleLabel } from '../../../utils/roles';
import { formatDate } from '../../../utils/dates';
import { SetOwnerConfirm } from './OwnerDialogs';
import { isOwnerCandidate } from './storeDisplay';

interface TeamTabProps {
  store: PlatformStoreDetail;
  /** O responsável mudou (PATCH devolve o detalhe atualizado). */
  onStoreUpdated: (result: StoreMutationResult) => void;
}

type TeamFilters = { include_deleted: boolean };

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

/** Equipe da loja (GET /platform/stores/:id/users), inclusive a lixeira, com último acesso, bloqueio e o responsável. */
export default function TeamTab({ store, onStoreUpdated }: TeamTabProps) {
  const [ownerCandidate, setOwnerCandidate] = useState<PlatformStoreMember | null>(null);
  const query = usePaginatedQuery<PlatformStoreMember, TeamFilters>({
    fetcher: ({ page, pageSize, search, filters, signal }) => platformStoresService.team(store.id, {
      page, pageSize, search, include_deleted: filters.include_deleted,
    }, signal),
    initialFilters: { include_deleted: true },
    errorMessage: 'Não foi possível carregar a equipe.',
  });

  const searching = query.search.trim() !== '';
  // Usuários e acessos (/platform/users) aceita ?loja=<id>: a lista de contas abre filtrada por esta loja
  const usersUrl = `/platform/users?loja=${store.id}`;

  const columns: DataTableColumn<PlatformStoreMember>[] = [
    {
      key: 'member',
      header: 'Pessoa',
      cell: (member) => (
        <div className="flex items-center gap-3 min-w-0">
          <span
            aria-hidden="true"
            className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center font-bold text-sm bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300"
          >
            {(member.name.trim()[0] ?? member.email[0] ?? '?').toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="font-bold text-gray-800 dark:text-white flex flex-wrap items-center gap-1.5">
              <span className="truncate max-w-48">{member.name || 'Sem nome'}</span>
              {member.is_owner && <StatusBadge tone="info" icon={<Crown size={12} />}>Responsável</StatusBadge>}
              {member.platform_role && <StatusBadge tone="warning" icon={<ShieldCheck size={12} />}>Plataforma</StatusBadge>}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-64">{member.email}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Perfil',
      className: 'whitespace-nowrap',
      cell: (member) => roleLabel(member.role) || member.role,
    },
    {
      key: 'status',
      header: 'Situação',
      cell: (member) => (
        <div className="flex flex-col gap-1">
          {member.deleted_at
            ? <StatusBadge tone="neutral">Na lixeira desde {formatDate(member.deleted_at)}</StatusBadge>
            : member.blocked_at
              ? <StatusBadge tone="danger" title={member.blocked_reason ?? undefined}>Bloqueado</StatusBadge>
              : <StatusBadge tone="success" dot>Ativo</StatusBadge>}
          {member.blocked_at && member.blocked_reason && (
            <span className="text-xs text-red-700 dark:text-red-400 max-w-56 wrap-break-word">{member.blocked_reason}</span>
          )}
        </div>
      ),
    },
    {
      key: 'last_login',
      header: 'Último acesso',
      className: 'hidden md:table-cell whitespace-nowrap',
      headerClassName: 'hidden md:table-cell',
      cell: (member) => (member.last_login_at ? formatDateTime(member.last_login_at) : <span className="text-gray-400">Nunca entrou</span>),
    },
    {
      key: 'created',
      header: 'Na equipe desde',
      className: 'hidden lg:table-cell whitespace-nowrap',
      headerClassName: 'hidden lg:table-cell',
      cell: (member) => formatDate(member.created_at),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Ações</span>,
      align: 'right',
      cell: (member) => (isOwnerCandidate(member) && !member.is_owner ? (
        <button
          type="button"
          onClick={() => setOwnerCandidate(member)}
          aria-label={`Tornar ${member.name || member.email} o responsável pela loja`}
          className={buttonClass('secondary', 'sm')}
        >
          <Crown size={14} aria-hidden="true" /> <span className="hidden sm:inline">Tornar responsável</span>
        </button>
      ) : null),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-3">
        <SearchInput
          value={query.search}
          onChange={query.setSearch}
          placeholder="Buscar por nome ou e-mail..."
          label="Buscar na equipe"
          className="flex-1 sm:max-w-md"
        />
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
          <input
            type="checkbox"
            checked={query.filters.include_deleted}
            onChange={(event) => query.setFilter('include_deleted', event.target.checked)}
            className="w-4 h-4 accent-orange-600"
          />
          Mostrar quem está na lixeira
        </label>
        <Link to={usersUrl} className={buttonClass('secondary', 'sm', 'sm:ml-auto')}>
          <UserCog size={14} aria-hidden="true" /> Ver no gerenciamento de usuários
        </Link>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Bloqueio, encerramento de sessões e links de redefinição de senha ficam em{' '}
        <Link to={usersUrl} className="font-bold text-orange-700 dark:text-orange-400 hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
          Usuários e acessos
        </Link>{' '}
        (já filtrado por esta loja). A equipe da loja é gerida pelo Administrador no painel dela.
      </p>

      <DataTable
        stackOnMobile
        caption={`Equipe de ${store.name}`}
        columns={columns}
        rows={query.items}
        rowKey={(member) => member.id}
        loading={query.loading}
        error={query.error}
        onRetry={() => void query.reload()}
        rowClassName={(member) => (member.deleted_at ? 'opacity-70' : undefined)}
        emptyIcon={<Users size={32} />}
        emptyTitle={searching ? 'Ninguém encontrado' : 'Nenhuma pessoa na equipe'}
        emptyDescription={searching
          ? 'Confira a grafia ou busque pelo e-mail.'
          : 'A equipe entra pelos convites (aba Convites) ou é cadastrada pelo Administrador da loja.'}
        footer={query.total > 0 ? (
          <Pagination
            page={query.page}
            pageSize={query.pageSize}
            total={query.total}
            onPageChange={query.setPage}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            onPageSizeChange={query.setPageSize}
            disabled={query.loading}
            itemLabel="pessoas"
          />
        ) : undefined}
      />

      <SetOwnerConfirm
        store={store}
        member={ownerCandidate}
        onClose={() => setOwnerCandidate(null)}
        onDone={(result) => {
          onStoreUpdated(result);
          void query.reload({ silent: true });
        }}
      />
    </div>
  );
}
