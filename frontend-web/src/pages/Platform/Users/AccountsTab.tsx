import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FilterX, ShieldCheck, UserSearch, Users as UsersIcon } from 'lucide-react';
import {
  CARD_CLASS, DataTable, FormField, Pagination, SearchInput, StatusBadge, buttonClass, cx, fieldControlClass, type DataTableColumn,
} from '../../../components/ui';
import { usePaginatedQuery } from '../../../hooks/usePaginatedQuery';
import { avatarUrl } from '../../../services/api';
import {
  DEFAULT_USER_FILTERS, platformUsersService, type PlatformRoleFilter, type PlatformUser, type PlatformUserFilters, type PlatformUserSort,
} from '../../../services/platform/usersService';
import { formatDateTime } from '../../../utils/format';
import { platformRoleLabel, roleLabel, type UserRole } from '../../../utils/roles';
import EntityPicker from '../Audit/EntityPicker';
import { resolveStoreOption, searchStoreOptions } from '../Audit/pickerOptions';
import { useLabeledOption } from '../Audit/useLabeledOption';
import { AVATAR_CLASSES, PLATFORM_AVATAR_CLASS, ROLE_FILTER_OPTIONS, SORT_OPTIONS, accountStatus, initials } from './userLabels';
import { hasUserFilters, userFiltersFromParams, userFiltersToParams } from './urlFilters';

const PAGE_SIZE_OPTIONS = [20, 50, 100];

interface AccountsTabProps {
  /** Id da conta logada (marca "você"). */
  currentUserId: number | null;
  /** Abre o detalhe da conta. */
  onOpen: (user: PlatformUser) => void;
  /** Muda a cada alteração feita no detalhe: a lista atualiza em silêncio. */
  refreshToken: number;
}

