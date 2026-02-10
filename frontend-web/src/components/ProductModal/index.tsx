import { useState, useEffect } from 'react';
import { X, Minus, Plus, ChefHat, Info } from 'lucide-react';

// Importando tipos corretamente
import type { Product } from '../../services/productService';
import { useCart, type Addon } from '../../contexts/CartContext'; 

interface ProductModalProps {
  product: Product | null;
  isOpen: boolean;
  onClose: () => void;
  // REMOVIDO: onSuccess não é necessário aqui, pois este é o modal de compra
}

export default function ProductModal({ product, isOpen, onClose }: ProductModalProps) {
  const { addToCart } = useCart();
  
  const [quantity, setQuantity] = useState(1);
  const [observation, setObservation] = useState('');
  const [meatPoint, setMeatPoint] = useState('Ao Ponto');
  const [selectedAddons, setSelectedAddons] = useState<Addon[]>([]);
  const [removedIngredients, setRemovedIngredients] = useState<string[]>([]);

  // Reinicia o estado sempre que abre o modal
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

  // Usa os adicionais do produto ou um array vazio se não tiver
  // (Removi o mock fixo para evitar confusão se o produto não tiver adicionais)
  const availableAddons: Addon[] = product.allowed_addons || []; 

  // Mock temporário apenas se quiser testar visualmente sem backend pronto:
  // const availableAddons: Addon[] = [
  //   { id: 1, name: 'Bacon Extra', price: 4.00 },
  //   { id: 2, name: 'Cheddar', price: 3.50 }
  // ];

  // Ingredientes padrão (usa os do produto ou um mock padrão se vazio)
  const defaultIngredients = product.ingredients && product.ingredients.length > 0 
    ? product.ingredients 
    : ['Alface', 'Tomate', 'Cebola', 'Molho'];

  function toggleAddon(addon: Addon) {
    const isSelected = selectedAddons.find(a => a.id === addon.id);
    if (isSelected) {
      setSelectedAddons(prev => prev.filter(a => a.id !== addon.id));
    } else {
      setSelectedAddons(prev => [...prev, addon]);
    }
  }

  function toggleIngredient(ingredient: string) {
    if (removedIngredients.includes(ingredient)) {
      setRemovedIngredients(prev => prev.filter(i => i !== ingredient));
    } else {
      setRemovedIngredients(prev => [...prev, ingredient]);
    }
  }

  function handleAddToCart() {
    // O "!" garante ao TS que product existe
    addToCart(product!, quantity, observation, selectedAddons, meatPoint, removedIngredients);
    onClose();
  }

  // Cálculo do preço final
  const addonsTotal = selectedAddons.reduce((sum, a) => sum + Number(a.price), 0);
  const finalPrice = (Number(product.price) + addonsTotal) * quantity;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      {/* Overlay Escuro */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      
      {/* Janela do Modal */}
      <div className="relative w-full max-w-2xl bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-200">
        
        <button 
          onClick={onClose} 
          className="absolute top-4 right-4 z-10 bg-white/90 p-2 rounded-full shadow-md hover:bg-gray-100 transition-colors"
        >
          <X size={20} className="text-gray-700" />
        </button>

        {/* Imagem */}
        <div className="h-48 sm:h-64 bg-gray-100 shrink-0">
          {product.image ? (
            <img 
              src={`http://localhost:3000/uploads/${product.image}`} 
              alt={product.name} 
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-gray-400 bg-gray-200">
              <ChefHat size={48} />
            </div>
          )}
        </div>

        {/* Conteúdo com Scroll */}
        <div className="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
          
          <div>
            <h2 className="text-2xl font-bold text-gray-800">{product.name}</h2>
            <p className="text-gray-500 mt-2 leading-relaxed">{product.description}</p>
            <p className="text-xl font-bold text-green-700 mt-2">
              {Number(product.price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
            </p>
          </div>

          {/* Ponto da Carne (Apenas para Burgers) */}
          {product.category === 'hamburgueres' && (
            <div className="bg-orange-50 p-4 rounded-xl border border-orange-100">
              <h3 className="font-bold text-gray-800 mb-3 flex items-center gap-2">
                <ChefHat size={18} className="text-orange-600"/> Ponto da Carne
              </h3>
              <div className="flex flex-wrap gap-2">
                {['Mal Passado', 'Ao Ponto', 'Bem Passado'].map(point => (
                  <button
                    key={point}
                    onClick={() => setMeatPoint(point)}
                    className={`px-4 py-2 rounded-lg text-sm font-bold border transition-all ${
                      meatPoint === point 
                        ? 'bg-orange-600 text-white border-orange-600 shadow-sm' 
                        : 'bg-white text-gray-600 border-gray-200 hover:border-orange-300'
                    }`}
                  >
                    {point}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Remover Ingredientes */}
          {defaultIngredients.length > 0 && (
            <div>
              <h3 className="font-bold text-gray-800 mb-3">Retirar Ingredientes?</h3>
              <div className="grid grid-cols-2 gap-2">
                {defaultIngredients.map((ing: string) => (
                  <label key={ing} className="flex items-center gap-3 p-3 border rounded-xl cursor-pointer hover:bg-gray-50 transition-colors">
                    <input 
                      type="checkbox" 
                      checked={removedIngredients.includes(ing)}
                      onChange={() => toggleIngredient(ing)}
                      className="w-5 h-5 rounded border-gray-300 text-red-600 focus:ring-red-500"
                    />
                    <span className={`text-sm ${removedIngredients.includes(ing) ? 'text-red-600 font-bold line-through' : 'text-gray-700'}`}>
                      {ing}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Adicionais */}
          {availableAddons.length > 0 && (
            <div>
              <h3 className="font-bold text-gray-800 mb-3">Turbine seu lanche</h3>
              <div className="space-y-2">
                {availableAddons.map(addon => (
                  <div key={addon.id} className="flex items-center justify-between p-3 border border-gray-100 rounded-xl hover:bg-gray-50 transition-colors">
                    <div className="flex items-center gap-3">
                      <input 
                        type="checkbox" 
                        checked={!!selectedAddons.find(a => a.id === addon.id)}
                        onChange={() => toggleAddon(addon)}
                        className="w-5 h-5 rounded border-gray-300 text-green-600 focus:ring-green-500"
                      />
                      <div>
                        <p className="text-sm font-bold text-gray-800">{addon.name}</p>
                        <p className="text-xs text-green-600 font-bold">
                          + {Number(addon.price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Observação */}
          <div>
            <h3 className="font-bold text-gray-800 mb-2 flex items-center gap-2">
              <Info size={16} /> Observação
            </h3>
            <textarea 
              value={observation}
              onChange={e => setObservation(e.target.value)}
              className="w-full p-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none text-sm resize-none"
              placeholder="Ex: Sem sal na batata, capricha no molho..."
              rows={3}
            />
          </div>
        </div>

        {/* Rodapé Fixo */}
        <div className="p-4 bg-white border-t border-gray-100 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 border border-gray-200 rounded-lg p-1">
            <button 
              onClick={() => setQuantity(q => Math.max(1, q - 1))}
              className="p-2 hover:bg-gray-100 rounded-md text-gray-600"
            >
              <Minus size={18} />
            </button>
            <span className="font-bold text-gray-800 w-6 text-center">{quantity}</span>
            <button 
              onClick={() => setQuantity(q => q + 1)}
              className="p-2 hover:bg-gray-100 rounded-md text-orange-600"
            >
              <Plus size={18} />
            </button>
          </div>

          <button 
            onClick={handleAddToCart}
            className="flex-1 bg-orange-600 hover:bg-orange-700 text-white py-3 px-6 rounded-xl font-bold flex justify-between items-center transition-all active:scale-95"
          >
            <span>Adicionar</span>
            <span>{finalPrice.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</span>
          </button>
        </div>

      </div>
    </div>
  );
}