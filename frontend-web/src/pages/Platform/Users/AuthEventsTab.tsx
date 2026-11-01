import { useId, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertCircle, Check, FilterX } from 'lucide-react';
import { CARD_CLASS, FormField, Pagination, buttonClass, cx, fieldControlClass } from '../../../components/ui';
import { usePaginatedQuery } from '../../../hooks/usePaginatedQuery';
import { AUDIT_RESULTS, type AuditLogEntry, type AuditResult } from '../../../services/platform/auditService';
import {
  EMPTY_AUTH_EVENT_FILTERS, platformAuthEventsService, type AuthEventFilters,
} from '../../../services/platform/authEventsService';
import AuditDetailModal from '../Audit/AuditDetailModal';
import AuditLogTable from '../Audit/AuditLogTable';
import DateRangeFilter from '../Audit/DateRangeFilter';
import EntityPicker from '../Audit/EntityPicker';
import { AUDIT_RESULT_META } from '../Audit/auditLabels';
import { resolveUserOption, searchUserOptions, type PickerOption } from '../Audit/pickerOptions';
import { useLabeledOption } from '../Audit/useLabeledOption';
import { authEventFiltersFromParams, authEventFiltersToParams, hasAuthEventFilters } from './urlFilters';
import { isValidEmail } from '../../../utils/validation';

const PAGE_SIZE_OPTIONS = [20, 50, 100];

interface AuthEventsTabProps {
  /** Conta já conhecida por quem abriu a aba (evita buscar o nome de novo). */
  knownAccount?: PickerOption | null;
}

/**
 * Aba "Eventos de autenticação": GET /platform/auth-events (logins, falhas, logout geral e redefinições
 * de senha) com filtros de conta, e-mail da tentativa (inclusive de contas inexistentes), resultado e período.
 */
