import type { ReactNode } from 'react';
import {
  Ban, Check, Clock, Crown, CreditCard, Globe, Minus, Receipt, ShoppingBag, Star, Users, Wallet,
} from 'lucide-react';
import { CARD_CLASS, StatCard, StatusBadge, buttonClass, cx } from '../../../components/ui';
import type { PlatformStoreDetail } from '../../../services/platform/storesService';
import { PLAN_FEATURE_KEYS, PLAN_FEATURE_LABELS } from '../../../services/storeAccess';
import { formatCurrency, formatDateTime, formatInteger } from '../../../utils/format';
import { roleLabel } from '../../../utils/roles';
import UsageMeters from '../Subscriptions/UsageMeters';
import { planPriceLabel } from '../Subscriptions/billingDisplay';
import { formatDate } from '../../../utils/dates';
import { addressLine, formatDocument, formatPhone, shortKey } from './storeDisplay';

interface OverviewTabProps {
  store: PlatformStoreDetail;
  onDefineOwner: () => void;
  onRemoveOwner: () => void;
  onOpenSubscription: () => void;
}


/**
 * Visão geral do estabelecimento (GET /platform/stores/:id): indicadores, uso × limites do plano, recursos,
 * cadastro, responsável, operação e pagamentos configurados. Os números vêm da API (metodologia abaixo).
 */
