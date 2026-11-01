import { useCallback, useMemo, type ReactNode } from 'react';
import { usePolling } from '../../hooks/usePolling';
import { storeSettingsService, type StoreSettings } from '../../services/storeSettingsService';
import { storeSubscriptionService, type StoreSubscriptionOverview } from '../../services/storeSubscriptionService';
import type { StoreAccountStatus } from '../../types/saas';
import { PanelStoreContext, panelLockReason, type PanelStoreData } from './panelStore';
import { useResource } from '../../hooks/useResource';

// A situação muda pouco (cobrança, suspensão): confere a cada 2 minutos e ao voltar para a aba
const REFRESH_INTERVAL_MS = 120_000;

interface PanelStoreProviderProps {
  /** Consulta a situação da loja (só o Administrador tem acesso a /store/settings e /store/subscription). */
  enabled: boolean;
  /** Sessão de suporte (somente leitura). */
  readOnly: boolean;
  /** Situação cadastral da loja na sessão (usada enquanto a situação detalhada não chega ou para os demais perfis). */
  accountStatus?: StoreAccountStatus | null;
  children: ReactNode;
}

/** Provê a situação da loja (access), os recursos e a assinatura para o layout e as telas do painel. */
export default function PanelStoreProvider({ enabled, readOnly, accountStatus, children }: PanelStoreProviderProps) {
  const settings = useResource((signal) => storeSettingsService.get(signal), {
    enabled,
    errorMessage: 'Não foi possível conferir a situação da loja.',
  });
  const subscription = useResource((signal) => storeSubscriptionService.get(signal), {
    enabled,
    errorMessage: 'Não foi possível carregar a assinatura.',
  });

  const reloadSettings = settings.reload;
  const reloadSubscription = subscription.reload;
  const setSettingsData = settings.setData;
  const setSubscriptionData = subscription.setData;

  const refresh = useCallback(async () => {
    await Promise.all([reloadSettings({ silent: true }), reloadSubscription({ silent: true })]);
  }, [reloadSettings, reloadSubscription]);

  const applySettings = useCallback((next: StoreSettings) => setSettingsData(next), [setSettingsData]);
  const applySubscription = useCallback((next: StoreSubscriptionOverview) => setSubscriptionData(next), [setSubscriptionData]);

  // Pausa com a aba oculta; ao voltar, confere na hora
  usePolling(refresh, REFRESH_INTERVAL_MS, { enabled });

  const settingsData = settings.data;
  const subscriptionData = subscription.data;

  const value = useMemo<PanelStoreData>(() => {
    const access = settingsData?.access ?? subscriptionData?.access ?? null;
    const lockReason = panelLockReason(readOnly, access, accountStatus);
    return {
      enabled,
      access,
      features: settingsData?.features ?? subscriptionData?.features ?? null,
      subscription: subscriptionData,
      timeZone: settingsData?.time_zone ?? null,
      readOnly,
      locked: lockReason !== null,
      lockReason,
      refresh,
      applySettings,
      applySubscription,
    };
  }, [enabled, settingsData, subscriptionData, readOnly, accountStatus, refresh, applySettings, applySubscription]);

  return <PanelStoreContext.Provider value={value}>{children}</PanelStoreContext.Provider>;
}
