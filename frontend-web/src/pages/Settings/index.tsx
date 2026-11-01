import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Icon } from '@iconify/react';
import {
  AlertTriangle, Bike, Building2, CalendarClock, Clock3, CreditCard, ExternalLink, Globe2, Headset, MapPin, Palette, ShieldAlert,
} from 'lucide-react';
import { CARD_CLASS, CopyField, ErrorState, PageHeader, StatusBadge, Tabs, buttonClass, cx, type TabItem } from '../../components/ui';
import PageLoader from '../../components/PageLoader';
import { useAuth } from '../../contexts/AuthContext';
import { useStoreStatus } from '../../contexts/StoreStatusContext';
import { BRAND } from '../../config/brand';
import { storeSettingsService, type StoreSettings } from '../../services/storeSettingsService';
import { isBillingAvailability, isBlockedAvailability } from '../../services/storeAccess';
import { SUPPORT_READ_ONLY_REASON, usePanelStore } from '../../layouts/DefaultLayout/panelStore';
import { useResource } from '../../hooks/useResource';
import { storePath } from '../../utils/lastStore';
import { STORE_ACCOUNT_STATUS, statusMeta } from '../../utils/saasStatus';
import { SettingsLockContext } from './lock';
import BusinessSection from './sections/BusinessSection';
import AddressSection from './sections/AddressSection';
import OperationSection from './sections/OperationSection';
import DeliverySection from './sections/DeliverySection';
import HoursSection from './sections/HoursSection';
import TimeZoneSection from './sections/TimeZoneSection';
import BrandingSection from './sections/BrandingSection';
import PaymentsSection from './sections/PaymentsSection';
import { SECTION_FIELDS, isSectionId, sectionKey, type SectionId, type SectionProps } from './types';

const TABS: { id: SectionId; label: string; icon: ReactNode }[] = [
  { id: 'dados', label: 'Dados', icon: <Building2 size={16} /> },
  { id: 'endereco', label: 'Endereço', icon: <MapPin size={16} /> },
  { id: 'operacao', label: 'Operação', icon: <Clock3 size={16} /> },
  // Rótulos curtos: as 8 abas cabem numa linha em telas de notebook (o título de cada seção é o completo)
  { id: 'entrega', label: 'Entrega', icon: <Bike size={16} /> },
  { id: 'horarios', label: 'Horários', icon: <CalendarClock size={16} /> },
  { id: 'fuso', label: 'Fuso', icon: <Globe2 size={16} /> },
  { id: 'identidade', label: 'Identidade', icon: <Palette size={16} /> },
  { id: 'pagamentos', label: 'Pagamentos', icon: <CreditCard size={16} /> },
];

/** Campos que, ao mudar, atualizam a sessão (cabeçalho do painel) e o status da loja. */
const SESSION_FIELDS = ['name', 'logo', 'primary_color'];
const STATUS_FIELDS = ['opening_message', 'closing_message'];

/**
 * Painel da loja › Configurações (/settings; só Administrador): GET /store/settings e PATCH por seção,
 * logo (POST/DELETE /store/logo) e credenciais do Mercado Pago (PUT/DELETE /store/settings/payments).
 * Cada seção salva só os próprios campos; o rascunho das outras seções continua ao trocar de aba.
 */
