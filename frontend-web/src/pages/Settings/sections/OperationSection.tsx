import { useState } from 'react';
import { Clock3 } from 'lucide-react';
import { FormField, fieldControlClass } from '../../../components/ui';
import StoreToggle from '../../../components/StoreToggle';
import { useStoreStatus } from '../../../contexts/StoreStatusContext';
import type { StoreSettings } from '../../../services/storeSettingsService';
import SettingsSection from '../SettingsSection';
import { changedFields, type SectionProps } from '../types';
import { useReportDirty, useSettingsSave } from '../useSettingsSave';
import { FIELD_LIMITS, optionalText, tooLong } from '../validation';

interface Draft {
  opening: string;
  closing: string;
}

function draftFrom(settings: StoreSettings): Draft {
  return { opening: settings.opening_message ?? '', closing: settings.closing_message ?? '' };
}

/** Operação: abrir/fechar agora (StoreToggle) e as mensagens exibidas na vitrine em cada situação. */
export default function OperationSection({ settings, readOnly, onSaved, onDirtyChange }: SectionProps) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(settings));
  const { saving, save } = useSettingsSave(onSaved);
  const { status } = useStoreStatus();

  const changes = changedFields(settings, {
    opening_message: optionalText(draft.opening),
    closing_message: optionalText(draft.closing),
  });
  const dirty = Object.keys(changes).length > 0;
  useReportDirty('operacao', dirty, onDirtyChange);

  const openingLength = draft.opening.trim().length;
  const closingLength = draft.closing.trim().length;
  const openingError = openingLength > FIELD_LIMITS.message ? tooLong('A mensagem de loja aberta', FIELD_LIMITS.message) : undefined;
  const closingError = closingLength > FIELD_LIMITS.message ? tooLong('A mensagem de loja fechada', FIELD_LIMITS.message) : undefined;

  async function handleSubmit() {
    if (openingError || closingError) return;
    await save(changes, 'Mensagens da vitrine salvas.');
  }

  const isOpen = status?.is_open ?? settings.is_open;

  return (
    <SettingsSection
      title="Operação"
      description="Abra ou feche a loja na hora e defina o que os clientes leem na vitrine em cada situação."
      icon={<Clock3 size={20} />}
      dirty={dirty}
      saving={saving}
      readOnly={readOnly}
      onSubmit={handleSubmit}
      onDiscard={() => setDraft(draftFrom(settings))}
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-xl bg-gray-50 dark:bg-slate-900/40 border border-gray-100 dark:border-slate-700">
        <div className="min-w-0">
          <p className="text-sm font-bold text-gray-800 dark:text-gray-100">
            A loja está {isOpen ? 'aberta' : 'fechada'} agora
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Abrir e fechar vale na hora para a vitrine e o app (também pelo Dashboard e pelo quadro de Pedidos).
            Os horários de funcionamento são informativos.
          </p>
        </div>
        <StoreToggle variant="compact" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <FormField
          label="Mensagem com a loja aberta"
          error={openingError}
          hint={`${openingLength}/${FIELD_LIMITS.message} caracteres. Opcional.`}
        >
          {(field) => (
            <textarea
              {...field}
              rows={3}
              value={draft.opening}
              onChange={(event) => setDraft((current) => ({ ...current, opening: event.target.value }))}
              maxLength={FIELD_LIMITS.message}
              placeholder="Ex.: Bem-vindo! Peça já o seu."
              disabled={readOnly}
              className={fieldControlClass(!!openingError, 'resize-y')}
            />
          )}
        </FormField>
        <FormField
          label="Mensagem com a loja fechada"
          error={closingError}
          hint={`${closingLength}/${FIELD_LIMITS.message} caracteres. Ex.: quando a loja volta a abrir.`}
        >
          {(field) => (
            <textarea
              {...field}
              rows={3}
              value={draft.closing}
              onChange={(event) => setDraft((current) => ({ ...current, closing: event.target.value }))}
              maxLength={FIELD_LIMITS.message}
              placeholder="Ex.: Voltamos amanhã às 18h."
              disabled={readOnly}
              className={fieldControlClass(!!closingError, 'resize-y')}
            />
          )}
        </FormField>
      </div>
    </SettingsSection>
  );
}
