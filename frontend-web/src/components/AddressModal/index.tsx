import { useRef, useState, type FormEvent } from 'react';
import { Loader2, Search, Tag } from 'lucide-react';
import toast from 'react-hot-toast';
import api, { getApiErrorMessage } from '../../services/api';
import { cepNeighborhoodNote, type CustomerAddress } from '../../services/addressService';
import { maskCEP } from '../../utils/masks';
import { isUf } from '../../utils/validation';
import { FormField, Modal, buttonClass, fieldControlClass } from '../ui';

/**
 * Endereço salvo (resposta de POST /addresses). Os endereços são do cliente e valem em qualquer loja; a API
 * guarda junto o bairro do CEP (canonical_*), que é o usado na taxa de entrega.
 */
export type SavedAddress = CustomerAddress;

interface AddressModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Recebe o endereço criado, para quem abriu o modal já selecioná-lo. */
  onSuccess: (address?: SavedAddress) => void;
}

interface CepLookup {
  logradouro?: string;
  bairro?: string;
  localidade?: string;
  uf?: string;
}

const EMPTY_FORM = {
  nickname: '',
  street: '',
  number: '',
  complement: '',
  neighborhood: '',
  city: '',
  state: '',
};

const FORM_ID = 'address-modal-form';


export default function AddressModal({ isOpen, onClose, onSuccess }: AddressModalProps) {
  if (!isOpen) return null;
  // Cada abertura começa com o formulário limpo (inclusive depois de "Cancelar")
  return <AddressForm onClose={onClose} onSuccess={onSuccess} />;
}

