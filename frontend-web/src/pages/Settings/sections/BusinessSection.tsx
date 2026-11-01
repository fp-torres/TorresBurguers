import { useState } from 'react';
import { Building2 } from 'lucide-react';
import { FormField, fieldControlClass } from '../../../components/ui';
import { maskPhone } from '../../../utils/masks';
import type { StoreSettings } from '../../../services/storeSettingsService';
import SettingsSection from '../SettingsSection';
import { changedFields, type SectionProps } from '../types';
import { useReportDirty, useSettingsSave } from '../useSettingsSave';
import { FIELD_LIMITS, emailError, optionalText, tooLong } from '../validation';
import { documentError, maskDocument, normalizeDocument, phoneDigits, phoneError } from '../../../utils/validation';

interface Draft {
  name: string;
  legal_name: string;
  document: string;
  email: string;
  phone: string;
  description: string;
}

function draftFrom(settings: StoreSettings): Draft {
  return {
    name: settings.name,
    legal_name: settings.legal_name ?? '',
    document: maskDocument(settings.document ?? ''),
    email: settings.email ?? '',
    phone: maskPhone(settings.phone ?? ''),
    description: settings.description ?? '',
  };
}

function validate(draft: Draft): Partial<Record<keyof Draft, string>> {
  const errors: Partial<Record<keyof Draft, string>> = {};
  const name = draft.name.trim();
  if (!name) errors.name = 'Informe o nome da loja.';
  else if (name.length > FIELD_LIMITS.name) errors.name = tooLong('O nome da loja', FIELD_LIMITS.name);
  if (draft.legal_name.trim().length > FIELD_LIMITS.legal_name) errors.legal_name = tooLong('A razão social', FIELD_LIMITS.legal_name);
  const document = documentError(draft.document);
  if (document) errors.document = document;
  const email = emailError(draft.email);
  if (email) errors.email = email;
  const phone = phoneError(draft.phone);
  if (phone) errors.phone = phone;
  if (draft.description.trim().length > FIELD_LIMITS.description) errors.description = tooLong('A descrição', FIELD_LIMITS.description);
  return errors;
}

/** Dados comerciais: nome, razão social, CPF/CNPJ, contato e descrição da vitrine. */
export default function BusinessSection({ settings, readOnly, onSaved, onDirtyChange }: SectionProps) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(settings));
  const [showErrors, setShowErrors] = useState(false);
  const { saving, save } = useSettingsSave(onSaved);

  const changes = changedFields(settings, {
    name: draft.name.trim(),
    legal_name: optionalText(draft.legal_name),
    document: normalizeDocument(draft.document) || null,
    email: optionalText(draft.email)?.toLowerCase() ?? null,
    phone: phoneDigits(draft.phone) || null,
    description: optionalText(draft.description),
  });
  const dirty = Object.keys(changes).length > 0;
  useReportDirty('dados', dirty, onDirtyChange);

  const errors = showErrors ? validate(draft) : {};

  function update<K extends keyof Draft>(field: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function handleSubmit() {
    if (Object.keys(validate(draft)).length > 0) {
      setShowErrors(true);
      return;
    }
    await save(changes, 'Dados do estabelecimento salvos.');
  }

  const descriptionLength = draft.description.trim().length;

  return (
    <SettingsSection
      title="Dados do estabelecimento"
      description="Nome exibido na vitrine e no painel, dados fiscais e contato."
      icon={<Building2 size={20} />}
      dirty={dirty}
      saving={saving}
      readOnly={readOnly}
      onSubmit={handleSubmit}
      onDiscard={() => {
        setDraft(draftFrom(settings));
        setShowErrors(false);
      }}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <FormField label="Nome da loja" required error={errors.name} hint="Aparece na vitrine, no diretório de lojas e no painel.">
          {(field) => (
            <input
              {...field}
              value={draft.name}
              onChange={(event) => update('name', event.target.value)}
              maxLength={FIELD_LIMITS.name}
              autoComplete="organization"
              disabled={readOnly}
              className={fieldControlClass(!!errors.name)}
            />
          )}
        </FormField>
        <FormField label="Razão social" error={errors.legal_name}>
          {(field) => (
            <input
              {...field}
              value={draft.legal_name}
              onChange={(event) => update('legal_name', event.target.value)}
              maxLength={FIELD_LIMITS.legal_name}
              placeholder="Opcional"
              disabled={readOnly}
              className={fieldControlClass(!!errors.legal_name)}
            />
          )}
        </FormField>
        <FormField label="CPF ou CNPJ" error={errors.document} hint="Aceita o CNPJ alfanumérico. Gravado sem pontuação.">
          {(field) => (
            <input
              {...field}
              value={draft.document}
              onChange={(event) => update('document', maskDocument(event.target.value))}
              placeholder="00.000.000/0000-00"
              autoComplete="off"
              spellCheck={false}
              disabled={readOnly}
              className={fieldControlClass(!!errors.document, 'font-mono')}
            />
          )}
        </FormField>
        <FormField label="Telefone" error={errors.phone} hint="Com DDD. Exibido na vitrine.">
          {(field) => (
            <input
              {...field}
              type="tel"
              inputMode="tel"
              value={draft.phone}
              onChange={(event) => update('phone', maskPhone(event.target.value))}
              placeholder="(21) 99999-9999"
              autoComplete="tel"
              disabled={readOnly}
              className={fieldControlClass(!!errors.phone)}
            />
          )}
        </FormField>
        <FormField label="E-mail de contato" error={errors.email} className="md:col-span-2">
          {(field) => (
            <input
              {...field}
              type="email"
              value={draft.email}
              onChange={(event) => update('email', event.target.value)}
              maxLength={FIELD_LIMITS.email}
              placeholder="contato@sualoja.com.br"
              autoComplete="email"
              disabled={readOnly}
              className={fieldControlClass(!!errors.email)}
            />
          )}
        </FormField>
        <FormField
          label="Descrição"
          error={errors.description}
          className="md:col-span-2"
          hint={`${descriptionLength}/${FIELD_LIMITS.description} caracteres. Aparece no diretório de lojas e na vitrine.`}
        >
          {(field) => (
            <textarea
              {...field}
              rows={3}
              value={draft.description}
              onChange={(event) => update('description', event.target.value)}
              maxLength={FIELD_LIMITS.description}
              placeholder="Ex.: Hambúrgueres artesanais desde 2010."
              disabled={readOnly}
              className={fieldControlClass(!!errors.description, 'resize-y')}
            />
          )}
        </FormField>
      </div>
    </SettingsSection>
  );
}
