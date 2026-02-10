import { useState, useRef, useEffect } from 'react';
import type { ChangeEvent, SyntheticEvent } from 'react'; 
import { X, Upload, Loader2, CheckCircle, Plus, Save } from 'lucide-react';
import api from '../../services/api';
import { productService, type Addon, type Product } from '../../services/productService';

interface CreateProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  productToEdit?: Product | null; // <--- Prop nova para edição
}

export default function CreateProductModal({ isOpen, onClose, onSuccess, productToEdit }: CreateProductModalProps) {
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Estados
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [category, setCategory] = useState('hamburgueres');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [ingredientsText, setIngredientsText] = useState('');
  const [allAddons, setAllAddons] = useState<Addon[]>([]);
  const [selectedAddonIds, setSelectedAddonIds] = useState<number[]>([]);
  
  // Novo Adicional Rápido
  const [newAddonName, setNewAddonName] = useState('');
  const [newAddonPrice, setNewAddonPrice] = useState('');
  const [creatingAddon, setCreatingAddon] = useState(false);

  // Carrega dados ao abrir
  useEffect(() => {
    if (isOpen) {
      loadAddons();
      if (productToEdit) {
        // MODO EDIÇÃO: Preenche os campos
        setName(productToEdit.name);
        setDescription(productToEdit.description);
        setPrice(String(productToEdit.price).replace('.', ','));
        setCategory(productToEdit.category);
        setIngredientsText(productToEdit.ingredients ? productToEdit.ingredients.join(', ') : '');
        
        if (productToEdit.image) {
          setPreview(`http://localhost:3000/uploads/${productToEdit.image}`);
        } else {
          setPreview(null);
        }

        if (productToEdit.allowed_addons) {
          setSelectedAddonIds(productToEdit.allowed_addons.map(a => a.id));
        }
      } else {
        // MODO CRIAÇÃO: Limpa os campos
        resetForm();
      }
    }
  }, [isOpen, productToEdit]);

  async function loadAddons() {
    try {
      const data = await productService.getAllAddons();
      setAllAddons(data);
    } catch (error) { console.log("Erro addons"); }
  }

  async function handleQuickAddonCreate() {
    if (!newAddonName || !newAddonPrice) return;
    setCreatingAddon(true);
    try {
      await api.post('/addons', { name: newAddonName, price: parseFloat(newAddonPrice.replace(',', '.')) });
      setNewAddonName(''); setNewAddonPrice('');
      await loadAddons();
    } catch { alert('Erro ao criar'); } finally { setCreatingAddon(false); }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      setImageFile(file);
      setPreview(URL.createObjectURL(file));
    }
  }

  function toggleAddonSelection(id: number) {
    setSelectedAddonIds(prev => prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]);
  }

  async function handleSubmit(e: SyntheticEvent) {
    e.preventDefault();
    setLoading(true);

    try {
      const formData = new FormData();
      formData.append('name', name);
      formData.append('description', description);
      formData.append('price', price.replace(',', '.'));
      formData.append('category', category.toLowerCase());
      
      // Se estiver criando, available é true. Se editando, mantém o que estava ou manda true se quiser reativar.
      // Aqui vamos mandar true apenas na criação. Na edição, o available é controlado pela lista.
      if (!productToEdit) formData.append('available', 'true');

      if (ingredientsText.trim()) {
        const list = ingredientsText.split(',').map(i => i.trim()).filter(Boolean);
        list.forEach(ing => formData.append('ingredients[]', ing));
      }

      if (selectedAddonIds.length > 0) {
        selectedAddonIds.forEach(id => formData.append('allowed_addons_ids[]', String(id)));
      }

      if (imageFile) {
        formData.append('file', imageFile);
      }

      if (productToEdit) {
        // UPDATE
        await productService.update(productToEdit.id, formData);
      } else {
        // CREATE
        await productService.create(formData);
      }
      
      onSuccess();
      onClose();
      resetForm();

    } catch (error: any) {
      alert('Erro ao salvar produto.');
    } finally {
      setLoading(false);
    }
  }

  function resetForm() {
    setName(''); setDescription(''); setPrice(''); setIngredientsText('');
    setCategory('hamburgueres'); setImageFile(null); setPreview(null); setSelectedAddonIds([]);
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="bg-gray-50 px-6 py-4 border-b border-gray-100 flex justify-between items-center shrink-0">
          <h2 className="text-lg font-bold text-gray-800">{productToEdit ? 'Editar Produto' : 'Novo Produto'}</h2>
          <button onClick={onClose}><X size={24} className="text-gray-400 hover:text-gray-600" /></button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6 overflow-y-auto custom-scrollbar">
          <div className="flex flex-col md:flex-row gap-6">
            <div className="w-full md:w-1/3">
              <div onClick={() => fileInputRef.current?.click()} className="aspect-square rounded-xl border-2 border-dashed border-gray-300 hover:border-orange-500 cursor-pointer flex flex-col items-center justify-center bg-gray-50 relative group">
                {preview ? <img src={preview} className="w-full h-full object-cover rounded-lg" /> : <Upload className="text-gray-400" />}
                <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" accept="image/*" />
              </div>
            </div>

            <div className="flex-1 space-y-4">
              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Nome</label>
                <input required value={name} onChange={e => setName(e.target.value)} className="w-full px-4 py-2 border rounded-lg" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Preço</label>
                  <input required value={price} onChange={e => setPrice(e.target.value)} className="w-full px-4 py-2 border rounded-lg" placeholder="0,00" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Categoria</label>
                  <select value={category} onChange={e => setCategory(e.target.value)} className="w-full px-4 py-2 border rounded-lg bg-white">
                    <option value="hamburgueres">Hambúrgueres</option>
                    <option value="bebidas">Bebidas</option>
                    <option value="sobremesas">Sobremesas</option>
                    <option value="acompanhamentos">Acompanhamentos</option>
                    <option value="combos">Combos</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Ingredientes Padrão</label>
                <input value={ingredientsText} onChange={e => setIngredientsText(e.target.value)} className="w-full px-4 py-2 border rounded-lg" placeholder="Separar por vírgula" />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Descrição</label>
            <textarea required rows={2} value={description} onChange={e => setDescription(e.target.value)} className="w-full px-4 py-2 border rounded-lg resize-none" />
          </div>

          {/* Adicionais */}
          <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
            <h3 className="text-sm font-bold text-gray-800 mb-3 flex items-center justify-between">
              <span className="flex items-center gap-2"><Plus size={16} className="text-orange-600"/> Adicionais Permitidos</span>
            </h3>
            
            <div className="flex gap-2 mb-4">
              <input value={newAddonName} onChange={e => setNewAddonName(e.target.value)} placeholder="Novo: Bacon" className="flex-1 px-3 py-1.5 text-xs border rounded-lg" />
              <input value={newAddonPrice} onChange={e => setNewAddonPrice(e.target.value)} placeholder="Preço" className="w-20 px-3 py-1.5 text-xs border rounded-lg" />
              <button type="button" onClick={handleQuickAddonCreate} disabled={creatingAddon || !newAddonName} className="bg-orange-600 text-white p-1.5 rounded-lg disabled:opacity-50"><Save size={16} /></button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-h-40 overflow-y-auto custom-scrollbar">
              {allAddons.map(addon => (
                <label key={addon.id} className={`flex items-center gap-2 p-2 border rounded-lg cursor-pointer transition-all ${selectedAddonIds.includes(addon.id) ? 'bg-orange-100 border-orange-300' : 'bg-white border-gray-200'}`}>
                  <input type="checkbox" className="rounded text-orange-600 focus:ring-orange-500" checked={selectedAddonIds.includes(addon.id)} onChange={() => toggleAddonSelection(addon.id)} />
                  <span className="text-xs font-medium text-gray-700 truncate">{addon.name}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-gray-100">
            <button type="button" onClick={onClose} className="px-6 py-2 text-gray-600 hover:bg-gray-100 rounded-lg font-medium">Cancelar</button>
            <button type="submit" disabled={loading} className="px-6 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium flex items-center gap-2 disabled:opacity-50">
              {loading ? <Loader2 className="animate-spin" size={18} /> : <CheckCircle size={18} />} Salvar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}