import { useState, useEffect } from 'react';
import { X, Minus, Plus, ChefHat, Info } from 'lucide-react';
import type { Product } from '../../services/productService';
import { useCart, type Addon } from '../../contexts/CartContext'; 

interface ProductModalProps {
  product: Product | null;
  isOpen: boolean;
  onClose: () => void;
}

export default function ProductModal({ product, isOpen, onClose }: ProductModalProps) {
  const { addToCart } = useCart();
  const [quantity, setQuantity] = useState(1);
  const [observation, setObservation] = useState('');
  const [meatPoint, setMeatPoint] = useState('Ao Ponto');
  const [selectedAddons, setSelectedAddons] = useState<Addon[]>([]);
  const [removedIngredients, setRemovedIngredients] = useState<string[]>([]);

  useEffect(() => {
    if (isOpen) {
      setQuantity(1);
      setObservation('');
      setMeatPoint('Ao Ponto');
      setSelectedAddons([]);
      setRemovedIngredients([]);
    }
  }, [isOpen, product]);

  if (!isOpen || !product) return null;

  // CORREÇÃO: Usa APENAS os dados reais do produto. Se não tiver, lista vazia.
  const availableAddons: Addon[] = product.allowed_addons || [];

  const defaultIngredients = product.ingredients || [];

  function addAddon(addon: Addon) {
    setSelectedAddons(prev => [...prev, addon]);
  }

  function removeAddon(addonId: number) {
    setSelectedAddons(prev => {
      const index = prev.findIndex(a => a.id === addonId);
      if (index === -1) return prev;
      const newArr = [...prev];
      newArr.splice(index, 1);
      return newArr;
    });
  }

  function getAddonQuantity(addonId: number) {
    return selectedAddons.filter(a => a.id === addonId).length;
  }

  function toggleIngredient(ingredient: string) {
    if (removedIngredients.includes(ingredient)) {
      setRemovedIngredients(prev => prev.filter(i => i !== ingredient));
    } else {
      setRemovedIngredients(prev => [...prev, ingredient]);
    }
  }

  function handleAddToCart() {
    addToCart(product!, quantity, observation, selectedAddons, meatPoint, removedIngredients);
    onClose();
  }

  const addonsTotal = selectedAddons.reduce((sum, a) => sum + Number(a.price), 0);
  const finalPrice = (Number(product.price) + addonsTotal) * quantity;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-2xl bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <button onClick={onClose} className="absolute top-4 right-4 z-10 bg-white/90 p-2 rounded-full"><X size={20} /></button>
        
        <div className="h-48 sm:h-64 bg-gray-100 shrink-0">
          {product.image ? (
            <img src={`http://localhost:3000/uploads/${product.image}`} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gray-200"><ChefHat size={48} /></div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-8">
          <div>
            <h2 className="text-2xl font-bold text-gray-800">{product.name}</h2>
            <p className="text-gray-500 mt-2">{product.description}</p>
            <p className="text-xl font-bold text-green-700 mt-2">
              {Number(product.price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
            </p>
          </div>

          {/* Ponto da Carne apenas para Hamburguer */}
          {product.category === 'hamburgueres' && (
            <div className="bg-orange-50 p-4 rounded-xl border border-orange-100">
              <h3 className="font-bold text-gray-800 mb-3 flex items-center gap-2"><ChefHat size={18} className="text-orange-600"/> Ponto da Carne</h3>
              <div className="flex flex-wrap gap-2">
                {['Mal Passado', 'Ao Ponto', 'Bem Passado'].map(point => (
                  <button key={point} onClick={() => setMeatPoint(point)} className={`px-4 py-2 rounded-lg text-sm font-bold border transition-all ${meatPoint === point ? 'bg-orange-600 text-white' : 'bg-white'}`}>{point}</button>
                ))}
              </div>
            </div>
          )}

          {/* Ingredientes para Remover */}
          {defaultIngredients.length > 0 && (
            <div>
              <h3 className="font-bold text-gray-800 mb-3">Retirar Ingredientes?</h3>
              <div className="grid grid-cols-2 gap-2">
                {defaultIngredients.map((ing: string) => (
                  <label key={ing} className="flex items-center gap-3 p-3 border rounded-xl cursor-pointer">
                    <input type="checkbox" checked={removedIngredients.includes(ing)} onChange={() => toggleIngredient(ing)} className="w-5 h-5 rounded text-red-600" />
                    <span className={`text-sm ${removedIngredients.includes(ing) ? 'text-red-600 line-through' : 'text-gray-700'}`}>{ing}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* ADICIONAIS - Só aparece se tiver itens */}
          {availableAddons.length > 0 && (
            <div>
              <h3 className="font-bold text-gray-800 mb-3">Adicionais</h3>
              <div className="space-y-3">
                {availableAddons.map(addon => {
                  const qty = getAddonQuantity(addon.id);
                  return (
                    <div key={addon.id} className={`flex items-center justify-between p-3 border rounded-xl transition-all ${qty > 0 ? 'border-green-500 bg-green-50' : 'border-gray-100'}`}>
                      <div>
                        <p className="font-bold text-gray-800">{addon.name}</p>
                        <p className="text-xs text-green-700 font-bold">+ {Number(addon.price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</p>
                      </div>
                      <div className="flex items-center gap-3 bg-white border rounded-lg p-1">
                        <button onClick={() => removeAddon(addon.id)} disabled={qty === 0} className="p-1.5 hover:bg-gray-100 rounded disabled:opacity-30"><Minus size={14} /></button>
                        <span className="font-bold w-4 text-center">{qty}</span>
                        <button onClick={() => addAddon(addon)} className="p-1.5 hover:bg-gray-100 rounded text-green-600"><Plus size={14} /></button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          <div>
            <h3 className="font-bold text-gray-800 mb-2 flex items-center gap-2"><Info size={16} /> Observação</h3>
            <textarea value={observation} onChange={e => setObservation(e.target.value)} className="w-full p-3 border rounded-xl" rows={3} placeholder="Ex: Sem sal..." />
          </div>
        </div>

        <div className="p-4 bg-white border-t border-gray-100 flex gap-4">
           <div className="flex items-center gap-3 border rounded-lg p-1">
             <button onClick={() => setQuantity(q => Math.max(1, q - 1))} className="p-2"><Minus size={18} /></button>
             <span className="font-bold w-6 text-center">{quantity}</span>
             <button onClick={() => setQuantity(q => q + 1)} className="p-2 text-orange-600"><Plus size={18} /></button>
           </div>
           <button onClick={handleAddToCart} className="flex-1 bg-orange-600 text-white py-3 rounded-xl font-bold flex justify-between px-6">
             <span>Adicionar</span>
             <span>{finalPrice.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</span>
           </button>
        </div>
      </div>
    </div>
  );
}