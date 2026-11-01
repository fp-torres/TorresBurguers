import { useState } from 'react';
import { Icon } from '@iconify/react';
import { Check, Edit, EyeOff, Layers, Minus, Plus, PlayCircle, PowerOff } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  DataTable, FilterTabs, PageHeader, Pagination, SearchInput, StatusBadge, buttonClass, cx, type DataTableColumn, type FilterTabOption,
} from '../../../components/ui';
import ConfirmModal from '../../../components/ConfirmModal';
import { usePaginatedQuery } from '../../../hooks/usePaginatedQuery';
import { getApiErrorMessage } from '../../../services/api';
import { platformPlansService } from '../../../services/platform/plansService';
import type { PlanStatus, PlatformPlan } from '../../../services/platform/billingParsers';
import { PLAN_FEATURE_KEYS, PLAN_FEATURE_LABELS } from '../../../services/storeAccess';
import { formatCurrency } from '../../../utils/format';
import AuditLink from '../Audit/AuditLink';
import { auditUrl } from '../Audit/urlFilters';
import {
  FEATURE_SHORT_LABELS, PLAN_LIMIT_LABELS, STORAGE_LIMIT_LABEL, limitLabel, planPriceLabel, storageLimitLabel,
} from '../Subscriptions/billingDisplay';
import PlanFormModal from './PlanFormModal';

type StatusFilter = 'ALL' | PlanStatus;
type VisibilityFilter = 'ALL' | 'PUBLIC' | 'HIDDEN';
type PlanFilters = { status: StatusFilter; visibility: VisibilityFilter };

const STATUS_TABS: FilterTabOption<StatusFilter>[] = [
  { value: 'ALL', label: 'Todos' },
  { value: 'ACTIVE', label: 'Disponíveis' },
  { value: 'INACTIVE', label: 'Indisponíveis' },
];

const VISIBILITY_TABS: FilterTabOption<VisibilityFilter>[] = [
  { value: 'ALL', label: 'Qualquer visibilidade' },
  { value: 'PUBLIC', label: 'Públicos' },
  { value: 'HIDDEN', label: 'Ocultos' },
];

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

/**
 * Superpainel › Planos (/platform/plans): lista (GET /platform/plans) com busca e filtros e o formulário em diálogo
 * para criar (POST) e editar (PATCH /platform/plans/:id). Planos não são excluídos: tirar de venda = Indisponível.
 * Cada plano leva à auditoria das mudanças dele (alvo plan).
 */
