import { useRef, useState } from 'react';
import { Loader2, MapPin } from 'lucide-react';
import toast from 'react-hot-toast';
import { getApiErrorMessage } from '../../../services/api';
import { FormField, fieldControlClass } from '../../../components/ui';
import { maskCEP } from '../../../utils/masks';
import { storeSettingsService, type StoreSettings } from '../../../services/storeSettingsService';
import SettingsSection from '../SettingsSection';
import { changedFields, type SectionProps } from '../types';
import { useReportDirty, useSettingsSave } from '../useSettingsSave';
import { FIELD_LIMITS, optionalText, tooLong } from '../validation';
import { UFS, zipDigits, zipError } from '../../../utils/validation';

interface Draft {
  zip: string;
  street: string;
  number: string;
  complement: string;
  neighborhood: string;
  city: string;
  state: string;
}

function draftFrom(settings: StoreSettings): Draft {
  return {
    zip: maskCEP(settings.address_zip_code ?? ''),
    street: settings.address_street ?? '',
    number: settings.address_number ?? '',
    complement: settings.address_complement ?? '',
    neighborhood: settings.address_neighborhood ?? '',
    city: settings.address_city ?? '',
    state: settings.address_state ?? '',
  };
}

function validate(draft: Draft): Partial<Record<keyof Draft, string>> {
  const errors: Partial<Record<keyof Draft, string>> = {};
  const zip = zipError(draft.zip);
  if (zip) errors.zip = zip;
  if (draft.street.trim().length > FIELD_LIMITS.address_street) errors.street = tooLong('A rua', FIELD_LIMITS.address_street);
  if (draft.number.trim().length > FIELD_LIMITS.address_number) errors.number = tooLong('O número', FIELD_LIMITS.address_number);
  if (draft.complement.trim().length > FIELD_LIMITS.address_complement) errors.complement = tooLong('O complemento', FIELD_LIMITS.address_complement);
  if (draft.neighborhood.trim().length > FIELD_LIMITS.address_neighborhood) errors.neighborhood = tooLong('O bairro', FIELD_LIMITS.address_neighborhood);
  if (draft.city.trim().length > FIELD_LIMITS.address_city) errors.city = tooLong('A cidade', FIELD_LIMITS.address_city);
  if (draft.state && !(UFS as readonly string[]).includes(draft.state)) errors.state = 'UF inválida. Use a sigla do estado com 2 letras (ex.: RJ).';
  return errors;
}