export default function OverviewTab({ store, onDefineOwner, onRemoveOwner, onOpenSubscription }: OverviewTabProps) {
  const { metrics } = store;
  const currentSubscription = store.subscription && store.subscription.status !== 'CANCELED' ? store.subscription : null;
  const address = addressLine(store);

  return (
    <div className="space-y-6">
      <section aria-labelledby="overview-kpis" className="space-y-3">
        <h2 id="overview-kpis" className="sr-only">Indicadores</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <StatCard
            label="Pedidos (30 dias)"
            value={formatInteger(metrics.orders_30d)}
            icon={<ShoppingBag size={22} />}
            tone="blue"
            hint={`${formatInteger(metrics.orders_total)} no total · ${formatInteger(metrics.canceled_orders_total)} cancelados no total`}
          />
          <StatCard
            label="GMV da loja (30 dias)"
            value={formatCurrency(metrics.gmv_30d)}
            icon={<Wallet size={22} />}
            tone="emerald"
            hint={`${formatCurrency(metrics.gmv_total)} desde o início · vendas da loja, não receita da plataforma`}
          />
          <StatCard
            label="Clientes"
            value={formatInteger(metrics.customers)}
            icon={<Star size={22} />}
            tone="violet"
            hint="Contas distintas que já pediram aqui"
          />
          <StatCard
            label="Equipe ativa"
            value={formatInteger(metrics.active_staff)}
            icon={<Users size={22} />}
            tone="orange"
            hint={`${formatInteger(metrics.staff)} fora da lixeira (inclui bloqueados) · ${formatInteger(metrics.active_admins)} administrador(es) ativo(s)`}
          />
        </div>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
          <span className="inline-flex items-center gap-1"><Clock size={12} aria-hidden="true" /> Último pedido: {metrics.last_order_at ? formatDateTime(metrics.last_order_at) : 'nenhum pedido ainda'}</span>
          {metrics.methodology && <span>{metrics.methodology}</span>}
        </p>
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <section aria-labelledby="overview-usage" className={cx(CARD_CLASS, 'xl:col-span-2 p-5 sm:p-6 space-y-4')}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="overview-usage" className="text-base font-bold text-gray-800 dark:text-white">Uso × limites do plano</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {currentSubscription
                  ? `${currentSubscription.plan?.name ?? 'Plano'} · ${planPriceLabel(currentSubscription.plan?.price ?? null, currentSubscription.plan?.billing_interval ?? null)}`
                  : 'Sem assinatura vigente: só o uso atual, sem limites de plano.'}
              </p>
            </div>
            <button type="button" onClick={onOpenSubscription} className={buttonClass('secondary', 'sm')}>
              <CreditCard size={14} aria-hidden="true" /> Ver assinatura
            </button>
          </div>
          <UsageMeters usage={store.usage} limits={store.limits} />
        </section>

        <section aria-labelledby="overview-features" className={cx(CARD_CLASS, 'p-5 sm:p-6')}>
          <h2 id="overview-features" className="text-base font-bold text-gray-800 dark:text-white mb-3">Recursos do plano</h2>
          <ul className="space-y-2">
            {PLAN_FEATURE_KEYS.map((key) => {
              const included = store.features[key];
              return (
                <li key={key} className={cx('flex items-start gap-2 text-sm', included ? 'text-gray-700 dark:text-gray-200' : 'text-gray-400 dark:text-gray-500')}>
                  {included
                    ? <Check size={16} className="shrink-0 mt-0.5 text-green-600 dark:text-green-400" aria-hidden="true" />
                    : <Minus size={16} className="shrink-0 mt-0.5" aria-hidden="true" />}
                  <span>{PLAN_FEATURE_LABELS[key]}<span className="sr-only">{included ? ': incluído' : ': não incluído'}</span></span>
                </li>
              );
            })}
          </ul>
          {!currentSubscription && <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">Sem assinatura vigente, nenhum recurso é liberado.</p>}
        </section>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        <InfoCard title="Cadastro" id="overview-profile">
          <InfoList>
          <InfoRow label="Razão social" value={store.legal_name} />
          <InfoRow label="CPF/CNPJ" value={store.document ? formatDocument(store.document) : null} mono />
          <InfoRow label="E-mail" value={store.email} />
          <InfoRow label="Telefone" value={store.phone ? formatPhone(store.phone) : null} />
          <InfoRow label="Endereço" value={address} />
          <InfoRow label="Fuso horário" value={store.time_zone} />
          <InfoRow
            label="Domínio próprio"
            value={store.custom_domain ? (
              <span className="inline-flex flex-col">
                <span className="font-mono break-all">{store.custom_domain}</span>
                <span className="text-xs font-normal text-gray-500 dark:text-gray-400">Registrado; ainda não roteado automaticamente.</span>
              </span>
            ) : null}
          />
          <InfoRow label="Criado em" value={formatDateTime(store.created_at)} />
          <InfoRow label="Atualizado em" value={formatDateTime(store.updated_at)} />
          </InfoList>
        </InfoCard>

        <InfoCard
          title="Responsável"
          id="overview-owner"
          action={(
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={onDefineOwner} className={buttonClass('secondary', 'sm')}>
                <Crown size={14} aria-hidden="true" /> {store.owner ? 'Trocar' : 'Definir'}
              </button>
              {store.owner && (
                <button type="button" onClick={onRemoveOwner} className={buttonClass('ghost', 'sm', 'text-red-600 dark:text-red-400')}>
                  <Ban size={14} aria-hidden="true" /> Remover
                </button>
              )}
            </div>
          )}
        >
          {store.owner ? (
            <div className="space-y-2 text-sm">
              <p className="font-bold text-gray-800 dark:text-white">{store.owner.name || 'Sem nome'}</p>
              <p className="text-gray-600 dark:text-gray-300 break-all">{store.owner.email}</p>
              <div className="flex flex-wrap gap-1.5">
                <StatusBadge tone="info">{roleLabel(store.owner.role) || store.owner.role}</StatusBadge>
                {store.owner.blocked && <StatusBadge tone="danger">Bloqueado</StatusBadge>}
                {store.owner.deleted && <StatusBadge tone="neutral">Na lixeira</StatusBadge>}
                {!store.owner.eligible && (
                  <StatusBadge tone="warning" title="Não é mais um Administrador ativo desta loja">Precisa trocar</StatusBadge>
                )}
              </div>
              {!store.owner.eligible && (
                <p className="text-xs text-amber-700 dark:text-amber-300">O responsável não é mais um Administrador ativo desta loja: escolha outro.</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Nenhum responsável definido. Escolha um Administrador ativo ou convide um como responsável na aba Convites.
            </p>
          )}
        </InfoCard>

        <InfoCard title="Operação e pagamentos" id="overview-operation">
          <InfoList>
          <InfoRow label="Agora" value={<StatusBadge tone={store.is_open ? 'success' : 'neutral'} dot>{store.is_open ? 'Aberta' : 'Fechada'}</StatusBadge>} />
          <InfoRow label="Entrega" value={store.delivery_enabled ? 'Ligada' : 'Desligada'} />
          <InfoRow label="Retirada" value={store.takeout_enabled ? 'Ligada' : 'Desligada'} />
          <InfoRow
            label="Pagamento online"
            value={(
              <span className="inline-flex flex-col items-end gap-1">
                {store.payments.configured
                  ? <StatusBadge tone="success">Credencial própria configurada</StatusBadge>
                  : store.payments.using_platform_credentials
                    ? <StatusBadge tone="info">Usa a credencial da plataforma</StatusBadge>
                    : <StatusBadge tone="neutral">Não configurado</StatusBadge>}
                {!store.payments.online_payments_in_plan && <span className="text-xs text-amber-700 dark:text-amber-300">Fora do plano atual</span>}
              </span>
            )}
          />
          <InfoRow label="Chave pública (MP)" value={store.payments.mp_public_key ? shortKey(store.payments.mp_public_key) : null} mono />
          <InfoRow
            label="Loja padrão"
            value={store.is_default_store
              ? <span className="inline-flex items-center gap-1"><Globe size={14} aria-hidden="true" /> Sim</span>
              : 'Não'}
          />
          </InfoList>
          {store.is_default_store && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              As rotas antigas sem o endereço da loja (app mobile e integrações da versão de loja única) atendem esta loja.
            </p>
          )}
          {store.subscription && (
            <p className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
              <Receipt size={12} aria-hidden="true" /> Assinatura desde {formatDate(store.subscription.created_at)}
            </p>
          )}
        </InfoCard>
      </div>
    </div>
  );
}

function InfoCard({ title, id, action, children }: { title: string; id: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className={cx(CARD_CLASS, 'p-5 sm:p-6 space-y-3')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 id={id} className="text-base font-bold text-gray-800 dark:text-white">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function InfoList({ children }: { children: ReactNode }) {
  return <dl className="space-y-2.5 text-sm">{children}</dl>;
}

function InfoRow({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
      <dt className="text-gray-500 dark:text-gray-400 shrink-0">{label}</dt>
      <dd className={cx('ml-auto text-right font-semibold text-gray-800 dark:text-gray-100 min-w-0 max-w-full wrap-break-word', mono && 'font-mono')}>
        {value === null || value === undefined || value === '' ? <span className="font-normal text-gray-400">—</span> : value}
      </dd>
    </div>
  );
}
