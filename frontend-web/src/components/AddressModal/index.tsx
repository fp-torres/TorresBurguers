import { useState, useRef, useId } from 'react';
import { X, Loader2, Search, MapPin, Tag } from 'lucide-react';
import api, { getApiErrorMessage } from '../../services/api';
import { maskCEP } from '../../utils/masks';
import toast from 'react-hot-toast';

/** Endereço salvo (resposta de POST /addresses). */
export interface SavedAddress {
  id: number;
  nickname?: string | null;
  zipCode?: string;
  street: string;
  number: string;
  complement?: string | null;
  neighborhood: string;
  city: string;
  state: string;
}

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
  state: ''
};

const INPUT_CLASSES = 'w-full border border-gray-300 dark:border-slate-600 rounded-xl p-3 focus:ring-2 focus:ring-orange-500 outline-none bg-white dark:bg-slate-800 text-gray-900 dark:text-white';

export default function AddressModal({ isOpen, onClose, onSuccess }: AddressModalProps) {
  if (!isOpen) return null;
  // Cada abertura começa com o formulário limpo (inclusive depois de "Cancelar")
  return <AddressForm onClose={onClose} onSuccess={onSuccess} />;
}

function AddressForm({ onClose, onSuccess }: Omit<AddressModalProps, 'isOpen'>) {
  const titleId = useId();
  const [loading, setLoading] = useState(false);
  const [searchingCep, setSearchingCep] = useState(false);
  const [zipCode, setZipCode] = useState('');

  // Ref para focar no número automaticamente após a busca do CEP
  const numberInputRef = useRef<HTMLInputElement>(null);
  // Só a resposta do último CEP digitado é aproveitada
  const lastLookup = useRef('');

  const [formData, setFormData] = useState(EMPTY_FORM);

  // Gerencia a mudança do CEP e dispara a busca automática
  function handleChangeZip(e: React.ChangeEvent<HTMLInputElement>) {
    const value = maskCEP(e.target.value);
    setZipCode(value);

    // Quando o CEP atinge o formato completo (9 chars: 00000-000)
    if (value.length === 9) {
      searchCep(value.replace(/\D/g, ''));
    } else {
      lastLookup.current = '';
    }
  }

  async function searchCep(cepDigits: string) {
    lastLookup.current = cepDigits;
    setSearchingCep(true);
    try {
      // Proxy do backend (ViaCEP com BrasilAPI de reserva)
      const { data } = await api.get<CepLookup>(`/addresses/cep/${cepDigits}`);
      if (lastLookup.current !== cepDigits) return;

      setFormData(prev => ({
        ...prev,
        street: data.logradouro || prev.street,
        neighborhood: data.bairro || prev.neighborhood,
        city: data.localidade || prev.city,
        state: (data.uf || prev.state).toUpperCase(),
      }));

      // Foco automático no número para UX mobile-first rápida
      setTimeout(() => numberInputRef.current?.focus(), 100);

    } catch (error) {
      if (lastLookup.current !== cepDigits) return;
      // Sem internet ou CEP desconhecido: a pessoa preenche o endereço à mão
      toast.error(getApiErrorMessage(error, 'CEP não encontrado. Preencha o endereço manualmente.'), { duration: 5000 });
    } finally {
      if (lastLookup.current === cepDigits) setSearchingCep(false);
    }
  }

  async function handleSave() {
    // Validação de campos obrigatórios conforme o DTO do Backend
    if (!formData.street.trim() || !formData.number.trim() || !zipCode || !formData.neighborhood.trim() || !formData.city.trim() || !formData.state.trim()) {
      toast.error("Preencha todos os campos obrigatórios!");
      return;
    }
    if (zipCode.replace(/\D/g, '').length !== 8) {
      toast.error('CEP inválido. Informe os 8 dígitos.');
      return;
    }
    if (!/^[A-Za-z]{2}$/.test(formData.state.trim())) {
      toast.error('UF inválida. Use a sigla do estado com 2 letras (ex.: RJ).');
      return;
    }

    try {
      setLoading(true);

      // Chave 'zipCode' em camelCase para bater com o CreateAddressDto
      const { data } = await api.post<SavedAddress>('/addresses', {
        nickname: formData.nickname.trim() || 'Casa',
        zipCode: zipCode,
        street: formData.street.trim(),
        number: formData.number.trim(),
        complement: formData.complement.trim(),
        neighborhood: formData.neighborhood.trim(),
        city: formData.city.trim(),
        state: formData.state.trim().toUpperCase() // Garante 2 letras (ex: RJ)
      });

      toast.success('Endereço salvo com sucesso!');
      onSuccess(data); // Recarrega a lista no checkout e seleciona o novo endereço
      onClose();
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Erro ao salvar endereço.', { 401: 'Faça login para salvar endereços.' }));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="bg-white dark:bg-slate-900 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden transition-colors border border-gray-100 dark:border-slate-800">

        {/* Header */}
        <div className="bg-orange-600 dark:bg-orange-700 px-6 py-4 flex justify-between items-center text-white shadow-md">
          <h2 id={titleId} className="font-bold text-lg flex items-center gap-2">
            <MapPin size={20}/> Novo Endereço
          </h2>
          <button type="button" onClick={onClose} aria-label="Fechar" className="hover:bg-orange-700 p-1 rounded-lg transition-colors">
            <X size={20}/>
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto custom-scrollbar">

          {/* Apelido / Nickname */}
          <div>
            <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-1">Apelido (Ex: Casa, Trabalho)</label>
            <div className="relative">
              {/* Primeiro campo do diálogo: recebe o foco ao abrir */}
              <input
                autoFocus
                value={formData.nickname}
                onChange={e => setFormData({...formData, nickname: e.target.value})}
                placeholder="Ex: Minha Casa"
                maxLength={50}
                className="w-full border border-gray-300 dark:border-slate-600 rounded-xl p-3 pl-10 outline-none bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-orange-500"
              />
              <Tag size={18} className="absolute left-3 top-3.5 text-gray-400" />
            </div>
          </div>

          {/* CEP */}
          <div>
            <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-1">CEP</label>
            <div className="relative">
              <input
                value={zipCode}
                onChange={handleChangeZip}
                maxLength={9}
                inputMode="numeric"
                placeholder="00000-000"
                className="w-full border border-gray-300 dark:border-slate-600 rounded-xl p-3 pr-10 outline-none bg-white dark:bg-slate-800 text-gray-900 dark:text-white font-mono focus:ring-2 focus:ring-orange-500"
              />
              <div className="absolute right-3 top-3 text-gray-400">
                {searchingCep ? <Loader2 size={20} className="animate-spin text-orange-600"/> : <Search size={20}/>}
              </div>
            </div>
            <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">Preenchemos o endereço pelo CEP. Se não encontrar, digite os campos abaixo.</p>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2">
              <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-1">Rua / Av.</label>
              <input
                value={formData.street}
                onChange={e => setFormData({...formData, street: e.target.value})}
                maxLength={150}
                className={INPUT_CLASSES}
                placeholder="Preenchimento automático"
              />
            </div>
            <div>
              <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-1">Nº</label>
              <input
                ref={numberInputRef}
                value={formData.number}
                onChange={e => setFormData({...formData, number: e.target.value})}
                maxLength={20}
                className={INPUT_CLASSES}
                placeholder="123"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-1">Bairro</label>
              <input
                value={formData.neighborhood}
                onChange={e => setFormData({...formData, neighborhood: e.target.value})}
                maxLength={100}
                className={INPUT_CLASSES}
              />
            </div>
            <div>
              <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-1">Complemento</label>
              <input
                value={formData.complement}
                onChange={e => setFormData({...formData, complement: e.target.value})}
                placeholder="Apto, Bloco..."
                maxLength={100}
                className={INPUT_CLASSES}
              />
            </div>
          </div>

          {/* Cidade e UF: preenchidas pelo CEP, mas editáveis (CEP desconhecido ou sem internet) */}
          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2">
              <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-1">Cidade</label>
              <input
                value={formData.city}
                onChange={e => setFormData({...formData, city: e.target.value})}
                maxLength={100}
                className={INPUT_CLASSES}
              />
            </div>
            <div>
              <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-1">UF</label>
              <input
                value={formData.state}
                onChange={e => setFormData({...formData, state: e.target.value.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 2)})}
                maxLength={2}
                placeholder="RJ"
                className={`${INPUT_CLASSES} text-center uppercase`}
              />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 bg-gray-50 dark:bg-slate-900 border-t border-gray-100 dark:border-slate-700 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-gray-600 dark:text-gray-400 font-bold hover:bg-gray-200 dark:hover:bg-slate-800 rounded-xl transition-colors"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={loading}
            className="px-6 py-3 bg-green-600 text-white font-bold rounded-xl hover:bg-green-700 transition-colors flex items-center gap-2 shadow-lg shadow-green-200 dark:shadow-none disabled:opacity-70"
          >
            {loading ? <Loader2 className="animate-spin" size={20} /> : 'Salvar Endereço'}
          </button>
        </div>
      </div>
    </div>
  );
}
