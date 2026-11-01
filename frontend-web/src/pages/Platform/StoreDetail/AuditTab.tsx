import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, FilterX, History } from 'lucide-react';
import { FormField, Pagination, buttonClass, fieldControlClass } from '../../../components/ui';
import { usePaginatedQuery } from '../../../hooks/usePaginatedQuery';
import {
  AUDIT_ACTOR_SCOPES, AUDIT_RESULTS, EMPTY_STORE_AUDIT_FILTERS, platformAuditService, type AuditLogEntry, type StoreAuditFilters,
} from '../../../services/platform/auditService';
import type { PlatformStoreDetail } from '../../../services/platform/storesService';
import ActionFilter from '../Audit/ActionFilter';
import AuditDetailModal from '../Audit/AuditDetailModal';
import AuditLogTable from '../Audit/AuditLogTable';
import DateRangeFilter from '../Audit/DateRangeFilter';
import EntityPicker from '../Audit/EntityPicker';
import { ACTOR_SCOPE_LABELS, AUDIT_RESULT_META } from '../Audit/auditLabels';
import { searchUserOptions, type PickerOption } from '../Audit/pickerOptions';
import { auditUrl } from '../Audit/urlFilters';

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

function hasFilters(filters: StoreAuditFilters): boolean {
  return (Object.keys(EMPTY_STORE_AUDIT_FILTERS) as (keyof StoreAuditFilters)[])
    .some((key) => filters[key] !== EMPTY_STORE_AUDIT_FILTERS[key]);
}

/**
 * Auditoria da loja (GET /platform/stores/:id/audit): a mesma tabela, o mesmo detalhe e os mesmos filtros da
 * auditoria geral (autor, ação ou grupo, resultado, origem e período), com a loja fixa pela rota. "Abrir na
 * auditoria geral" leva os filtros atuais para /platform/audit (endereço compartilhável).
 */
export default function AuditTab({ store }: { store: PlatformStoreDetail }) {
  const [selected, setSelected] = useState<AuditLogEntry | null>(null);
  const [actorOption, setActorOption] = useState<PickerOption | null>(null);

  const query = usePaginatedQuery<AuditLogEntry, StoreAuditFilters>({
    fetcher: ({ page, pageSize, filters, signal }) => platformAuditService.listForStore(store.id, { page, pageSize, ...filters }, signal),
    initialFilters: EMPTY_STORE_AUDIT_FILTERS,
    initialPageSize: 20,
    errorMessage: 'Não foi possível carregar a auditoria.',
  });

  const { filters } = query;
  const filtered = hasFilters(filters);
  // A aba não filtra por alvo: leva para a auditoria geral a loja e os filtros que ela tem
  const generalAuditUrl = auditUrl({
    store_id: store.id,
    actor_id: filters.actor_id,
    action: filters.action,
    result: filters.result,
    actor_scope: filters.actor_scope,
    from: filters.from,
    to: filters.to,
  });

  function clearFilters() {
    setActorOption(null);
    query.setFilters(EMPTY_STORE_AUDIT_FILTERS);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-gray-800 dark:text-white flex items-center gap-2">
            <History size={18} className="text-orange-600 dark:text-orange-400" aria-hidden="true" /> Auditoria do estabelecimento
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Ações do superpainel, da equipe da loja e do sistema que afetaram esta loja. Os detalhes já vêm sem senhas, tokens ou segredos.
          </p>
        </div>
        <Link to={generalAuditUrl} className={buttonClass('secondary', 'sm')}>
          <ExternalLink size={14} aria-hidden="true" /> Abrir na auditoria geral
        </Link>
      </div>

      <div className="space-y-3" role="search" aria-label={`Filtrar a auditoria de ${store.name}`}>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          <FormField label="Quem fez" hint="Conta que executou a ação (inclusive na lixeira).">
            {(field) => (
              <EntityPicker
                {...field}
                value={actorOption}
                onChange={(option) => {
                  setActorOption(option);
                  query.setFilter('actor_id', option?.id ?? null);
                }}
                search={searchUserOptions}
                placeholder="Qualquer pessoa (buscar nome ou e-mail)"
                listLabel="Contas encontradas"
                noResultsText="Nenhuma conta encontrada."
                clearLabel="Remover o filtro de autor"
              />
            )}
          </FormField>
          <ActionFilter value={filters.action} onChange={(action) => query.setFilter('action', action)} />
          <FormField label="Resultado">
            {(field) => (
              <select
                {...field}
                value={filters.result}
                onChange={(event) => query.setFilter('result', AUDIT_RESULTS.find((result) => result === event.target.value) ?? '')}
                className={fieldControlClass()}
              >
                <option value="">Todos os resultados</option>
                {AUDIT_RESULTS.map((result) => <option key={result} value={result}>{AUDIT_RESULT_META[result].label}</option>)}
              </select>
            )}
          </FormField>
          <FormField label="Origem" hint="De onde partiu a ação.">
            {(field) => (
              <select
                {...field}
                value={filters.actor_scope}
                onChange={(event) => query.setFilter('actor_scope', AUDIT_ACTOR_SCOPES.find((scope) => scope === event.target.value) ?? '')}
                className={fieldControlClass()}
              >
                <option value="">Todas as origens</option>
                {AUDIT_ACTOR_SCOPES.map((scope) => <option key={scope} value={scope}>{ACTOR_SCOPE_LABELS[scope]}</option>)}
              </select>
            )}
          </FormField>
          <DateRangeFilter
            from={filters.from}
            to={filters.to}
            onChange={(range) => query.setFilters({ ...filters, from: range.from, to: range.to })}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-gray-500 dark:text-gray-400">Datas no calendário da plataforma (o dia inteiro).</p>
          {filtered && (
            <button type="button" onClick={clearFilters} className={buttonClass('ghost', 'sm')}>
              <FilterX size={14} aria-hidden="true" /> Limpar filtros
            </button>
          )}
        </div>
      </div>

      <AuditLogTable
        caption={`Auditoria de ${store.name}`}
        rows={query.items}
        loading={query.loading}
        error={query.error}
        onRetry={() => void query.reload()}
        onSelect={setSelected}
        hideStore
        emptyTitle={filtered ? 'Nenhum registro com esses filtros' : 'Nenhum registro de auditoria'}
        emptyDescription={filtered ? 'Amplie o período ou remova algum filtro.' : 'As ações sobre esta loja aparecem aqui.'}
        emptyAction={filtered ? (
          <button type="button" onClick={clearFilters} className={buttonClass('secondary', 'sm')}>
            <FilterX size={14} aria-hidden="true" /> Limpar filtros
          </button>
        ) : undefined}
        footer={query.total > 0 ? (
          <Pagination
            page={query.page}
            pageSize={query.pageSize}
            total={query.total}
            onPageChange={query.setPage}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            onPageSizeChange={query.setPageSize}
            disabled={query.loading}
            itemLabel="registros"
          />
        ) : undefined}
      />

      <AuditDetailModal entry={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
