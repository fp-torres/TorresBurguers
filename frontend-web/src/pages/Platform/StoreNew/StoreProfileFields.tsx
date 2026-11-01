import { useRef, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { FormField, buttonClass, fieldControlClass } from '../../../components/ui';
import { getApiErrorMessage } from '../../../services/api';
import { platformStoresService } from '../../../services/platform/storesService';
import { maskCEP, maskPhone } from '../../../utils/masks';
import {
  STORE_FIELD_LIMITS, type StoreProfileErrors, type StoreProfileValues,
} from './storeForm';
import { UFS, maskDocument, zipDigits } from '../../../utils/validation';

interface StoreProfileFieldsProps {
  values: StoreProfileValues;
  onChange: (changes: Partial<StoreProfileValues>) => void;
  /** Erros por campo (exibidos só com showErrors). */
  errors: StoreProfileErrors;
  showErrors: boolean;
  disabled?: boolean;
  /** Nível do título das seções ("Contato", "Endereço"). */
  headingLevel?: 2 | 3;
}

/**
 * Campos do cadastro da loja (razão social, CPF/CNPJ, contato e endereço opcional) usados no novo estabelecimento
 * e na edição dos dados administrativos. O CEP pode preencher o endereço (GET /addresses/cep/:cep).
 */
export default function StoreProfileFields({ values, onChange, errors, showErrors, disabled = false, headingLevel = 2 }: StoreProfileFieldsProps) {
  const visible: StoreProfileErrors = showErrors ? errors : {};
  const [cepStatus, setCepStatus] = useState<{ loading: boolean; message: string | null }>({ loading: false, message: null });
  const lookupRef = useRef<AbortController | null>(null);
  const Heading = headingLevel === 2 ? 'h2' : 'h3';

  async function lookupCep() {
    const digits = zipDigits(values.address_zip_code);
    if (digits.length !== 8) {
      setCepStatus({ loading: false, message: 'Informe os 8 dígitos do CEP para buscar.' });
      return;
    }
    lookupRef.current?.abort();
    const controller = new AbortController();
    lookupRef.current = controller;
    setCepStatus({ loading: true, message: null });
    try {
      const address = await platformStoresService.lookupCep(digits, controller.signal);
      onChange({
        address_street: address.street || values.address_street,
        address_neighborhood: address.neighborhood || values.address_neighborhood,
        address_city: address.city || values.address_city,
        address_state: (UFS as readonly string[]).includes(address.state) ? address.state : values.address_state,
      });
      setCepStatus({ loading: false, message: 'Endereço preenchido pelo CEP: confira e informe o número.' });
    } catch (error) {
      if (controller.signal.aborted) return;
      setCepStatus({ loading: false, message: getApiErrorMessage(error, 'Não foi possível buscar o CEP.', { 404: 'CEP não encontrado.' }) });
    }
  }

  const text = (field: keyof StoreProfileValues, label: string, options: { max?: number; placeholder?: string; autoComplete?: string; className?: string } = {}) => (
    <FormField label={label} error={visible[field]} className={options.className}>
      {(control) => (
        <input
          {...control}
          value={values[field]}
          onChange={(event) => onChange({ [field]: event.target.value })}
          maxLength={options.max}
          placeholder={options.placeholder}
          autoComplete={options.autoComplete ?? 'off'}
          disabled={disabled}
          className={fieldControlClass(!!visible[field])}
        />
      )}
    </FormField>
  );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {text('legal_name', 'Razão social (opcional)', { max: STORE_FIELD_LIMITS.legal_name, placeholder: 'Lanchonete do Bairro LTDA' })}
        <FormField label="CPF ou CNPJ (opcional)" error={visible.document} hint="Conferimos os dígitos verificadores; aceita o CNPJ alfanumérico.">
          {(control) => (
            <input
              {...control}
              value={values.document}
              onChange={(event) => onChange({ document: maskDocument(event.target.value) })}
              placeholder="00.000.000/0000-00"
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              className={fieldControlClass(!!visible.document)}
            />
          )}
        </FormField>
      </div>

      <section className="space-y-4">
        <Heading className="text-sm font-bold text-gray-800 dark:text-white">Contato da loja</Heading>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField label="E-mail (opcional)" error={visible.email}>
            {(control) => (
              <input
                {...control}
                type="email"
                value={values.email}
                onChange={(event) => onChange({ email: event.target.value })}
                maxLength={STORE_FIELD_LIMITS.email}
                placeholder="contato@loja.com.br"
                autoComplete="off"
                disabled={disabled}
                className={fieldControlClass(!!visible.email)}
              />
            )}
          </FormField>
          <FormField label="Telefone (opcional)" error={visible.phone}>
            {(control) => (
              <input
                {...control}
                type="tel"
                inputMode="tel"
                value={values.phone}
                onChange={(event) => onChange({ phone: maskPhone(event.target.value) })}
                placeholder="(21) 99999-9999"
                autoComplete="off"
                disabled={disabled}
                className={fieldControlClass(!!visible.phone)}
              />
            )}
          </FormField>
        </div>
      </section>

      <section className="space-y-4">
        <Heading className="text-sm font-bold text-gray-800 dark:text-white">Endereço (opcional)</Heading>
        <div className="grid grid-cols-1 sm:grid-cols-6 gap-4">
          <div className="sm:col-span-3 space-y-1.5">
            <FormField label="CEP" error={visible.address_zip_code}>
              {(control) => (
                <div className="flex gap-2">
                  <input
                    {...control}
                    inputMode="numeric"
                    value={values.address_zip_code}
                    onChange={(event) => onChange({ address_zip_code: maskCEP(event.target.value) })}
                    placeholder="00000-000"
                    autoComplete="off"
                    disabled={disabled}
                    className={fieldControlClass(!!visible.address_zip_code)}
                  />
                  <button
                    type="button"
                    onClick={() => void lookupCep()}
                    disabled={disabled || cepStatus.loading}
                    aria-label="Buscar endereço pelo CEP"
                    className={buttonClass('secondary', 'md', 'shrink-0')}
                  >
                    {cepStatus.loading ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Search size={16} aria-hidden="true" />}
                    <span className="hidden sm:inline">Buscar</span>
                  </button>
                </div>
              )}
            </FormField>
            {cepStatus.message && <p role="status" className="text-xs text-gray-500 dark:text-gray-400">{cepStatus.message}</p>}
          </div>
          {text('address_street', 'Rua', { max: STORE_FIELD_LIMITS.address_street, className: 'sm:col-span-6' })}
          {text('address_number', 'Número', { max: STORE_FIELD_LIMITS.address_number, className: 'sm:col-span-2' })}
          {text('address_complement', 'Complemento', { max: STORE_FIELD_LIMITS.address_complement, className: 'sm:col-span-4' })}
          {text('address_neighborhood', 'Bairro', { max: STORE_FIELD_LIMITS.address_neighborhood, className: 'sm:col-span-3' })}
          {text('address_city', 'Cidade', { max: STORE_FIELD_LIMITS.address_city, className: 'sm:col-span-2' })}
          <FormField label="UF" error={visible.address_state} className="sm:col-span-1">
            {(control) => (
              <select
                {...control}
                value={values.address_state}
                onChange={(event) => onChange({ address_state: event.target.value })}
                disabled={disabled}
                className={fieldControlClass(!!visible.address_state)}
              >
                <option value="">—</option>
                {UFS.map((uf) => <option key={uf} value={uf}>{uf}</option>)}
              </select>
            )}
          </FormField>
        </div>
      </section>
    </div>
  );
}
