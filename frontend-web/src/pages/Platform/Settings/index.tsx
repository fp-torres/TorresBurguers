import { useState } from 'react';
import { Icon } from '@iconify/react';
import { AlertTriangle, X } from 'lucide-react';
import { CARD_CLASS, ErrorState, PageHeader } from '../../../components/ui';
import PageLoader from '../../../components/PageLoader';
import { useResource } from '../../../hooks/useResource';
import { platformLookups } from '../../../services/platform/insightsLookups';
import { platformSettingsService, type PlatformSettings as PlatformSettingsData } from '../../../services/platform/settingsService';
import MailCard from './MailCard';
import MaintenanceCard from './MaintenanceCard';
import SettingsForm from './SettingsForm';

/**
 * Superpainel › Configurações (/platform/settings): GET/PATCH /platform/settings — loja padrão das rotas
 * antigas (app mobile), tolerância da inadimplência, duração das sessões de suporte e autoatendimento de
 * lojas com o plano —, o e-mail transacional (driver ativo e e-mail de teste: POST
 * /platform/settings/test-email) e a manutenção de imagens (POST /platform/maintenance/optimize-images).
 */
export default function PlatformSettings() {
  const resource = useResource((signal) => platformSettingsService.get(signal), {
    errorMessage: 'Não foi possível carregar as configurações da plataforma.',
  });
  const plans = useResource((signal) => platformLookups.listPlans(signal), {
    errorMessage: 'Não foi possível carregar os planos.',
  });
  const [formKey, setFormKey] = useState(0);
  const [warnings, setWarnings] = useState<string[]>([]);
  const settings = resource.data;

  function handleSaved(next: PlatformSettingsData, nextWarnings: string[]) {
    resource.setData(next);
    setWarnings(nextWarnings);
    // O formulário recomeça dos valores salvos
    setFormKey((current) => current + 1);
  }

  return (
    <div className="space-y-6 pb-20">
      <PageHeader
        title="Configurações da plataforma"
        subtitle="Loja padrão, inadimplência, suporte, cadastro de lojas, e-mail e manutenção"
        icon={<Icon icon="solar:tuning-2-bold-duotone" width={26} />}
      />

      {warnings.length > 0 && (
        <div role="alert" className="flex items-start gap-3 px-4 py-3 rounded-2xl text-sm bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
          <AlertTriangle size={18} className="shrink-0 mt-0.5" aria-hidden="true" />
          <ul className="flex-1 space-y-1">
            {warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
          <button
            type="button"
            onClick={() => setWarnings([])}
            aria-label="Fechar avisos"
            className="shrink-0 p-1 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-900/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}

      {settings ? (
        <>
          {resource.error && (
            <div role="alert" className="flex flex-wrap items-center gap-3 px-4 py-3 rounded-2xl text-sm bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
              <AlertTriangle size={18} className="shrink-0" aria-hidden="true" />
              <span className="flex-1 min-w-48">{resource.error} Os valores abaixo podem estar desatualizados.</span>
              <button type="button" onClick={() => void resource.reload()} className="font-bold hover:underline">Tentar novamente</button>
            </div>
          )}
          <SettingsForm
            key={formKey}
            settings={settings}
            plans={plans.data}
            plansLoading={plans.loading}
            plansError={plans.error}
            onRetryPlans={() => void plans.reload()}
            onSaved={handleSaved}
          />
        </>
      ) : resource.error ? (
        <div className={CARD_CLASS}>
          <ErrorState message={resource.error} onRetry={() => void resource.reload()} retrying={resource.loading} />
        </div>
      ) : (
        <PageLoader />
      )}

      <MailCard mail={settings?.mail ?? null} loading={resource.loading} />

      <MaintenanceCard />
    </div>
  );
}