/** Aba "Contas": busca e filtros de GET /platform/users (clientes, equipes de todas as lojas e plataforma). */
export default function AccountsTab({ currentUserId, onOpen, refreshToken }: AccountsTabProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [initial] = useState(() => userFiltersFromParams(searchParams));

  const query = usePaginatedQuery<PlatformUser, PlatformUserFilters>({
    fetcher: ({ page, pageSize, search, filters, signal }) => platformUsersService.list({ page, pageSize, search, ...filters }, signal),
    initialFilters: initial.filters,
    initialSearch: initial.search,
    initialPageSize: PAGE_SIZE_OPTIONS[0],
    errorMessage: 'Não foi possível carregar as contas.',
  });
  const [storeOption, setStoreOption] = useLabeledOption(initial.filters.store_id, resolveStoreOption, (id) => `Loja #${id}`);

  // Alteração feita no detalhe (bloqueio, desbloqueio...): recarrega a página atual sem piscar
  const reloadRef = useRef(query.reload);
  useEffect(() => {
    reloadRef.current = query.reload;
  });
  const [mountToken] = useState(refreshToken);
  useEffect(() => {
    if (refreshToken !== mountToken) void reloadRef.current({ silent: true });
  }, [refreshToken, mountToken]);

  const filters = query.filters;
  const filtered = hasUserFilters(filters, query.search);

  function syncUrl(nextFilters: PlatformUserFilters, nextSearch: string) {
    setSearchParams((current) => userFiltersToParams(nextFilters, nextSearch, current), { replace: true });
  }

  function setFilter<K extends keyof PlatformUserFilters>(key: K, value: PlatformUserFilters[K]) {
    const next = { ...filters, [key]: value };
    query.setFilters(next);
    syncUrl(next, query.search);
  }

  function setSearch(value: string) {
    query.setSearch(value);
    syncUrl(filters, value);
  }

  function resetFilters() {
    // reset() voltaria aos filtros com que a página abriu (do endereço); aqui é sempre o padrão
    setStoreOption(null);
    query.setFilters(DEFAULT_USER_FILTERS);
    query.setSearch('');
    syncUrl(DEFAULT_USER_FILTERS, '');
  }

  const columns: DataTableColumn<PlatformUser>[] = [
    {
      key: 'account',
      header: 'Conta',
      cell: (user) => {
        const avatar = avatarUrl(user.avatar);
        const isSelf = user.id === currentUserId;
        return (
          <div className="flex items-center gap-3 min-w-0">
            {avatar ? (
              <img src={avatar} alt="" className="w-10 h-10 shrink-0 rounded-full object-cover border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700" />
            ) : (
              <span
                aria-hidden="true"
                className={cx(
                  'w-10 h-10 shrink-0 rounded-full flex items-center justify-center font-bold text-sm',
                  user.platform_role ? PLATFORM_AVATAR_CLASS : AVATAR_CLASSES[user.role] ?? AVATAR_CLASSES.CLIENT,
                )}
              >
                {initials(user.name, user.email)}
              </span>
            )}
            <div className="min-w-0">
              <p className="font-bold text-gray-800 dark:text-white truncate max-w-60">
                {user.name || 'Sem nome'}
                {isSelf && <span className="ml-1.5 text-xs font-semibold text-orange-600 dark:text-orange-400">(você)</span>}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-60">{user.email}</p>
            </div>
          </div>
        );
      },
    },
    {
      key: 'role',
      header: 'Perfil e loja',
      cell: (user) => (
        <div className="min-w-0 max-w-56 space-y-1">
          <div className="flex flex-wrap gap-1.5">
            {user.platform_role && <StatusBadge tone="warning" icon={<ShieldCheck size={12} />}>{platformRoleLabel(user.platform_role)}</StatusBadge>}
            {!user.platform_role && <StatusBadge tone={user.role === 'CLIENT' ? 'neutral' : 'info'}>{roleLabel(user.role)}</StatusBadge>}
          </div>
          {user.store ? (
            <Link
              to={`/platform/stores/${user.store.id}`}
              className="block truncate text-xs font-semibold text-gray-600 dark:text-gray-300 hover:text-orange-600 dark:hover:text-orange-400 hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              {user.store.name}
            </Link>
          ) : (
            <span className="block text-xs text-gray-500 dark:text-gray-400">
              {user.platform_role ? 'Administração da plataforma' : user.role === 'CLIENT' ? 'Cliente (conta global)' : 'Sem loja'}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Situação',
      cell: (user) => {
        const status = accountStatus(user);
        return (
          <div className="space-y-1">
            <StatusBadge tone={status.tone} dot title={user.blocked_reason ?? undefined}>{status.label}</StatusBadge>
            {user.blocked_at && !user.deleted_at && user.blocked_reason && (
              <p className="text-[11px] text-gray-500 dark:text-gray-400 line-clamp-2 min-w-36 max-w-52" title={user.blocked_reason}>{user.blocked_reason}</p>
            )}
          </div>
        );
      },
    },
    {
      key: 'last_login',
      header: 'Último acesso',
      className: 'hidden md:table-cell whitespace-nowrap text-sm',
      headerClassName: 'hidden md:table-cell',
      cell: (user) => (user.last_login_at ? formatDateTime(user.last_login_at) : <span className="text-gray-400 dark:text-gray-500">Nunca entrou</span>),
    },
    {
      key: 'created',
      header: 'Criada em',
      className: 'hidden xl:table-cell whitespace-nowrap text-sm',
      headerClassName: 'hidden xl:table-cell',
      cell: (user) => formatDateTime(user.created_at),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Ações</span>,
      align: 'right',
      cell: (user) => (
        <button
          type="button"
          onClick={() => onOpen(user)}
          aria-label={`Ver a conta de ${user.name || user.email}`}
          className={buttonClass('secondary', 'sm')}
        >
          <UserSearch size={14} aria-hidden="true" /> <span className="hidden sm:inline">Detalhes</span>
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div role="search" aria-label="Filtrar contas" className={cx(CARD_CLASS, 'p-4 sm:p-5 space-y-4')}>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          <FormField label="Buscar" className="md:col-span-2" hint="Nome, e-mail ou telefone.">
            {(field) => (
              <SearchInput
                id={field.id}
                value={query.search}
                onChange={setSearch}
                placeholder="Ex.: maria, maria@email.com ou 21 99999"
                label="Buscar contas por nome, e-mail ou telefone"
              />
            )}
          </FormField>
          <FormField label="Estabelecimento" className="md:col-span-2" hint="Equipe de uma loja.">
            {(field) => (
              <EntityPicker
                {...field}
                value={storeOption}
                onChange={(option) => {
                  setStoreOption(option);
                  setFilter('store_id', option?.id ?? null);
                }}
                search={searchStoreOptions}
                placeholder="Todas as lojas (buscar por nome)"
                listLabel="Lojas encontradas"
                noResultsText="Nenhuma loja encontrada."
                clearLabel="Remover o filtro de loja"
              />
            )}
          </FormField>
          <FormField label="Perfil">
            {(field) => (
              <select {...field} value={filters.role} onChange={(event) => setFilter('role', event.target.value as UserRole | '')} className={fieldControlClass()}>
                <option value="">Todos os perfis</option>
                {ROLE_FILTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            )}
          </FormField>
          <FormField label="Papel na plataforma">
            {(field) => (
              <select
                {...field}
                value={filters.platform_role}
                onChange={(event) => setFilter('platform_role', event.target.value as PlatformRoleFilter | '')}
                className={fieldControlClass()}
              >
                <option value="">Todos</option>
                <option value="SUPER_ADMIN">Superadministradores</option>
                <option value="NONE">Sem papel na plataforma</option>
              </select>
            )}
          </FormField>
          <FormField label="Situação">
            {(field) => (
              <select
                {...field}
                value={filters.blocked === null ? '' : filters.blocked ? 'blocked' : 'free'}
                onChange={(event) => setFilter('blocked', event.target.value === '' ? null : event.target.value === 'blocked')}
                className={fieldControlClass()}
              >
                <option value="">Todas</option>
                <option value="blocked">Só bloqueadas</option>
                <option value="free">Só livres</option>
              </select>
            )}
          </FormField>
          <FormField label="Ordenar por">
            {(field) => (
              <select {...field} value={filters.sort} onChange={(event) => setFilter('sort', event.target.value as PlatformUserSort)} className={fieldControlClass()}>
                {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            )}
          </FormField>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="inline-flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-200 cursor-pointer">
            <input
              type="checkbox"
              checked={filters.include_deleted}
              onChange={(event) => setFilter('include_deleted', event.target.checked)}
              className="w-4 h-4 rounded border-gray-300 dark:border-slate-600 accent-orange-600 focus-visible:ring-2 focus-visible:ring-orange-500"
            />
            Incluir contas na lixeira
          </label>
          {filtered && (
            <button type="button" onClick={resetFilters} className={buttonClass('ghost', 'sm')}>
              <FilterX size={14} aria-hidden="true" /> Limpar filtros
            </button>
          )}
        </div>
      </div>

      <DataTable
        stackOnMobile
        caption="Contas da plataforma"
        columns={columns}
        rows={query.items}
        rowKey={(user) => user.id}
        loading={query.loading}
        error={query.error}
        onRetry={() => void query.reload()}
        emptyIcon={<UsersIcon size={28} />}
        emptyTitle={filtered ? 'Nenhuma conta encontrada' : 'Nenhuma conta cadastrada'}
        emptyDescription={filtered ? 'Confira a busca ou remova algum filtro.' : 'Clientes, equipes das lojas e administradores aparecem aqui.'}
        emptyAction={filtered ? (
          <button type="button" onClick={resetFilters} className={buttonClass('secondary', 'sm')}>
            <FilterX size={14} aria-hidden="true" /> Limpar filtros
          </button>
        ) : undefined}
        rowClassName={(user) => (user.deleted_at ? 'opacity-70' : undefined)}
        footer={query.total > 0 ? (
          <Pagination
            page={query.page}
            pageSize={query.pageSize}
            total={query.total}
            onPageChange={query.setPage}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            onPageSizeChange={query.setPageSize}
            disabled={query.loading}
            itemLabel="contas"
          />
        ) : undefined}
      />
    </div>
  );
}