/** Endereço do estabelecimento (vitrine, retirada no balcão e referência das entregas). */
export default function AddressSection({ settings, readOnly, onSaved, onDirtyChange }: SectionProps) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(settings));
  const [showErrors, setShowErrors] = useState(false);
  const [searchingCep, setSearchingCep] = useState(false);
  const { saving, save } = useSettingsSave(onSaved);
  const numberRef = useRef<HTMLInputElement>(null);
  // Só a resposta do último CEP digitado é aproveitada
  const lastLookup = useRef('');

  const changes = changedFields(settings, {
    address_zip_code: zipDigits(draft.zip) || null,
    address_street: optionalText(draft.street),
    address_number: optionalText(draft.number),
    address_complement: optionalText(draft.complement),
    address_neighborhood: optionalText(draft.neighborhood),
    address_city: optionalText(draft.city),
    address_state: optionalText(draft.state)?.toUpperCase() ?? null,
  });
  const dirty = Object.keys(changes).length > 0;
  useReportDirty('endereco', dirty, onDirtyChange);

  const errors = showErrors ? validate(draft) : {};

  function update<K extends keyof Draft>(field: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function searchCep(digits: string) {
    lastLookup.current = digits;
    setSearchingCep(true);
    try {
      const found = await storeSettingsService.lookupCep(digits);
      if (lastLookup.current !== digits) return;
      // Só preenche o que o CEP informa (CEPs gerais de cidade vêm sem rua e bairro)
      setDraft((current) => ({
        ...current,
        street: found.street || current.street,
        neighborhood: found.neighborhood || current.neighborhood,
        city: found.city || current.city,
        state: (UFS as readonly string[]).includes(found.state) ? found.state : current.state,
      }));
      // O número é o próximo campo a preencher
      window.setTimeout(() => numberRef.current?.focus(), 50);
    } catch (error) {
      if (lastLookup.current !== digits) return;
      toast.error(getApiErrorMessage(error, 'CEP não encontrado. Preencha o endereço manualmente.'), { duration: 5000 });
    } finally {
      if (lastLookup.current === digits) setSearchingCep(false);
    }
  }

  function handleZipChange(value: string) {
    const masked = maskCEP(value);
    update('zip', masked);
    const digits = zipDigits(masked);
    if (digits.length === 8 && digits !== zipDigits(draft.zip)) void searchCep(digits);
    else if (digits.length < 8) {
      lastLookup.current = '';
      setSearchingCep(false);
    }
  }

  async function handleSubmit() {
    if (Object.keys(validate(draft)).length > 0) {
      setShowErrors(true);
      return;
    }
    await save(changes, 'Endereço salvo.');
  }

  return (
    <SettingsSection
      title="Endereço"
      description="Exibido na vitrine e usado na retirada no balcão. Digite o CEP para preencher o resto."
      icon={<MapPin size={20} />}
      dirty={dirty}
      saving={saving}
      readOnly={readOnly}
      onSubmit={handleSubmit}
      onDiscard={() => {
        lastLookup.current = '';
        setSearchingCep(false);
        setDraft(draftFrom(settings));
        setShowErrors(false);
      }}
    >
      <div className="grid grid-cols-1 sm:grid-cols-6 gap-5">
        <FormField label="CEP" error={errors.zip} className="sm:col-span-2" hint={searchingCep ? 'Buscando o endereço...' : undefined}>
          {(field) => (
            <div className="relative">
              <input
                {...field}
                inputMode="numeric"
                value={draft.zip}
                onChange={(event) => handleZipChange(event.target.value)}
                placeholder="00000-000"
                autoComplete="postal-code"
                disabled={readOnly}
                aria-busy={searchingCep || undefined}
                className={fieldControlClass(!!errors.zip, 'pr-10')}
              />
              {searchingCep && (
                <Loader2 size={18} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-orange-600" aria-hidden="true" />
              )}
            </div>
          )}
        </FormField>
        <FormField label="Rua" error={errors.street} className="sm:col-span-4">
          {(field) => (
            <input
              {...field}
              value={draft.street}
              onChange={(event) => update('street', event.target.value)}
              maxLength={FIELD_LIMITS.address_street}
              autoComplete="address-line1"
              disabled={readOnly}
              className={fieldControlClass(!!errors.street)}
            />
          )}
        </FormField>
        <FormField label="Número" error={errors.number} className="sm:col-span-2">
          {(field) => (
            <input
              {...field}
              ref={numberRef}
              value={draft.number}
              onChange={(event) => update('number', event.target.value)}
              maxLength={FIELD_LIMITS.address_number}
              disabled={readOnly}
              className={fieldControlClass(!!errors.number)}
            />
          )}
        </FormField>
        <FormField label="Complemento" error={errors.complement} className="sm:col-span-4">
          {(field) => (
            <input
              {...field}
              value={draft.complement}
              onChange={(event) => update('complement', event.target.value)}
              maxLength={FIELD_LIMITS.address_complement}
              placeholder="Ex.: Loja B"
              autoComplete="address-line2"
              disabled={readOnly}
              className={fieldControlClass(!!errors.complement)}
            />
          )}
        </FormField>
        <FormField label="Bairro" error={errors.neighborhood} className="sm:col-span-2">
          {(field) => (
            <input
              {...field}
              value={draft.neighborhood}
              onChange={(event) => update('neighborhood', event.target.value)}
              maxLength={FIELD_LIMITS.address_neighborhood}
              disabled={readOnly}
              className={fieldControlClass(!!errors.neighborhood)}
            />
          )}
        </FormField>
        <FormField label="Cidade" error={errors.city} className="sm:col-span-3">
          {(field) => (
            <input
              {...field}
              value={draft.city}
              onChange={(event) => update('city', event.target.value)}
              maxLength={FIELD_LIMITS.address_city}
              autoComplete="address-level2"
              disabled={readOnly}
              className={fieldControlClass(!!errors.city)}
            />
          )}
        </FormField>
        <FormField label="UF" error={errors.state} className="sm:col-span-1">
          {(field) => (
            <select
              {...field}
              value={draft.state}
              onChange={(event) => update('state', event.target.value)}
              autoComplete="address-level1"
              disabled={readOnly}
              className={fieldControlClass(!!errors.state)}
            >
              <option value="">—</option>
              {UFS.map((uf) => <option key={uf} value={uf}>{uf}</option>)}
            </select>
          )}
        </FormField>
      </div>
    </SettingsSection>
  );
}
