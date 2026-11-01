import { useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, BarChart3, Ban, CreditCard, Crown, ExternalLink, Globe, Headset, History, LayoutDashboard, MailPlus, Pencil,
  PlayCircle, PowerOff, RotateCcw, ShieldAlert, Users, X,
} from 'lucide-react';
import {
  CARD_CLASS, EmptyState, ErrorState, PageHeader, StatusBadge, Tabs, buttonClass, cx, type TabItem,
} from '../../../components/ui';
import PageLoader from '../../../components/PageLoader';
import StoreLogo from '../../../components/BrandLogo/StoreLogo';
import { safeRedirect } from '../../../services/api';
import {
  platformStoresService, type StoreMutationResult, type StoreStatusAction,
} from '../../../services/platform/storesService';
import { isBlockedAvailability } from '../../../services/storeAccess';
import { STORE_ACCOUNT_STATUS, statusMeta } from '../../../utils/saasStatus';
import { formatDateTime } from '../../../utils/format';
import { AVAILABILITY_META } from '../Subscriptions/billingDisplay';
import { formatDate } from '../../../utils/dates';
import { useResource } from '../../../hooks/useResource';
import AuditTab from './AuditTab';
import InvitationsTab from './InvitationsTab';
import MetricsTab from './MetricsTab';
import OverviewTab from './OverviewTab';
import { OwnerPickerDialog, RemoveOwnerConfirm } from './OwnerDialogs';
import { EditStoreDialog, StatusChangeDialog } from './StoreDialogs';
import SubscriptionTab from './SubscriptionTab';
import SupportTab from './SupportTab';
import TeamTab from './TeamTab';
import { StartSupportDialog } from './SupportDialogs';

type DetailTab = 'overview' | 'team' | 'subscription' | 'invitations' | 'metrics' | 'audit' | 'support';

const TABS: TabItem<DetailTab>[] = [
  { value: 'overview', label: 'Visão geral', icon: <LayoutDashboard size={16} /> },
  { value: 'team', label: 'Equipe', icon: <Users size={16} /> },
  { value: 'subscription', label: 'Assinatura', icon: <CreditCard size={16} /> },
  { value: 'invitations', label: 'Convites', icon: <MailPlus size={16} /> },
  { value: 'metrics', label: 'Métricas', icon: <BarChart3 size={16} /> },
  { value: 'audit', label: 'Auditoria', icon: <History size={16} /> },
  { value: 'support', label: 'Suporte', icon: <Headset size={16} /> },
];

function parseTab(value: string | null): DetailTab {
  return TABS.find((tab) => tab.value === value)?.value ?? 'overview';
}

/** Volta para a lista com os mesmos filtros (estado da navegação vindo da lista). */
function backPath(state: unknown): string {
  const from = state && typeof state === 'object' ? (state as { from?: unknown }).from : null;
  const path = safeRedirect(from);
  return path && path.startsWith('/platform/stores') ? path : '/platform/stores';
}

/**
 * Superpainel › Detalhe do estabelecimento (/platform/stores/:id): cabeçalho com situação e ações (editar dados e
 * endereço, responsável, suspender/reativar/desativar/restaurar com motivo, sessão de suporte) e as abas Visão geral,
 * Equipe, Assinatura, Convites, Métricas, Auditoria e Suporte. ?tab=<aba> abre direto numa aba.
 */
export default function PlatformStoreDetail() {
  const { id } = useParams();
  const location = useLocation();
  const storeId = Number(id);
  const back = { to: backPath(location.state), label: 'Estabelecimentos' };

  if (!Number.isInteger(storeId) || storeId <= 0) {
    return (
      <div className="space-y-6 pb-20">
        <PageHeader title="Estabelecimento" back={back} />
        <div className={CARD_CLASS}>
          <EmptyState
            title="Estabelecimento não encontrado"
            description="O endereço não corresponde a um estabelecimento da plataforma."
            action={<Link to="/platform/stores" className={buttonClass('secondary')}>Ver estabelecimentos</Link>}
          />
        </div>
      </div>
    );
  }

  return <StoreDetailView key={storeId} storeId={storeId} back={back} />;
}

