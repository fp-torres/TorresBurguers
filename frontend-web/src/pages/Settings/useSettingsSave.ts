import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { getApiErrorMessage } from '../../services/api';
import { storeSettingsService, type StoreSettings, type StoreSettingsUpdate } from '../../services/storeSettingsService';
import { planRestrictionMessage } from '../../services/storeSubscriptionService';
import { toastPlanLimit } from '../../layouts/DefaultLayout/planLimit';
import type { SectionId } from './types';

/** Salva uma seção (PATCH /store/settings só com o que mudou) com aviso de sucesso ou do motivo da recusa. */
export function useSettingsSave(onSaved: (next: StoreSettings, changed: readonly string[]) => void) {
  const [saving, setSaving] = useState(false);

  const save = useCallback(async (changes: StoreSettingsUpdate, successMessage: string): Promise<boolean> => {
    const fields = Object.keys(changes);
    if (fields.length === 0) {
      toast('Nenhuma alteração para salvar.', { icon: 'ℹ️', id: 'settings-nothing' });
      return false;
    }
    setSaving(true);
    try {
      const next = await storeSettingsService.update(changes);
      onSaved(next, fields);
      toast.success(successMessage);
      return true;
    } catch (error) {
      // 403 do plano (ex.: cor sem o recurso de identidade visual) leva à Assinatura
      const planMessage = planRestrictionMessage(error);
      if (planMessage) toastPlanLimit(planMessage);
      else toast.error(getApiErrorMessage(error, 'Não foi possível salvar as configurações.'), { duration: 6000 });
      return false;
    } finally {
      setSaving(false);
    }
  }, [onSaved]);

  return { saving, save };
}

/** Informa a página quando a seção passa a ter (ou deixa de ter) alterações não salvas. */
export function useReportDirty(id: SectionId, dirty: boolean, onDirtyChange: (id: SectionId, dirty: boolean) => void) {
  useEffect(() => {
    onDirtyChange(id, dirty);
  }, [id, dirty, onDirtyChange]);

  useEffect(() => () => onDirtyChange(id, false), [id, onDirtyChange]);
}