function AddressForm({ onClose, onSuccess }: Omit<AddressModalProps, 'isOpen'>) {
  const [loading, setLoading] = useState(false);
  const [searchingCep, setSearchingCep] = useState(false);
  const [zipCode, setZipCode] = useState('');
  const [formData, setFormData] = useState(EMPTY_FORM);

  // Foco no número depois da busca do CEP (o resto do endereço já veio preenchido)
  const numberInputRef = useRef<HTMLInputElement>(null);
  const nicknameRef = useRef<HTMLInputElement>(null);
  // Só a resposta do último CEP digitado é aproveitada
  const lastLookup = useRef('');

  function update(field: keyof typeof EMPTY_FORM, value: string) {
    setFormData((previous) => ({ ...previous, [field]: value }));
  }

  function handleChangeZip(value: string) {
    const masked = maskCEP(value);
    setZipCode(masked);
    // CEP completo (00000-000): busca o endereço
    if (masked.length === 9) void searchCep(masked.replace(/\D/g, ''));
    else lastLookup.current = '';
  }

  async function searchCep(cepDigits: string) {
    lastLookup.current = cepDigits;
    setSearchingCep(true);
    try {
      // Proxy do backend (ViaCEP com BrasilAPI de reserva)
      const { data } = await api.get<CepLookup>(`/addresses/cep/${cepDigits}`);
      if (lastLookup.current !== cepDigits) return;

      setFormData((previous) => ({
        ...previous,
        street: data.logradouro || previous.street,
        neighborhood: data.bairro || previous.neighborhood,
        city: data.localidade || previous.city,
        state: (data.uf || previous.state).toUpperCase(),
      }));
      window.setTimeout(() => numberInputRef.current?.focus(), 100);
    } catch (error) {
      if (lastLookup.current !== cepDigits) return;
      // Sem internet ou CEP desconhecido: a pessoa preenche o endereço à mão
      toast.error(getApiErrorMessage(error, 'CEP não encontrado. Preencha o endereço manualmente.'), { duration: 5000 });
    } finally {
      if (lastLookup.current === cepDigits) setSearchingCep(false);
    }
  }

  async function handleSave(event?: FormEvent) {
    event?.preventDefault();
    if (loading) return;
    // Campos obrigatórios conforme o DTO do backend
    if (!formData.street.trim() || !formData.number.trim() || !zipCode || !formData.neighborhood.trim() || !formData.city.trim() || !formData.state.trim()) {
      toast.error('Preencha todos os campos obrigatórios!');
      return;
    }
    if (zipCode.replace(/\D/g, '').length !== 8) {
      toast.error('CEP inválido. Informe os 8 dígitos.');
      return;
    }
    if (!isUf(formData.state.trim().toUpperCase())) {
      toast.error('UF inválida. Use a sigla do estado com 2 letras (ex.: RJ).');
      return;
    }

    setLoading(true);
    try {
      const { data } = await api.post<SavedAddress>('/addresses', {
        nickname: formData.nickname.trim() || 'Casa',
        zipCode,
        street: formData.street.trim(),
        number: formData.number.trim(),
        complement: formData.complement.trim(),
        neighborhood: formData.neighborhood.trim(),
        city: formData.city.trim(),
        state: formData.state.trim().toUpperCase(),
      });

      toast.success('Endereço salvo com sucesso!');
      // O CEP é de outro bairro: a entrega vai ser calculada para o bairro do CEP (o cliente fica sabendo já)
      const cepNote = data ? cepNeighborhoodNote(data) : null;
      if (cepNote) toast(cepNote, { duration: 7000 });
      onSuccess(data); // recarrega a lista no checkout e seleciona o novo endereço
      onClose();
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Erro ao salvar endereço.', { 401: 'Faça login para salvar endereços.' }));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!loading}
      title="Novo Endereço"
      description="Endereço de entrega da sua conta (vale para qualquer loja)."
      initialFocusRef={nicknameRef}
      footer={(
        <>
          <button type="button" onClick={onClose} disabled={loading} className={buttonClass('secondary')}>Cancelar</button>
          <button type="submit" form={FORM_ID} disabled={loading} className="inline-flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl text-sm font-bold bg-green-600 hover:bg-green-700 text-white shadow-lg shadow-green-200 dark:shadow-none transition-colors disabled:opacity-70">
            {loading ? <><Loader2 className="animate-spin" size={18} aria-hidden="true" /> Salvando...</> : 'Salvar Endereço'}
          </button>
        </>
      )}
    >
      <form id={FORM_ID} onSubmit={handleSave} noValidate className="space-y-4">
        <FormField label="Apelido (Ex: Casa, Trabalho)">
          {(field) => (
            <div className="relative">
              <input
                {...field}
                ref={nicknameRef}
                value={formData.nickname}
                onChange={(event) => update('nickname', event.target.value)}
                placeholder="Ex: Minha Casa"
                maxLength={50}
                className={fieldControlClass(false, 'pl-10')}
              />
              <Tag size={18} className="absolute left-3 top-3 text-gray-400" aria-hidden="true" />
            </div>
          )}
        </FormField>

        <FormField label="CEP" required hint="Preenchemos o endereço pelo CEP. Se não encontrar, digite os campos abaixo.">
          {(field) => (
            <div className="relative">
              <input
                {...field}
                value={zipCode}
                onChange={(event) => handleChangeZip(event.target.value)}
                maxLength={9}
                inputMode="numeric"
                autoComplete="postal-code"
                placeholder="00000-000"
                className={fieldControlClass(false, 'pr-10 font-mono')}
              />
              <span className="absolute right-3 top-2.5 text-gray-400" aria-hidden="true">
                {searchingCep ? <Loader2 size={20} className="animate-spin text-orange-600" /> : <Search size={20} />}
              </span>
              {searchingCep && <span className="sr-only" role="status">Buscando o endereço pelo CEP...</span>}
            </div>
          )}
        </FormField>

        <div className="grid grid-cols-3 gap-4">
          <FormField label="Rua / Av." required className="col-span-2">
            {(field) => (
              <input {...field} value={formData.street} onChange={(event) => update('street', event.target.value)} maxLength={150} autoComplete="address-line1" placeholder="Preenchimento automático" className={fieldControlClass()} />
            )}
          </FormField>
          <FormField label="Nº" required>
            {(field) => (
              <input {...field} ref={numberInputRef} value={formData.number} onChange={(event) => update('number', event.target.value)} maxLength={20} placeholder="123" className={fieldControlClass()} />
            )}
          </FormField>
        </div>

        <div className="grid grid-cols-1 min-[400px]:grid-cols-2 gap-4">
          <FormField label="Bairro" required>
            {(field) => (
              <input {...field} value={formData.neighborhood} onChange={(event) => update('neighborhood', event.target.value)} maxLength={100} className={fieldControlClass()} />
            )}
          </FormField>
          <FormField label="Complemento">
            {(field) => (
              <input {...field} value={formData.complement} onChange={(event) => update('complement', event.target.value)} maxLength={100} autoComplete="address-line2" placeholder="Apto, Bloco..." className={fieldControlClass()} />
            )}
          </FormField>
        </div>

        {/* Cidade e UF: preenchidas pelo CEP, mas editáveis (CEP desconhecido ou sem internet) */}
        <div className="grid grid-cols-3 gap-4">
          <FormField label="Cidade" required className="col-span-2">
            {(field) => (
              <input {...field} value={formData.city} onChange={(event) => update('city', event.target.value)} maxLength={100} autoComplete="address-level2" className={fieldControlClass()} />
            )}
          </FormField>
          <FormField label="UF" required>
            {(field) => (
              <input
                {...field}
                value={formData.state}
                onChange={(event) => update('state', event.target.value.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 2))}
                maxLength={2}
                autoComplete="address-level1"
                placeholder="RJ"
                className={fieldControlClass(false, 'text-center uppercase')}
              />
            )}
          </FormField>
        </div>
      </form>
    </Modal>
  );
}