export default function PlatformPlans() {
  const [formPlan, setFormPlan] = useState<{ open: boolean; plan: PlatformPlan | null }>({ open: false, plan: null });
  const [toToggle, setToToggle] = useState<PlatformPlan | null>(null);
  const [toggling, setToggling] = useState(false);

  const query = usePaginatedQuery<PlatformPlan, PlanFilters>({
    fetcher: ({ page, pageSize, search, filters, signal }) => platformPlansService.list({
      page,
      pageSize,
      search,
      status: filters.status === 'ALL' ? undefined : filters.status,
      is_public: filters.visibility === 'ALL' ? undefined : filters.visibility === 'PUBLIC',
    }, signal),
    initialFilters: { status: 'ALL', visibility: 'ALL' },
    errorMessage: 'Não foi possível carregar os planos.',
  });

  const filtered = query.search.trim() !== '' || query.filters.status !== 'ALL' || query.filters.visibility !== 'ALL';

  async function toggleAvailability() {
    if (!toToggle) return;
    const next: PlanStatus = toToggle.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    setToggling(true);
    try {
      const saved = await platformPlansService.update(toToggle.id, { status: next });
      toast.success(next === 'ACTIVE' ? `${saved.name} está disponível para novas contratações.` : `${saved.name} saiu de venda.`);
      setToToggle(null);
      void query.reload({ silent: true });
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Não foi possível alterar a disponibilidade do plano.'), { duration: 6000 });
    } finally {
      setToggling(false);
    }
  }

  const columns: DataTableColumn<PlatformPlan>[] = [
    {
      key: 'plan',
      header: 'Plano',
      cell: (plan) => (
        <div className="min-w-0 max-w-72">
          <button
            type="button"
            onClick={() => setFormPlan({ open: true, plan })}
            className="font-bold text-left text-gray-800 dark:text-white wrap-break-word hover:text-orange-700 dark:hover:text-orange-400 hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          >
            {plan.name}<span className="sr-only"> (editar)</span>
          </button>
          <p className="font-mono text-xs text-gray-500 dark:text-gray-400">{plan.code}</p>
          {plan.description && <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">{plan.description}</p>}
        </div>
      ),
    },
    {
      key: 'price',
      header: 'Preço',
      className: 'whitespace-nowrap',
      cell: (plan) => (
        <div>
          <p className="font-bold tabular-nums text-gray-800 dark:text-white">{planPriceLabel(plan.price, plan.billing_interval)}</p>
          {plan.price > 0 && plan.billing_interval === 'YEARLY' && (
            <p className="text-xs text-gray-500 dark:text-gray-400">{formatCurrency(plan.monthly_price)} / mês</p>
          )}
          <p className="text-xs text-gray-500 dark:text-gray-400">{plan.trial_days > 0 ? `${plan.trial_days} dia${plan.trial_days === 1 ? '' : 's'} grátis` : 'Sem teste grátis'}</p>
        </div>
      ),
    },
    {
      key: 'limits',
      header: 'Limites',
      className: 'hidden md:table-cell text-xs',
      headerClassName: 'hidden md:table-cell',
      cell: (plan) => (
        <dl className="space-y-0.5 whitespace-nowrap">
          {([['staff_users', plan.max_staff_users], ['products', plan.max_products], ['monthly_orders', plan.max_monthly_orders]] as const).map(([key, limit]) => (
            <div key={key} className="flex gap-1">
              <dt className="text-gray-500 dark:text-gray-400">{PLAN_LIMIT_LABELS[key]}:</dt>
              <dd className="font-semibold text-gray-700 dark:text-gray-200 tabular-nums">{limitLabel(limit)}</dd>
            </div>
          ))}
          <div className="flex gap-1">
            <dt className="text-gray-500 dark:text-gray-400">{STORAGE_LIMIT_LABEL}:</dt>
            <dd className="font-semibold text-gray-700 dark:text-gray-200 tabular-nums">{storageLimitLabel(plan.max_storage_mb)}</dd>
          </div>
        </dl>
      ),
    },
    {
      key: 'features',
      header: 'Recursos',
      className: 'hidden lg:table-cell text-xs',
      headerClassName: 'hidden lg:table-cell',
      cell: (plan) => (
        <ul className="space-y-0.5">
          {PLAN_FEATURE_KEYS.map((key) => (
            <li
              key={key}
              title={PLAN_FEATURE_LABELS[key]}
              className={cx('flex items-center gap-1.5 whitespace-nowrap', plan.features[key] ? 'text-gray-700 dark:text-gray-200' : 'text-gray-400 dark:text-gray-500 line-through')}
            >
              {plan.features[key]
                ? <Check size={12} className="text-green-600 dark:text-green-400" aria-hidden="true" />
                : <Minus size={12} aria-hidden="true" />}
              {FEATURE_SHORT_LABELS[key]}
              <span className="sr-only">{plan.features[key] ? ': incluído' : ': não incluído'}</span>
            </li>
          ))}
        </ul>
      ),
    },
    {
      key: 'status',
      header: 'Disponibilidade',
      cell: (plan) => (
        <div className="flex flex-col gap-1">
          {plan.status === 'ACTIVE'
            ? <StatusBadge tone="success" dot>Disponível</StatusBadge>
            : <StatusBadge tone="neutral" dot>Indisponível</StatusBadge>}
          {plan.is_public
            ? <StatusBadge tone="info">Público</StatusBadge>
            : <StatusBadge tone="neutral" icon={<EyeOff size={12} />}>Oculto</StatusBadge>}
        </div>
      ),
    },
    {
      key: 'subscriptions',
      header: 'Assinaturas',
      align: 'center',
      className: 'tabular-nums',
      cell: (plan) => (plan.active_subscriptions === null ? '—' : plan.active_subscriptions),
    },
    {
      key: 'order',
      header: 'Ordem',
      align: 'center',
      className: 'hidden 2xl:table-cell tabular-nums',
      headerClassName: 'hidden 2xl:table-cell',
      cell: (plan) => plan.sort_order,
    },
    {
      key: 'actions',
      header: <span className="sr-only">Ações</span>,
      align: 'right',
      cell: (plan) => (
        <div className="flex flex-wrap justify-end gap-1.5">
          <button
            type="button"
            onClick={() => setFormPlan({ open: true, plan })}
            aria-label={`Editar o plano ${plan.name}`}
            title="Editar"
            className={buttonClass('secondary', 'icon')}
          >
            <Edit size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setToToggle(plan)}
            aria-label={plan.status === 'ACTIVE' ? `Tirar o plano ${plan.name} de venda` : `Disponibilizar o plano ${plan.name}`}
            title={plan.status === 'ACTIVE' ? 'Tirar de venda' : 'Disponibilizar'}
            className={buttonClass('ghost', 'icon', plan.status === 'ACTIVE' ? 'text-red-600 dark:text-red-400' : 'text-green-700 dark:text-green-400')}
          >
            {plan.status === 'ACTIVE' ? <PowerOff size={16} aria-hidden="true" /> : <PlayCircle size={16} aria-hidden="true" />}
          </button>
          <AuditLink to={auditUrl({ target_type: 'plan', target_id: plan.id })} label={`Ver auditoria do plano ${plan.name}`} variant="ghost" size="icon" />
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6 pb-20">
      <PageHeader
        title="Planos"
        subtitle="Preços, limites e recursos oferecidos aos estabelecimentos"
        icon={<Icon icon="solar:layers-bold-duotone" width={26} />}
        actions={(
          <button type="button" onClick={() => setFormPlan({ open: true, plan: null })} className={buttonClass('primary')}>
            <Plus size={18} aria-hidden="true" /> Novo plano
          </button>
        )}
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <SearchInput
              value={query.search}
              onChange={query.setSearch}
              placeholder="Buscar por nome ou código..."
              label="Buscar planos"
              className="flex-1 sm:max-w-md"
            />
            {filtered && <button type="button" onClick={query.reset} className={buttonClass('ghost')}>Limpar filtros</button>}
          </div>
          <div className="flex flex-wrap gap-x-4">
            <FilterTabs label="Filtrar por disponibilidade" options={STATUS_TABS} value={query.filters.status} onChange={(value) => query.setFilter('status', value)} className="-mx-2" />
            <FilterTabs label="Filtrar por visibilidade" options={VISIBILITY_TABS} value={query.filters.visibility} onChange={(value) => query.setFilter('visibility', value)} className="-mx-2" />
          </div>
        </div>
      </PageHeader>

      <DataTable
        stackOnMobile
        caption="Planos da plataforma"
        columns={columns}
        rows={query.items}
        rowKey={(plan) => plan.id}
        loading={query.loading}
        error={query.error}
        onRetry={() => void query.reload()}
        rowClassName={(plan) => (plan.status === 'INACTIVE' ? 'opacity-80' : undefined)}
        emptyIcon={<Layers size={32} />}
        emptyTitle={filtered ? 'Nenhum plano encontrado' : 'Nenhum plano cadastrado'}
        emptyDescription={filtered ? 'Ajuste a busca ou os filtros.' : 'Crie o primeiro plano para os estabelecimentos contratarem.'}
        emptyAction={filtered
          ? <button type="button" onClick={query.reset} className={buttonClass('secondary', 'sm')}>Limpar filtros</button>
          : <button type="button" onClick={() => setFormPlan({ open: true, plan: null })} className={buttonClass('primary', 'sm')}><Plus size={14} aria-hidden="true" /> Novo plano</button>}
        footer={query.total > 0 ? (
          <Pagination
            page={query.page}
            pageSize={query.pageSize}
            total={query.total}
            onPageChange={query.setPage}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            onPageSizeChange={query.setPageSize}
            disabled={query.loading}
            itemLabel="planos"
          />
        ) : undefined}
      />

      <PlanFormModal
        open={formPlan.open}
        plan={formPlan.plan}
        onClose={() => setFormPlan({ open: false, plan: null })}
        onSaved={() => void query.reload({ silent: true })}
      />

      <ConfirmModal
        isOpen={!!toToggle}
        onClose={() => setToToggle(null)}
        onConfirm={toggleAvailability}
        closeOnConfirm={false}
        loading={toggling}
        title={toToggle?.status === 'ACTIVE' ? 'Tirar o plano de venda?' : 'Disponibilizar o plano?'}
        message={toToggle?.status === 'ACTIVE'
          ? `${toToggle.name} deixa de aparecer para novas contratações (inclusive no cadastro de lojas). As ${toToggle.active_subscriptions ?? 0} assinatura(s) atuais continuam no plano. Ele não é excluído e pode voltar a ser vendido.`
          : `${toToggle?.name ?? 'O plano'} volta a ficar disponível para novas contratações${toToggle?.is_public ? ' e aparece na página pública de planos' : ''}.`}
        confirmLabel={toToggle?.status === 'ACTIVE' ? 'Tirar de venda' : 'Disponibilizar'}
        isDestructive={toToggle?.status === 'ACTIVE'}
      />
    </div>
  );
}