function StoreDetailView({ storeId, back }: { storeId: number; back: { to: string; label: string } }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseTab(searchParams.get('tab'));
  const resource = useResource((signal) => platformStoresService.get(storeId, signal), {
    key: String(storeId),
    errorMessage: 'Não foi possível carregar o estabelecimento.',
  });
  const store = resource.data;

  const [warnings, setWarnings] = useState<string[]>([]);
  const [statusAction, setStatusAction] = useState<StoreStatusAction | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [removeOwnerOpen, setRemoveOwnerOpen] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);

  const { setData, reload } = resource;

  function setTab(next: DetailTab) {
    setSearchParams((previous) => {
      const params = new URLSearchParams(previous);
      if (next === 'overview') params.delete('tab');
      else params.set('tab', next);
      return params;
    }, { replace: true });
  }

  function applyMutation(result: StoreMutationResult) {
    setData(result.store);
    setWarnings(result.warnings);
  }

  if (!store) {
    return (
      <div className="space-y-6 pb-20">
        <PageHeader title="Estabelecimento" back={back} icon={<ShieldAlert size={26} />} />
        {resource.error ? (
          <div className={CARD_CLASS}>
            {resource.errorStatus === 404 ? (
              <EmptyState
                title="Estabelecimento não encontrado"
                description="Ele não existe (lojas nunca são apagadas: confira o endereço)."
                action={<Link to="/platform/stores" className={buttonClass('secondary')}>Ver estabelecimentos</Link>}
              />
            ) : (
              <ErrorState message={resource.error} onRetry={() => void reload()} retrying={resource.loading} />
            )}
          </div>
        ) : (
          <PageLoader />
        )}
      </div>
    );
  }

  const accountMeta = statusMeta(STORE_ACCOUNT_STATUS, store.account_status);
  const access = store.access;
  const availability = access ? AVAILABILITY_META[access.availability] : null;
  const storefrontUrl = `/loja/${store.slug}`;

  return (
    <div className="space-y-6 pb-20">
      <PageHeader
        back={back}
        title={(
          <span className="flex items-center gap-3 min-w-0">
            <StoreLogo name={store.name} logo={store.logo} color={store.primary_color} size={44} decorative />
            <span className="min-w-0 wrap-break-word">{store.name}</span>
          </span>
        )}
        subtitle={(
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <a
              href={storefrontUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono text-sm text-orange-700 dark:text-orange-400 hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              {storefrontUrl} <ExternalLink size={14} aria-hidden="true" /><span className="sr-only">(abre a vitrine em nova aba)</span>
            </a>
            {store.custom_domain && (
              <span className="inline-flex items-center gap-1 text-sm" title="Registrado; ainda não roteado automaticamente">
                <Globe size={14} aria-hidden="true" /> <span className="font-mono">{store.custom_domain}</span>
              </span>
            )}
            <span className="text-sm">Desde {formatDate(store.created_at)}</span>
          </span>
        )}
        actions={(
          <>
            <button type="button" onClick={() => setEditOpen(true)} className={buttonClass('secondary', 'sm')}>
              <Pencil size={14} aria-hidden="true" /> Editar dados
            </button>
            <button type="button" onClick={() => setOwnerOpen(true)} className={buttonClass('secondary', 'sm')}>
              <Crown size={14} aria-hidden="true" /> Responsável
            </button>
            {store.account_status !== 'INACTIVE' && (
              <button type="button" onClick={() => setSupportOpen(true)} className={buttonClass('secondary', 'sm')}>
                <Headset size={14} aria-hidden="true" /> Suporte
              </button>
            )}
            {store.account_status === 'ACTIVE' && (
              <button type="button" onClick={() => setStatusAction('suspend')} className={buttonClass('secondary', 'sm', 'text-amber-700 dark:text-amber-300')}>
                <Ban size={14} aria-hidden="true" /> Suspender
              </button>
            )}
            {store.account_status === 'SUSPENDED' && (
              <button type="button" onClick={() => setStatusAction('reactivate')} className={buttonClass('primary', 'sm')}>
                <PlayCircle size={14} aria-hidden="true" /> Reativar
              </button>
            )}
            {(store.account_status === 'ACTIVE' || store.account_status === 'SUSPENDED') && (
              <button type="button" onClick={() => setStatusAction('deactivate')} className={buttonClass('danger', 'sm')}>
                <PowerOff size={14} aria-hidden="true" /> Desativar
              </button>
            )}
            {store.account_status === 'INACTIVE' && (
              <button type="button" onClick={() => setStatusAction('restore')} className={buttonClass('primary', 'sm')}>
                <RotateCcw size={14} aria-hidden="true" /> Restaurar
              </button>
            )}
          </>
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={accountMeta.tone} dot>Cadastro: {accountMeta.label}</StatusBadge>
          {availability && <StatusBadge tone={availability.tone}>{availability.label}</StatusBadge>}
          {store.is_default_store && <StatusBadge tone="info" icon={<Globe size={12} />}>Loja padrão</StatusBadge>}
          {store.account_status === 'ACTIVE' && (
            <StatusBadge tone={store.is_open ? 'success' : 'neutral'}>{store.is_open ? 'Aberta agora' : 'Fechada agora'}</StatusBadge>
          )}
        </div>
      </PageHeader>

      {resource.error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 px-4 py-3 rounded-2xl text-sm bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
          <AlertTriangle size={16} className="shrink-0" aria-hidden="true" />
          <span className="flex-1 min-w-48">{resource.error} Os dados abaixo podem estar desatualizados.</span>
          <button type="button" onClick={() => void reload()} className="font-bold hover:underline">Tentar novamente</button>
        </div>
      )}

      {warnings.length > 0 && (
        <div role="status" className="flex items-start gap-3 px-4 py-3 rounded-2xl text-sm bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
          <AlertTriangle size={18} className="shrink-0 mt-0.5" aria-hidden="true" />
          <ul className="flex-1 space-y-1">
            {warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
          <button type="button" onClick={() => setWarnings([])} aria-label="Fechar avisos" className="p-1 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-900/40">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}

      {store.account_status !== 'ACTIVE' && (
        <div
          role="status"
          className={cx(
            'flex items-start gap-3 px-4 py-3 rounded-2xl text-sm border',
            store.account_status === 'INACTIVE'
              ? 'bg-gray-50 dark:bg-slate-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-slate-700'
              : 'bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800',
          )}
        >
          <ShieldAlert size={18} className="shrink-0 mt-0.5" aria-hidden="true" />
          <p>
            <span className="font-bold">{store.account_status === 'INACTIVE' ? 'Estabelecimento desativado' : 'Estabelecimento suspenso'}</span>
            {store.status_changed_at && <> desde {formatDateTime(store.status_changed_at)}</>}
            {store.status_reason ? <>. Motivo: “{store.status_reason}”.</> : '.'}
          </p>
        </div>
      )}

      {access?.message && (
        <div
          role={isBlockedAvailability(access.availability) ? 'alert' : 'status'}
          className={cx(
            'flex items-start gap-3 px-4 py-3 rounded-2xl text-sm border',
            isBlockedAvailability(access.availability)
              ? 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 border-red-200 dark:border-red-800'
              : 'bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800',
          )}
        >
          <ShieldAlert size={18} className="shrink-0 mt-0.5" aria-hidden="true" />
          <p><span className="font-bold">Aviso que a loja vê: </span>{access.message}</p>
        </div>
      )}

      <Tabs tabs={TABS} value={tab} onChange={setTab} label="Seções do estabelecimento">
        {tab === 'overview' && (
          <OverviewTab
            store={store}
            onDefineOwner={() => setOwnerOpen(true)}
            onRemoveOwner={() => setRemoveOwnerOpen(true)}
            onOpenSubscription={() => setTab('subscription')}
          />
        )}
        {tab === 'team' && <TeamTab store={store} onStoreUpdated={applyMutation} />}
        {tab === 'subscription' && <SubscriptionTab store={store} onChanged={() => void reload({ silent: true })} />}
        {tab === 'invitations' && <InvitationsTab store={store} onChanged={() => void reload({ silent: true })} />}
        {tab === 'metrics' && <MetricsTab store={store} />}
        {tab === 'audit' && <AuditTab store={store} />}
        {tab === 'support' && <SupportTab store={store} />}
      </Tabs>

      <StatusChangeDialog store={store} action={statusAction} onClose={() => setStatusAction(null)} onDone={applyMutation} />
      <EditStoreDialog open={editOpen} store={store} onClose={() => setEditOpen(false)} onDone={applyMutation} />
      <OwnerPickerDialog open={ownerOpen} store={store} onClose={() => setOwnerOpen(false)} onDone={applyMutation} />
      <RemoveOwnerConfirm open={removeOwnerOpen} store={store} onClose={() => setRemoveOwnerOpen(false)} onDone={applyMutation} />
      <StartSupportDialog open={supportOpen} store={store} onClose={() => setSupportOpen(false)} />
    </div>
  );
}

