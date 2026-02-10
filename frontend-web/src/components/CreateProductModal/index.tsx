import { useState, useRef } from 'react';
// CORREÇÃO: Usando SyntheticEvent (padrão genérico para submits) e ChangeEvent
import type { ChangeEvent, SyntheticEvent } from 'react'; 
import { X, Upload, Loader2, CheckCircle } from 'lucide-react';
import api from '../../services/api';

interface CreateProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function CreateProductModal({ isOpen, onClose, onSuccess }: CreateProductModalProps) {
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Estados do Formulário
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [category, setCategory] = useState('hamburgueres');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  if (!isOpen) return null;

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      setImageFile(file);
      const objectUrl = URL.createObjectURL(file);
      setPreview(objectUrl);
    }
  }

  // CORREÇÃO: FormEvent -> SyntheticEvent
  async function handleSubmit(e: SyntheticEvent) {
    e.preventDefault(); // Agora o TypeScript reconhece isso sem erros
    setLoading(true);

    try {
      // 1. Cria o FormData para envio de arquivo
      const formData = new FormData();
      formData.append('name', name);
      formData.append('description', description);
      
      // Converte preço (troca vírgula por ponto)
      const formattedPrice = price.replace(',', '.');
      formData.append('price', formattedPrice);
      
      formData.append('category', category);
      formData.append('available', 'true');

      if (imageFile) {
        formData.append('file', imageFile);
      }

      // 2. Envia para o endpoint de criação
      await api.post('/products', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      
      onSuccess();
      onClose();
      resetForm();

    } catch (error: any) {
      console.error("Erro ao criar:", error);
      alert('Erro ao cadastrar produto. Verifique os dados.');
    } finally {
      setLoading(false);
    }
  }

  function resetForm() {
    setName('');
    setDescription('');
    setPrice('');
    setCategory('hamburgueres');
    setImageFile(null);
    setPreview(null);
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-200">
        
        {/* Cabeçalho */}
        <div className="bg-gray-50 px-6 py-4 border-b border-gray-100 flex justify-between items-center">
          <h2 className="text-lg font-bold text-gray-800">Novo Produto</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <X size={24} />
          </button>
        </div>

        {/* Formulário */}
        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          <div className="flex gap-6">
            {/* Upload de Imagem */}
            <div className="w-1/3">
              <div 
                onClick={() => fileInputRef.current?.click()}
                className="aspect-square rounded-xl border-2 border-dashed border-gray-300 hover:border-orange-500 cursor-pointer flex flex-col items-center justify-center bg-gray-50 hover:bg-orange-50 transition-colors overflow-hidden relative group"
              >
                {preview ? (
                  <>
                    <img src={preview} alt="Preview" className="w-full h-full object-cover" />
                    <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                      <p className="text-white text-xs font-bold">Trocar Foto</p>
                    </div>
                  </>
                ) : (
                  <>
                    <Upload className="text-gray-400 mb-2" size={32} />
                    <span className="text-xs text-gray-500 font-medium text-center px-2">Clique para adicionar foto</span>
                  </>
                )}
                <input 
                  type="file" 
                  ref={fileInputRef} 
                  onChange={handleFileChange} 
                  className="hidden" 
                  accept="image/*"
                />
              </div>
            </div>

            {/* Campos de Texto */}
            <div className="flex-1 space-y-4">
              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Nome do Produto</label>
                <input 
                  required
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className="w-full px-4 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none"
                  placeholder="Ex: X-Torres Bacon"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Preço (R$)</label>
                  <input 
                    required
                    type="text"
                    value={price}
                    onChange={e => setPrice(e.target.value)}
                    className="w-full px-4 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none"
                    placeholder="0,00"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Categoria</label>
                  <select 
                    value={category}
                    onChange={e => setCategory(e.target.value)}
                    className="w-full px-4 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none bg-white"
                  >
                    <option value="hamburgueres">Hambúrgueres</option>
                    <option value="bebidas">Bebidas</option>
                    <option value="acompanhamentos">Acompanhamentos</option>
                    <option value="sobremesas">Sobremesas</option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Descrição</label>
            <textarea 
              required
              rows={3}
              value={description}
              onChange={e => setDescription(e.target.value)}
              className="w-full px-4 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none resize-none"
              placeholder="Descreva os ingredientes deliciosos..."
            />
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-gray-100">
            <button 
              type="button" 
              onClick={onClose}
              className="px-6 py-2 text-gray-600 hover:bg-gray-100 rounded-lg font-medium transition-colors"
            >
              Cancelar
            </button>
            <button 
              type="submit" 
              disabled={loading}
              className="px-6 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors flex items-center gap-2 disabled:opacity-50"
            >
              {loading ? <Loader2 className="animate-spin" size={18} /> : <CheckCircle size={18} />}
              Salvar Produto
            </button>
          </div>

        </form>
      </div>
    </div>
  );
}