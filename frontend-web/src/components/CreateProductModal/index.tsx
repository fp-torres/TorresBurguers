import { useState, useRef, useEffect } from 'react';
import type { ChangeEvent, SyntheticEvent } from 'react'; 
import { X, Upload, Loader2, CheckCircle, Plus, Trash2, Edit2, Check } from 'lucide-react';
import { productService, type Addon, type Product } from '../../services/productService';
import toast from 'react-hot-toast';
import ConfirmModal from '../ConfirmModal'; 
import { normalizeCurrency, currencyToNumber } from '../../utils/masks'; // <--- IMPORT NOVO

interface CreateProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  productToEdit?: Product | null; 
}

const ADDON_CATEGORIES = [
  { id: 'todos', label: 'Todos' },
  { id: 'geral', label: 'Geral' },
  { id: 'hamburgueres', label: 'Hambúrgueres' },
  { id: 'bebidas', label: 'Bebidas' },
  { id: 'sobremesas', label: 'Sobremesas' },
  { id: 'acompanhamentos', label: 'Acompanhamentos' },
];

export default function CreateProductModal({ isOpen, onClose, onSuccess, productToEdit }: CreateProductModalProps) {
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState(''); // Agora armazena string formatada (R$)
  const [category, setCategory] = useState('hamburgueres');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [ingredientsText, setIngredientsText] = useState('');
  
  const [allAddons, setAllAddons] = useState<Addon[]>([]);
  const [selectedAddonIds, setSelectedAddonIds] = useState<number[]>([]);
  const [addonTab, setAddonTab] = useState('todos');
  
  const [newAddonName, setNewAddonName] = useState('');
  const [newAddonPrice, setNewAddonPrice] = useState('');
  const [creatingAddon, setCreatingAddon] = useState(false);

  const [editingAddonId, setEditingAddonId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editPrice, setEditPrice] = useState('');

  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [addonToDelete, setAddonToDelete] = useState<number | null>(null);

  useEffect(() => {
    if (isOpen) {
      loadAddons();
      if (productToEdit) {
        setName(productToEdit.name);
        setDescription(productToEdit.description);
        // Formata o preço vindo do banco (number -> R$ string)
        setPrice(normalizeCurrency(productToEdit.price));
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

        if (ADDON_CATEGORIES.some(c => c.id === productToEdit.category)) {
          setAddonTab(productToEdit.category);
        }
      } else {
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

  // --- Handlers de Input com Máscara ---
  
  const handlePriceChange = (e: ChangeEvent<HTMLInputElement>) => {
    setPrice(normalizeCurrency(e.target.value));
  };

  const handleNewAddonPriceChange = (e: ChangeEvent<HTMLInputElement>) => {
    setNewAddonPrice(normalizeCurrency(e.target.value));
  };

  const handleEditPriceChange = (e: ChangeEvent<HTMLInputElement>) => {
    setEditPrice(normalizeCurrency(e.target.value));
  };

  // --- GERENCIAMENTO DE ADICIONAIS ---

  async function handleCreateAddon() {
    if (!newAddonName || !newAddonPrice) return;
    setCreatingAddon(true);
    try {
      const catToSave = addonTab === 'todos' ? 'geral' : addonTab;
      
      const created = await productService.createAddon({ 
        name: newAddonName, 
        price: currencyToNumber(newAddonPrice), // Converte R$ -> number
        category: catToSave
      });
      
      setNewAddonName(''); setNewAddonPrice('');
      await loadAddons();
      setSelectedAddonIds(prev => [...prev, created.id]);
      toast.success('Adicional criado!'); 
    } catch { 
      toast.error('Erro ao criar adicional.'); 
    } finally { 
      setCreatingAddon(false); 
    }
  }

  function requestDeleteAddon(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    setAddonToDelete(id);
    setConfirmDeleteOpen(true);
  }

  async function executeDeleteAddon() {
    if (!addonToDelete) return;
    try {
      await productService.deleteAddon(addonToDelete);
      await loadAddons();
      setSelectedAddonIds(prev => prev.filter(aid => aid !== addonToDelete));
      toast.success('Adicional excluído.');
    } catch { 
      toast.error('Erro ao excluir (pode estar em uso).'); 
    } finally {
      setConfirmDeleteOpen(false);
      setAddonToDelete(null);
    }
  }

  function startEditingAddon(addon: Addon, e: React.MouseEvent) {
    e.stopPropagation();
    setEditingAddonId(addon.id);
    setEditName(addon.name);
    setEditPrice(normalizeCurrency(addon.price));
  }

  async function saveEditAddon(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await productService.updateAddon(id, {
        name: editName,
        price: currencyToNumber(editPrice)
      });
      setEditingAddonId(null);
      await loadAddons();
      toast.success('Atualizado!');
    } catch { toast.error('Erro ao atualizar.'); }
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
      
      // Converte o valor formatado para número float antes de enviar
      formData.append('price', String(currencyToNumber(price))); 
      
      formData.append('category', category.toLowerCase());
      
      if (!productToEdit) formData.append('available', 'true');

      if (ingredientsText.trim()) {
        const list = ingredientsText.split(',').map(i => i.trim()).filter(Boolean);
        list.forEach(ing => formData.append('ingredients', ing));
      }

      if (selectedAddonIds.length > 0) {
        selectedAddonIds.forEach(id => formData.append('allowed_addons_ids', String(id)));
      }

      if (imageFile) {
        formData.append('file', imageFile);
      }

      if (productToEdit) {
        await productService.update(productToEdit.id, formData);
        toast.success('Produto atualizado!');
      } else {
        await productService.create(formData);
        toast.success('Produto criado!');
      }
      
      onSuccess();
      onClose();
      resetForm();

    } catch (error: any) {
      const msg = error.response?.data?.message || 'Erro ao salvar.';
      toast.error(Array.isArray(msg) ? msg[0] : msg);
    } finally {
      setLoading(false);
    }
  }

  function resetForm() {
    setName(''); setDescription(''); setPrice(''); setIngredientsText('');
    setCategory('hamburgueres'); setImageFile(null); setPreview(null); setSelectedAddonIds([]);
    setAddonTab('todos');
  }

  const filteredAddons = allAddons.filter(addon => {
    if (addonTab === 'todos') return true;
    return addon.category === addonTab || (!addon.category && addonTab === 'geral');
  });

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl w-full max-w-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="bg-gray-50 px-6 py-4 border-b border-gray-100 flex justify-between items-center shrink-0">
          <h2 className="text-lg font-bold text-gray-800">{productToEdit ? 'Editar Produto' : 'Novo Produto'}</h2>
          <button onClick={onClose}><X size={24} className="text-gray-400 hover:text-gray-600" /></button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6 overflow-y-auto custom-scrollbar flex-1">
          <div className="flex flex-col md:flex-row gap-6">
            <div className="w-full md:w-1/3">
              <div onClick={() => fileInputRef.current?.click()} className="aspect-square rounded-xl border-2 border-dashed border-gray-300 hover:border-orange-500 cursor-pointer flex flex-col items-center justify-center bg-gray-50 relative group transition-colors">
                {preview ? <img src={preview} className="w-full h-full object-cover rounded-lg" /> : <Upload className="text-gray-400" />}
                <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" accept="image/*" />
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors rounded-lg flex items-center justify-center text-transparent group-hover:text-white font-bold">Alterar Imagem</div>
              </div>
            </div>

            <div className="flex-1 space-y-4">
              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Nome</label>
                <input required value={name} onChange={e => setName(e.target.value)} className="w-full px-4 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none" placeholder="Ex: X-Burguer" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Preço</label>
                  <input required value={price} onChange={handlePriceChange} className="w-full px-4 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none" placeholder="R$ 0,00" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Categoria</label>
                  <select value={category} onChange={e => setCategory(e.target.value)} className="w-full px-4 py-2 border border-gray-200 rounded-lg bg-white focus:ring-2 focus:ring-orange-500 outline-none">
                    <option value="hamburgueres">Hambúrgueres</option>
                    <option value="bebidas">Bebidas</option>
                    <option value="sobremesas">Sobremesas</option>
                    <option value="acompanhamentos">Acompanhamentos</option>
                    <option value="combos">Combos</option>
                    <option value="molhos">Molhos</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Ingredientes</label>
                <input value={ingredientsText} onChange={e => setIngredientsText(e.target.value)} className="w-full px-4 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none" placeholder="Pão, carne, queijo..." />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Descrição</label>
            <textarea required rows={2} value={description} onChange={e => setDescription(e.target.value)} className="w-full px-4 py-2 border border-gray-200 rounded-lg resize-none focus:ring-2 focus:ring-orange-500 outline-none" placeholder="Descrição do produto..." />
          </div>

          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="bg-gray-50 px-4 py-3 border-b border-gray-200 flex flex-col gap-3">
              <div className="flex justify-between items-center">
                 <h3 className="text-sm font-bold text-gray-800 flex items-center gap-2">
                   <Plus size={16} className="text-orange-600"/> Gerenciar Adicionais
                 </h3>
                 <span className="text-xs text-gray-400">Selecione ou crie novos</span>
              </div>
              
              <div className="flex gap-1 overflow-x-auto pb-1 custom-scrollbar">
                {ADDON_CATEGORIES.map(cat => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setAddonTab(cat.id)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-colors ${
                      addonTab === cat.id ? 'bg-orange-100 text-orange-700' : 'text-gray-500 hover:bg-gray-100'
                    }`}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>

              <div className="flex gap-2">
                <input 
                  value={newAddonName} 
                  onChange={e => setNewAddonName(e.target.value)} 
                  placeholder={`Novo item em "${ADDON_CATEGORIES.find(c => c.id === addonTab)?.label}"`} 
                  className="flex-1 px-3 py-1.5 text-xs border border-gray-200 rounded-lg outline-none focus:border-orange-500" 
                />
                <input 
                  value={newAddonPrice} 
                  onChange={handleNewAddonPriceChange} 
                  placeholder="R$ 0,00" 
                  className="w-24 px-3 py-1.5 text-xs border border-gray-200 rounded-lg outline-none focus:border-orange-500" 
                />
                <button 
                  type="button" 
                  onClick={handleCreateAddon} 
                  disabled={creatingAddon || !newAddonName} 
                  className="bg-orange-600 hover:bg-orange-700 text-white px-3 py-1.5 rounded-lg text-xs font-bold disabled:opacity-50 transition-colors"
                >
                  Adicionar
                </button>
              </div>
            </div>

            <div className="max-h-52 overflow-y-auto custom-scrollbar p-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
              {filteredAddons.map(addon => (
                <div 
                  key={addon.id} 
                  onClick={() => toggleAddonSelection(addon.id)}
                  className={`group flex items-center justify-between p-2 border rounded-lg cursor-pointer transition-all select-none ${
                    selectedAddonIds.includes(addon.id) ? 'bg-orange-50 border-orange-200' : 'bg-white border-gray-100 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-center gap-3 flex-1 overflow-hidden">
                    <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                      selectedAddonIds.includes(addon.id) ? 'bg-orange-500 border-orange-500' : 'border-gray-300 bg-white'
                    }`}>
                      {selectedAddonIds.includes(addon.id) && <CheckCircle size={12} className="text-white" />}
                    </div>

                    {editingAddonId === addon.id ? (
                      <div className="flex gap-2 flex-1" onClick={e => e.stopPropagation()}>
                        <input value={editName} onChange={e => setEditName(e.target.value)} className="w-full text-xs px-1 border rounded" autoFocus />
                        <input value={editPrice} onChange={handleEditPriceChange} className="w-16 text-xs px-1 border rounded" />
                      </div>
                    ) : (
                      <div className="flex flex-col truncate">
                         <span className={`text-xs font-bold truncate ${selectedAddonIds.includes(addon.id) ? 'text-orange-700' : 'text-gray-700'}`}>{addon.name}</span>
                         <span className="text-[10px] text-gray-500 font-medium">R$ {Number(addon.price).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-1 pl-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    {editingAddonId === addon.id ? (
                      <button type="button" onClick={(e) => saveEditAddon(addon.id, e)} className="p-1 text-green-600 hover:bg-green-100 rounded">
                        <Check size={14} />
                      </button>
                    ) : (
                      <button type="button" onClick={(e) => startEditingAddon(addon, e)} className="p-1 text-blue-400 hover:text-blue-600 hover:bg-blue-50 rounded">
                        <Edit2 size={14} />
                      </button>
                    )}
                    
                    <button type="button" onClick={(e) => requestDeleteAddon(addon.id, e)} className="p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
              
              {filteredAddons.length === 0 && (
                <div className="col-span-full py-8 text-center text-xs text-gray-400 italic">
                  Nenhum adicional nesta categoria.
                </div>
              )}
            </div>
          </div>
        </form>

        <div className="p-4 bg-gray-50 border-t border-gray-100 flex justify-end gap-3 shrink-0">
            <button type="button" onClick={onClose} className="px-6 py-2 text-gray-600 hover:bg-gray-100 rounded-lg font-bold text-sm transition-colors">Cancelar</button>
            <button onClick={handleSubmit} disabled={loading} className="px-6 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg font-bold text-sm flex items-center gap-2 disabled:opacity-50 transition-colors shadow-lg shadow-green-200">
              {loading ? <Loader2 className="animate-spin" size={18} /> : <CheckCircle size={18} />} 
              {productToEdit ? 'Salvar Alterações' : 'Criar Produto'}
            </button>
        </div>
      </div>

      <ConfirmModal 
        isOpen={confirmDeleteOpen}
        onClose={() => setConfirmDeleteOpen(false)}
        onConfirm={executeDeleteAddon}
        title="Excluir Adicional?"
        message="Esta ação é irreversível. Se houver produtos usando este adicional, ele será removido da lista deles."
        confirmLabel="Sim, Excluir"
        isDestructive
      />
    </div>
  );
}