export default function StoreSettings() {
  const { user, refreshUser } = useAuth();
  const { refresh: refreshStatus } = useStoreStatus();
  const panel = usePanelStore();
  const readOnly = !!user?.support_session;
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('secao');
  const section: SectionId = isSectionId(requested) ? requested : 'dados';
  const [dirtySections, setDirtySections] = useState<Partial<Record<SectionId, boolean>>>({});

  const resource = useResource((signal) => storeSettingsService.get(signal), {
    errorMessage: 'Não foi possível carregar as configurações da loja.',
  });
  const settings = resource.data;
  const setSettings = resource.setData;
  const applyPanelSettings = panel.applySettings;

  const handleDirtyChange = useCallback((id: SectionId, dirty: boolean) => {
    setDirtySections((current) => (!!current[id] === dirty ? current : { ...current, [id]: dirty }));
  }, []);

  const handleSaved = useCallback((next: StoreSettings, changed: readonly string[]) => {
    setSettings(next);
    applyPanelSettings(next);
    if (changed.some((field) => SESSION_FIELDS.includes(field))) void refreshUser();
    if (changed.some((field) => STATUS_FIELDS.includes(field))) void refreshStatus();
  }, [setSettings, applyPanelSettings, refreshUser, refreshStatus]);

  // Alterações não salvas: o navegador pergunta antes de fechar ou recarregar a página
  const anyDirty = Object.values(dirtySections).some(Boolean);
  useEffect(() => {
    if (!anyDirty) return;
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [anyDirty]);

  function changeSection(next: SectionId) {
    setSearchParams((params) => {
      const updated = new URLSearchParams(params);
      updated.set('secao', next);
      return updated;
    }, { replace: true });
  }

  const header = (
    <PageHeader
      title="Configurações"
      subtitle="Dados do estabelecimento, operação, entrega e pagamentos"
      icon={<Icon icon="solar:settings-bold-duotone" width={26} />}
      actions={settings?.slug ? (
        <Link to={storePath(settings.slug)} className={buttonClass('secondary', 'md')}>
          <ExternalLink size={16} aria-hidden="true" /> Ver vitrine
        </Link>
      ) : undefined}
    />
  );

  if (!settings) {
    return (
      <div className="space-y-6 pb-20">
        {header}
        {resource.error ? (
          <div className={CARD_CLASS}>
            <ErrorState message={resource.error} onRetry={() => void resource.reload()} retrying={resource.loading} />
          </div>
        ) : (
          <PageLoader />
        )}
      </div>
    );
  }

  const access = settings.access;
  const accountStatus = statusMeta(STORE_ACCOUNT_STATUS, settings.account_status);
  const publicUrl = `${window.location.origin}${storePath(settings.slug)}`;
  // A API recusa (403) qualquer alteração em sessão de suporte ou com a loja sem permissão de alterar
  // (suspensa, assinatura suspensa/cancelada): as seções ficam só para consulta, com o motivo no topo
  const lockMessage = readOnly
    ? SUPPORT_READ_ONLY_REASON
    : access && !access.canManage
      ? 'Alterações bloqueadas pela situação da loja (veja o aviso no topo).'
      : null;

  const sectionProps: Omit<SectionProps, 'settings'> = { readOnly: lockMessage !== null, onSaved: handleSaved, onDirtyChange: handleDirtyChange };

  const tabs: TabItem<SectionId>[] = TABS.map((tab) => ({
    value: tab.id,
    label: tab.label,
    icon: tab.icon,
    // Texto só para leitores de tela SEM position:absolute (o sr-only escaparia da área rolável das abas e
    // faria a página rolar na horizontal no celular)
    badge: dirtySections[tab.id]
      ? (
        <>
          <span aria-hidden="true" className="text-orange-600 dark:text-orange-400">●</span>
          <span className="inline-block w-px h-px -m-px overflow-hidden whitespace-nowrap [clip-path:inset(50%)]">alterações não salvas</span>
        </>
      )
      : undefined,
  }));

  return (
    <div className="space-y-6 pb-20">
      {header}

      {resource.error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 px-4 py-3 rounded-2xl text-sm bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
          <AlertTriangle size={18} className="shrink-0" aria-hidden="true" />
          <span className="flex-1 min-w-48">{resource.error} Os dados abaixo podem estar desatualizados.</span>
          <button type="button" onClick={() => void resource.reload()} className="font-bold hover:underline">Tentar novamente</button>
        </div>
      )}

      {/* Situação da loja (access.message): o que está impedindo vender ou alterar */}
      {access?.message && (
        <div
          role={isBlockedAvailability(access.availability) ? 'alert' : 'status'}
          className={cx(
            'flex flex-wrap items-start gap-3 px-4 py-3 rounded-2xl text-sm border',
            isBlockedAvailability(access.availability)
              ? 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 border-red-200 dark:border-red-800'
              : 'bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800',
          )}
        >
          <ShieldAlert size={18} className="shrink-0 mt-0.5" aria-hidden="true" />
          <p className="flex-1 min-w-48">
            <span className="font-bold">Situação da loja: </span>{access.message}
            {!access.canManage && ' As alterações abaixo ficam bloqueadas até a situação ser resolvida.'}
          </p>
          {/* Cobrança se resolve na Assinatura; suspensão pela plataforma, com o suporte */}
          {isBillingAvailability(access.availability) ? (
            <Link to="/subscription" className="font-bold hover:underline whitespace-nowrap">Ver assinatura</Link>
          ) : (
            <a href={`mailto:${BRAND.supportEmail}`} className="font-bold hover:underline whitespace-nowrap">Falar com o suporte</a>
          )}
        </div>
      )}

      {readOnly && (
        <p className="flex items-center gap-2 px-4 py-3 rounded-2xl text-sm bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200 border border-blue-200 dark:border-blue-800">
          <Headset size={18} className="shrink-0" aria-hidden="true" /> Sessão de suporte: as configurações estão disponíveis só para consulta.
        </p>
      )}

      <div className={cx(CARD_CLASS, 'p-5 sm:p-6 grid grid-cols-1 lg:grid-cols-3 gap-5 items-start')}>
        <div className="space-y-2">
          <p className="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">Situação cadastral</p>
          <div className="flex flex-wrap gap-2">
            <StatusBadge tone={accountStatus.tone} dot>{accountStatus.label}</StatusBadge>
            {settings.is_default_store && <StatusBadge tone="info">Loja padrão da plataforma</StatusBadge>}
          </div>
          {settings.status_reason && <p className="text-xs text-gray-500 dark:text-gray-400">Motivo: {settings.status_reason}</p>}
        </div>
        <CopyField
          className="lg:col-span-2"
          label="Endereço da vitrine"
          value={publicUrl}
          oneTime={false}
        />
      </div>

      <SettingsLockContext.Provider value={lockMessage}>
      <Tabs tabs={tabs} value={section} onChange={changeSection} label="Seções das configurações" panelClassName="pt-6">
        {/* Todas as seções ficam montadas (o rascunho de cada uma sobrevive à troca de aba); só a escolhida aparece */}
        <div hidden={section !== 'dados'}>
          <BusinessSection key={sectionKey(settings, SECTION_FIELDS.dados)} settings={settings} {...sectionProps} />
        </div>
        <div hidden={section !== 'endereco'}>
          <AddressSection key={sectionKey(settings, SECTION_FIELDS.endereco)} settings={settings} {...sectionProps} />
        </div>
        <div hidden={section !== 'operacao'}>
          <OperationSection key={sectionKey(settings, SECTION_FIELDS.operacao)} settings={settings} {...sectionProps} />
        </div>
        <div hidden={section !== 'entrega'}>
          <DeliverySection key={sectionKey(settings, SECTION_FIELDS.entrega)} settings={settings} {...sectionProps} />
        </div>
        <div hidden={section !== 'horarios'}>
          <HoursSection key={sectionKey(settings, SECTION_FIELDS.horarios)} settings={settings} {...sectionProps} />
        </div>
        <div hidden={section !== 'fuso'}>
          <TimeZoneSection key={sectionKey(settings, SECTION_FIELDS.fuso)} settings={settings} {...sectionProps} />
        </div>
        <div hidden={section !== 'identidade'}>
          <BrandingSection key={sectionKey(settings, SECTION_FIELDS.identidade)} settings={settings} {...sectionProps} />
        </div>
        <div hidden={section !== 'pagamentos'}>
          <PaymentsSection key={sectionKey(settings, SECTION_FIELDS.pagamentos)} settings={settings} {...sectionProps} />
        </div>
      </Tabs>
      </SettingsLockContext.Provider>
    </div>
  );
}
