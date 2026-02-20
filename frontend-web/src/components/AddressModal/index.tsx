import { useState } from 'react';
import { X, Loader2, Search } from 'lucide-react';
import api from '../../services/api';

interface AddressModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void; // Para recarregar a lista no carrinho
}

export default function AddressModal({ isOpen, onClose, onSuccess }: AddressModalProps) {
  const [loading, setLoading] = useState(false);
  const [zipCode, setZipCode] = useState('');
  
  const [formData, setFormData] = useState({
    street: '',
    number: '',
    complement: '',
    neighborhood: '',
    city: '',
    state: ''
  });

  if (!isOpen) return null;

  async function handleBlurZip() {
    if (zipCode.length < 8) return;
    try {
      setLoading(true);
      // Consulta API pública do ViaCEP
      const response = await fetch(`https://viacep.com.br/ws/${zipCode}/json/`);
      const data = await response.json();
      
      if (!data.erro) {
        setFormData(prev => ({
          ...prev,
          street: data.logradouro,
          neighborhood: data.bairro,
          city: data.localidade,
          state: data.uf
        }));
      }
    } catch (error) {
      console.error("Erro ao buscar CEP", error);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!formData.street || !formData.number || !zipCode) {
      alert("Preencha os campos obrigatórios!");
      return;
    }

    try {
      setLoading(true);
      // ENVIA PARA O SEU BACKEND
      await api.post('/addresses', {
        zipCode,
        ...formData
      });
      
      onSuccess(); // Avisa o carrinho que salvou
      onClose();   // Fecha o modal
    } catch (error) {
      console.error(error);
      alert("Erro ao salvar endereço.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in">
      <div className="bg-white dark:bg-slate-900 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden transition-colors">
        
        {/* Header */}
        <div className="bg-orange-600 dark:bg-orange-700 px-6 py-4 flex justify-between items-center text-white">
          <h2 className="font-bold text-lg">Novo Endereço de Entrega 🛵</h2>
          <button onClick={onClose} className="hover:bg-orange-700 dark:hover:bg-orange-800 p-1 rounded-lg transition-colors"><X size={20}/></button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4">
          
          {/* CEP */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">CEP</label>
            <div className="relative">
              <input 
                value={zipCode}
                onChange={e => setZipCode(e.target.value.replace(/\D/g, ''))}
                onBlur={handleBlurZip}
                maxLength={8}
                placeholder="00000-000"
                className="w-full border border-gray-300 dark:border-slate-600 rounded-xl p-3 pl-3 pr-10 focus:ring-orange-500 focus:border-orange-500 outline-none bg-white dark:bg-slate-800 text-gray-900 dark:text-white"
              />
              <div className="absolute right-3 top-3 text-gray-400 dark:text-gray-500">
                {loading ? <Loader2 size={20} className="animate-spin text-orange-600 dark:text-orange-400"/> : <Search size={20}/>}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Rua / Av.</label>
              <input 
                value={formData.street}
                onChange={e => setFormData({...formData, street: e.target.value})}
                className="w-full border border-gray-300 dark:border-slate-600 rounded-xl p-3 focus:ring-orange-500 outline-none bg-gray-50 dark:bg-slate-800 text-gray-900 dark:text-white"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Número</label>
              <input 
                value={formData.number}
                onChange={e => setFormData({...formData, number: e.target.value})}
                className="w-full border border-gray-300 dark:border-slate-600 rounded-xl p-3 focus:ring-orange-500 outline-none bg-white dark:bg-slate-800 text-gray-900 dark:text-white"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Bairro</label>
              <input 
                value={formData.neighborhood}
                onChange={e => setFormData({...formData, neighborhood: e.target.value})}
                className="w-full border border-gray-300 dark:border-slate-600 rounded-xl p-3 focus:ring-orange-500 outline-none bg-gray-50 dark:bg-slate-800 text-gray-900 dark:text-white"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Complemento</label>
              <input 
                value={formData.complement}
                onChange={e => setFormData({...formData, complement: e.target.value})}
                placeholder="Apto, Bloco..."
                className="w-full border border-gray-300 dark:border-slate-600 rounded-xl p-3 focus:ring-orange-500 outline-none bg-white dark:bg-slate-800 text-gray-900 dark:text-white"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Cidade</label>
              <input 
                value={formData.city}
                readOnly
                className="w-full border border-gray-300 dark:border-slate-600 rounded-xl p-3 bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-gray-400 outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">UF</label>
              <input 
                value={formData.state}
                readOnly
                className="w-full border border-gray-300 dark:border-slate-600 rounded-xl p-3 bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-gray-400 outline-none text-center"
              />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 bg-gray-50 dark:bg-slate-900 border-t border-gray-100 dark:border-slate-700 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-gray-600 dark:text-gray-400 font-bold hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-colors">Cancelar</button>
          <button onClick={handleSave} disabled={loading} className="px-6 py-2 bg-green-600 text-white font-bold rounded-lg hover:bg-green-700 transition-colors flex items-center gap-2">
            {loading ? 'Salvando...' : 'Salvar Endereço'}
          </button>
        </div>
      </div>
    </div>
  );
}