export default function AuthEventsTab({ knownAccount = null }: AuthEventsTabProps) {
  const emailErrorId = useId();
  const [searchParams, setSearchParams] = useSearchParams();
  // Aberta pelo detalhe de uma conta ("Ver todos os eventos"): só o filtro dessa conta
  const [initialFilters] = useState<AuthEventFilters>(() => (knownAccount
    ? { ...EMPTY_AUTH_EVENT_FILTERS, user_id: knownAccount.id }
    : authEventFiltersFromParams(searchParams)));
  const [selected, setSelected] = useState<AuditLogEntry | null>(null);

  const query = usePaginatedQuery<AuditLogEntry, AuthEventFilters>({
    fetcher: ({ page, pageSize, filters, signal }) => platformAuthEventsService.list({ page, pageSize, ...filters }, signal),
    initialFilters,
    initialPageSize: PAGE_SIZE_OPTIONS[0],
    errorMessage: 'Não foi possível carregar os eventos de autenticação.',
  });
  const [account, setAccount] = useLabeledOption(initialFilters.user_id, resolveUserOption, (id) => `Conta #${id}`, knownAccount);

  const filters = query.filters;
  const filtered = hasAuthEventFilters(filters);

  // E-mail da tentativa: aplicado ao confirmar (Enter, botão ou ao sair do campo)
  const [emailDraft, setEmailDraft] = useState(filters.email);
  const [syncedEmail, setSyncedEmail] = useState(filters.email);
  const [emailSubmitted, setEmailSubmitted] = useState(false);
  if (syncedEmail !== filters.email) {
    setSyncedEmail(filters.email);
    setEmailDraft(filters.email);
    setEmailSubmitted(false);
  }
  const emailValue = emailDraft.trim().toLowerCase();
  const emailError = emailSubmitted && emailValue !== '' && !isValidEmail(emailValue) ? 'Informe um e-mail válido (ex.: maria@email.com).' : null;

  function applyFilters(next: AuthEventFilters) {
    query.setFilters(next);
    setSearchParams((current) => authEventFiltersToParams(next, current), { replace: true });
  }

  function applyEmail(event?: FormEvent) {
    event?.preventDefault();
    setEmailSubmitted(true);
    if (emailValue !== '' && !isValidEmail(emailValue)) return;
    if (emailValue !== filters.email) applyFilters({ ...filters, email: emailValue });
  }

  function resetFilters() {
    setAccount(null);
    applyFilters(EMPTY_AUTH_EVENT_FILTERS);
  }

  return (
    <div className="space-y-4">
      <div role="search" aria-label="Filtrar eventos de autenticação" className={cx(CARD_CLASS, 'p-4 sm:p-5 space-y-4')}>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          <FormField label="Conta" hint="Eventos em que a conta é autora ou alvo.">
            {(field) => (
              <EntityPicker
                {...field}
                value={account}
                onChange={(option) => {
                  setAccount(option);
                  applyFilters({ ...filters, user_id: option?.id ?? null });
                }}
                search={searchUserOptions}
                placeholder="Todas as contas (buscar)"
                listLabel="Contas encontradas"
                noResultsText="Nenhuma conta encontrada."
                clearLabel="Remover o filtro de conta"
              />
            )}
          </FormField>
          <div className="space-y-1.5">
            <FormField label="E-mail da tentativa" hint="Também encontra tentativas com e-mails sem conta.">
              {(field) => (
                // noValidate: a validação é a da tela (mensagem em português), não o balão do navegador
                <form onSubmit={applyEmail} noValidate className="flex gap-2">
                  <input
                    {...field}
                    type="email"
                    inputMode="email"
                    value={emailDraft}
                    onChange={(event) => setEmailDraft(event.target.value)}
                    onBlur={() => applyEmail()}
                    placeholder="maria@email.com"
                    aria-invalid={emailError ? true : undefined}
                    aria-describedby={[emailError ? emailErrorId : null, field['aria-describedby']].filter(Boolean).join(' ') || undefined}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={160}
                    className={fieldControlClass(!!emailError)}
                  />
                  <button type="submit" aria-label="Aplicar e-mail" className={buttonClass('secondary', 'icon', 'shrink-0')}>
                    <Check size={18} aria-hidden="true" />
                  </button>
                </form>
              )}
            </FormField>
            {emailError && (
              <p id={emailErrorId} role="alert" className="flex items-start gap-1 text-xs font-semibold text-red-600 dark:text-red-400">
                <AlertCircle size={13} className="shrink-0 mt-px" aria-hidden="true" /> <span>{emailError}</span>
              </p>
            )}
          </div>
          <FormField label="Resultado">
            {(field) => (
              <select
                {...field}
                value={filters.result}
                onChange={(event) => applyFilters({ ...filters, result: event.target.value as AuditResult | '' })}
                className={fieldControlClass()}
              >
                <option value="">Todos os resultados</option>
                {AUDIT_RESULTS.map((result) => <option key={result} value={result}>{AUDIT_RESULT_META[result].label}</option>)}
              </select>
            )}
          </FormField>
          <DateRangeFilter
            from={filters.from}
            to={filters.to}
            onChange={(range) => applyFilters({ ...filters, from: range.from, to: range.to })}
          />
        </div>
        {filtered && (
          <div className="flex justify-end">
            <button type="button" onClick={resetFilters} className={buttonClass('ghost', 'sm')}>
              <FilterX size={14} aria-hidden="true" /> Limpar filtros
            </button>
          </div>
        )}
      </div>

      <AuditLogTable
        variant="auth"
        caption="Eventos de autenticação"
        rows={query.items}
        loading={query.loading}
        error={query.error}
        onRetry={() => void query.reload()}
        onSelect={setSelected}
        emptyTitle={filtered ? 'Nenhum evento com esses filtros' : 'Nenhum evento de autenticação ainda'}
        emptyDescription={filtered
          ? 'Amplie o período ou remova algum filtro.'
          : 'Logins, falhas de login, saídas de todos os dispositivos e redefinições de senha aparecem aqui.'}
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
            itemLabel="eventos"
          />
        ) : undefined}
      />

      <AuditDetailModal entry={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
