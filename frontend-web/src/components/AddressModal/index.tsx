import { useState, useRef } from 'react';
import { X, Loader2, Search, MapPin, Tag } from 'lucide-react'; 
import api from '../../services/api';
import { maskCEP } from '../../utils/masks'; 
import toast from 'react-hot-toast';

interface AddressModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void; 
}

export default function AddressModal({ isOpen, onClose, onSuccess }: AddressModalProps) {
  const [loading, setLoading] = useState(false);
  const [zipCode, setZipCode] = useState('');
  
  // Ref para focar no número automaticamente após a busca do CEP
  const numberInputRef = useRef<HTMLInputElement>(null);

  const [formData, setFormData] = useState({
    nickname: '', // Novo campo conforme seu DTO
    street: '',
    number: '',
    complement: '',
    neighborhood: '',
    city: '',
    state: ''
  });

  if (!isOpen) return null;

  // Gerencia a mudança do CEP e dispara a busca automática
  async function handleChangeZip(e: React.ChangeEvent<HTMLInputElement>) {
    const value = maskCEP(e.target.value);
    setZipCode(value);

    // Quando o CEP atinge o formato completo (9 chars: 00000-000)
    if (value.length === 9) {
      const cleanCep = value.replace(/\D/g, '');
      searchCep(cleanCep);
    }
  }

  async function searchCep(cepString: string) {
    try {
      setLoading(true);
      // Chama o proxy do seu backend
      const response = await api.get(`/addresses/cep/${cepString}`);
      const data = response.data;
      
      setFormData(prev => ({
        ...prev,
        street: data.logradouro,
        neighborhood: data.bairro,
        city: data.localidade,
        state: data.uf
      }));
      
      // Foco automático no número para UX mobile-first rápida
      setTimeout(() => {
        numberInputRef.current?.focus();
      }, 100);
      
    } catch (error) {
      console.error("Erro ao buscar CEP", error);
      toast.error('CEP não encontrado.');
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    // Validação de campos obrigatórios conforme o DTO do seu Backend
    if (!formData.street || !formData.number || !zipCode || !formData.neighborhood || !formData.city || !formData.state) {
      toast.error("Preencha todos os campos obrigatórios!");
      return;
    }

    try {
      setLoading(true);
      
      // ENVIANDO O PAYLOAD CORRETO PARA O SEU BACKEND
      // Chave 'zipCode' em camelCase para bater com o CreateAddressDto
      await api.post('/addresses', {
        nickname: formData.nickname || 'Casa',
        zipCode: zipCode, 
        street: formData.street,
        number: formData.number,
        complement: formData.complement,
        neighborhood: formData.neighborhood,
        city: formData.city,
        state: formData.state.toUpperCase() // Garante 2 letras (ex: RJ)
      });
      
      toast.success('Endereço salvo com sucesso!');
      onSuccess(); // Recarrega lista no checkout/carrinho
      
      // Reseta o estado
      setZipCode('');
      setFormData({
        nickname: '', street: '', number: '', complement: '', neighborhood: '', city: '', state: ''
      });
      
      onClose();
    } catch (error: any) {
      console.error(error);
      const backendMessage = error.response?.data?.message;
      toast.error(Array.isArray(backendMessage) ? backendMessage[0] : backendMessage || "Erro ao salvar endereço.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="bg-white dark:bg-slate-900 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden transition-colors border border-gray-100 dark:border-slate-800">
        
        {/* Header */}
        <div className="bg-orange-600 dark:bg-orange-700 px-6 py-4 flex justify-between items-center text-white shadow-md">
          <h2 className="font-bold text-lg flex items-center gap-2">
            <MapPin size={20}/> Novo Endereço
          </h2>
          <button onClick={onClose} className="hover:bg-orange-700 p-1 rounded-lg transition-colors">
            <X size={20}/>
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto custom-scrollbar">
          
          {/* Apelido / Nickname */}
          <div>
            <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-1">Apelido (Ex: Casa, Trabalho)</label>
            <div className="relative">
              <input 
                value={formData.nickname}
                onChange={e => setFormData({...formData, nickname: e.target.value})}
                placeholder="Ex: Minha Casa"
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
                placeholder="00000-000"
                className="w-full border border-gray-300 dark:border-slate-600 rounded-xl p-3 pr-10 outline-none bg-white dark:bg-slate-800 text-gray-900 dark:text-white font-mono focus:ring-2 focus:ring-orange-500"
              />
              <div className="absolute right-3 top-3 text-gray-400">
                {loading ? <Loader2 size={20} className="animate-spin text-orange-600"/> : <Search size={20}/>}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2">
              <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-1">Rua / Av.</label>
              <input 
                value={formData.street}
                onChange={e => setFormData({...formData, street: e.target.value})}
                className="w-full border border-gray-300 dark:border-slate-600 rounded-xl p-3 focus:ring-2 focus:ring-orange-500 outline-none bg-gray-50 dark:bg-slate-800/50 text-gray-900 dark:text-white"
                placeholder="Preenchimento automático"
              />
            </div>
            <div>
              <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-1">Nº</label>
              <input 
                ref={numberInputRef}
                value={formData.number}
                onChange={e => setFormData({...formData, number: e.target.value})}
                className="w-full border border-gray-300 dark:border-slate-600 rounded-xl p-3 focus:ring-2 focus:ring-orange-500 outline-none bg-white dark:bg-slate-800 text-gray-900 dark:text-white"
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
                className="w-full border border-gray-300 dark:border-slate-600 rounded-xl p-3 focus:ring-2 focus:ring-orange-500 outline-none bg-gray-50 dark:bg-slate-800/50 text-gray-900 dark:text-white"
              />
            </div>
            <div>
              <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-1">Complemento</label>
              <input 
                value={formData.complement}
                onChange={e => setFormData({...formData, complement: e.target.value})}
                placeholder="Apto, Bloco..."
                className="w-full border border-gray-300 dark:border-slate-600 rounded-xl p-3 focus:ring-2 focus:ring-orange-500 outline-none bg-white dark:bg-slate-800 text-gray-900 dark:text-white"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2">
              <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-1">Cidade</label>
              <input 
                value={formData.city}
                readOnly
                className="w-full border border-gray-300 dark:border-slate-600 rounded-xl p-3 bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-gray-400 outline-none cursor-not-allowed"
              />
            </div>
            <div>
              <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-1">UF</label>
              <input 
                value={formData.state}
                readOnly
                className="w-full border border-gray-300 dark:border-slate-600 rounded-xl p-3 bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-gray-400 outline-none text-center cursor-not-allowed"
              />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 bg-gray-50 dark:bg-slate-900 border-t border-gray-100 dark:border-slate-700 flex justify-end gap-3">
          <button 
            onClick={onClose} 
            className="px-4 py-2 text-gray-600 dark:text-gray-400 font-bold hover:bg-gray-200 dark:hover:bg-slate-800 rounded-xl transition-colors"
          >
            Cancelar
          </button>
          <button 
            onClick={handleSave} 
            disabled={loading} 
            className="px-6 py-3 bg-green-600 text-white font-bold rounded-xl hover:bg-green-700 transition-colors flex items-center gap-2 shadow-lg shadow-green-200 dark:shadow-none"
          >
            {loading ? <Loader2 className="animate-spin" size={20} /> : 'Salvar Endereço'}
          </button>
        </div>
      </div>
    </div>
  );
}