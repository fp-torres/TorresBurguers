import { useState } from 'react';
import { useLocation, useNavigationType, useSearchParams } from 'react-router-dom';
import { Icon } from '@iconify/react';
import { Crosshair, FilterX, Loader2, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { FormField, PageHeader, Pagination, buttonClass, fieldControlClass } from '../../../components/ui';
import { usePaginatedQuery } from '../../../hooks/usePaginatedQuery';
import {
  AUDIT_ACTOR_SCOPES, AUDIT_RESULTS, EMPTY_AUDIT_FILTERS, platformAuditService, type AuditActorScope, type AuditFilters,
  type AuditLogEntry, type AuditResult,
} from '../../../services/platform/auditService';
import ActionFilter from './ActionFilter';
import AuditDetailModal from './AuditDetailModal';
import AuditLogTable from './AuditLogTable';
import DateRangeFilter from './DateRangeFilter';
import EntityPicker from './EntityPicker';
import { ACTOR_SCOPE_LABELS, AUDIT_RESULT_META, targetFilterLabel } from './auditLabels';
import { resolveStoreOption, resolveUserOption, searchStoreOptions, searchUserOptions } from './pickerOptions';
import { useLabeledOption } from './useLabeledOption';
import { auditFiltersFromParams, auditFiltersToParams, hasAuditFilters } from './urlFilters';

const PAGE_SIZE_OPTIONS = [20, 50, 100];

/**
 * Superpainel › Auditoria (/platform/audit): GET /platform/audit paginada (mais recentes primeiro) com
 * filtros de estabelecimento, autor, ação (nome ou grupo), alvo, resultado, origem e período. Os filtros ficam
 * no endereço (?loja&autor&acao&alvo_tipo&alvo&resultado&origem&de&ate); o alvo chega pelos links "Ver auditoria"
 * (conta, plano, assinatura, fatura) e aparece como um filtro removível. Metadados em JSON no detalhe de cada
 * registro — já sem senhas, tokens ou segredos (sanitizados pela API).
 */
export default function PlatformAudit() {
  const location = useLocation();
  const navigationType = useNavigationType();
  // Os filtros são lidos do endereço ao abrir a tela; os ajustes feitos nela trocam o endereço com replace.
  // Navegar de fora para outro endereço desta tela (menu, link, voltar/avançar) recomeça com os filtros dele.
  const [viewKey, setViewKey] = useState(location.key);
  if (navigationType !== 'REPLACE' && location.key !== viewKey) setViewKey(location.key);
  return <AuditView key={viewKey} />;
}

function AuditView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [initialFilters] = useState(() => auditFiltersFromParams(searchParams));
  const [selected, setSelected] = useState<AuditLogEntry | null>(null);

  const query = usePaginatedQuery<AuditLogEntry, AuditFilters>({
    fetcher: ({ page, pageSize, filters, signal }) => platformAuditService.list({ page, pageSize, ...filters }, signal),
    initialFilters,
    initialPageSize: PAGE_SIZE_OPTIONS[0],
    errorMessage: 'Não foi possível carregar a auditoria.',
  });

  const [storeOption, setStoreOption] = useLabeledOption(initialFilters.store_id, resolveStoreOption, (id) => `Loja #${id}`);
  const [actorOption, setActorOption] = useLabeledOption(initialFilters.actor_id, resolveUserOption, (id) => `Conta #${id}`);

  const filters = query.filters;
  const filtered = hasAuditFilters(filters);
  const busy = query.loading || query.refreshing;
  const targetText = filters.target_type ? targetFilterLabel(filters.target_type, filters.target_id) : null;

  function applyFilters(next: AuditFilters) {
    query.setFilters(next);
    setSearchParams((current) => auditFiltersToParams(next, current), { replace: true });
  }

  function setFilter<K extends keyof AuditFilters>(key: K, value: AuditFilters[K]) {
    applyFilters({ ...filters, [key]: value });
  }

  function resetFilters() {
    setStoreOption(null);
    setActorOption(null);
    applyFilters(EMPTY_AUDIT_FILTERS);
  }

  return (
    <div className="space-y-6 pb-20">
      <PageHeader
        title="Auditoria"
        subtitle="Quem fez o quê, em qual estabelecimento, quando e com qual resultado"
        icon={<Icon icon="solar:history-bold-duotone" width={26} />}
        actions={(
          <button type="button" onClick={() => void query.reload()} disabled={busy} className={buttonClass('secondary')}>
            {busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}
            Atualizar
          </button>
        )}
      >
        <div className="space-y-4" role="search" aria-label="Filtrar a auditoria">
          {targetText && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">Filtrando por</span>
              <span className="inline-flex items-center gap-1.5 max-w-full min-w-0 pl-3 pr-1 py-1 rounded-full text-sm font-semibold bg-orange-50 dark:bg-orange-900/20 text-orange-800 dark:text-orange-300 border border-orange-200 dark:border-orange-800">
                <Crosshair size={14} className="shrink-0" aria-hidden="true" />
                <span className="truncate" title={targetText}>{targetText}</span>
                <button
                  type="button"
                  onClick={() => applyFilters({ ...filters, target_type: '', target_id: '' })}
                  aria-label={`Remover o filtro (${targetText})`}
                  title="Remover este filtro"
                  className="shrink-0 p-1 rounded-full hover:bg-orange-100 dark:hover:bg-orange-900/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </span>
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            <FormField label="Estabelecimento">
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
            <FormField label="Quem fez" hint="Conta que executou a ação (inclusive na lixeira).">
              {(field) => (
                <EntityPicker
                  {...field}
                  value={actorOption}
                  onChange={(option) => {
                    setActorOption(option);
                    setFilter('actor_id', option?.id ?? null);
                  }}
                  search={searchUserOptions}
                  placeholder="Qualquer pessoa (buscar nome ou e-mail)"
                  listLabel="Contas encontradas"
                  noResultsText="Nenhuma conta encontrada."
                  clearLabel="Remover o filtro de autor"
                />
              )}
            </FormField>
            <ActionFilter value={filters.action} onChange={(action) => setFilter('action', action)} />
            <FormField label="Resultado">
              {(field) => (
                <select
                  {...field}
                  value={filters.result}
                  onChange={(event) => setFilter('result', event.target.value as AuditResult | '')}
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
                  onChange={(event) => setFilter('actor_scope', event.target.value as AuditActorScope | '')}
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
              onChange={(range) => applyFilters({ ...filters, from: range.from, to: range.to })}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Datas no calendário da plataforma (o dia inteiro). Metadados sem senhas, tokens ou segredos.
            </p>
            {filtered && (
              <button type="button" onClick={resetFilters} className={buttonClass('ghost', 'sm')}>
                <FilterX size={14} aria-hidden="true" /> Limpar filtros
              </button>
            )}
          </div>
        </div>
      </PageHeader>

      <AuditLogTable
        caption="Registros da auditoria"
        rows={query.items}
        loading={query.loading}
        error={query.error}
        onRetry={() => void query.reload()}
        onSelect={setSelected}
        emptyTitle={filtered ? 'Nenhum registro com esses filtros' : 'Nenhum registro de auditoria ainda'}
        emptyDescription={filtered
          ? 'Amplie o período ou remova algum filtro.'
          : 'As ações do superpainel, das equipes das lojas, das rotinas e os eventos de login aparecem aqui.'}
        emptyAction={filtered ? (
          <button type="button" onClick={resetFilters} className={buttonClass('secondary', 'sm')}>
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

      <p className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
        <ShieldCheck size={14} className="shrink-0" aria-hidden="true" />
        As alterações feitas no superpainel também ficam registradas aqui, com o seu usuário.
      </p>

      <AuditDetailModal entry={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
