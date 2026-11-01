import { useId, useRef, useState } from 'react';
import { ChefHat, Info, Lock, Minus, Plus } from 'lucide-react';
import { Modal } from '../ui';
import type { Addon, Product } from '../../services/productService';
import { assetUrl } from '../../services/api';
import { useCart } from '../../contexts/CartContext';
import { useStorefront } from '../../contexts/StorefrontContext';
import {
  DEFAULT_MEAT_POINT, MAX_ADDONS_PER_ITEM, MAX_ITEM_QUANTITY, MAX_OBSERVATION_LENGTH, MEAT_POINTS,
  effectivePrice, hasMeatPoint, hasPromotion,
} from '../../utils/catalog';
import { formatCurrency } from '../../utils/format';

interface ProductModalProps {
  /** Produto com os adicionais já conferidos com a lista atual da loja (cardápio). */
  product: Product | null;
  isOpen: boolean;
  onClose: () => void;
}

/** Personalização do produto e inclusão no carrinho da loja (ponto da carne, ingredientes, adicionais, observação). */
export default function ProductModal({ product, isOpen, onClose }: ProductModalProps) {
  if (!isOpen || !product) return null;
  // Cada abertura monta o conteúdo do zero: quantidade, adicionais e observação começam limpos
  return <ProductModalContent key={product.id} product={product} onClose={onClose} />;
}

function ProductModalContent({ product, onClose }: { product: Product; onClose: () => void }) {
  const { addToCart } = useCart();
  // Status atualizado a cada 30 s: se a loja fechar com o modal aberto, o botão muda sozinho
  const { canOrder, orderingAvailable } = useStorefront();
  const introRef = useRef<HTMLDivElement>(null);
  const observationId = useId();

  const withMeatPoint = hasMeatPoint(product);
  const [quantity, setQuantity] = useState(1);
  const [observation, setObservation] = useState('');
  const [meatPoint, setMeatPoint] = useState(DEFAULT_MEAT_POINT);
  const [selectedAddons, setSelectedAddons] = useState<Addon[]>([]);
  const [removedIngredients, setRemovedIngredients] = useState<string[]>([]);

  // Adicionais pausados no painel não podem ser pedidos (a API recusaria)
  const availableAddons: Addon[] = (product.allowed_addons || []).filter((addon) => addon.available !== false);
  const defaultIngredients = product.ingredients || [];

  // A API aceita até MAX_ADDONS_PER_ITEM adicionais por unidade (somando as repetições)
  const addonsFull = selectedAddons.length >= MAX_ADDONS_PER_ITEM;
  function addAddon(addon: Addon) {
    setSelectedAddons((previous) => (previous.length >= MAX_ADDONS_PER_ITEM ? previous : [...previous, addon]));
  }
  function removeAddon(addonId: number) {
    setSelectedAddons((previous) => {
      const index = previous.findIndex((addon) => addon.id === addonId);
      if (index === -1) return previous;
      return [...previous.slice(0, index), ...previous.slice(index + 1)];
    });
  }
  function getAddonQuantity(addonId: number) {
    return selectedAddons.filter((addon) => addon.id === addonId).length;
  }
  function toggleIngredient(ingredient: string) {
    setRemovedIngredients((previous) => (previous.includes(ingredient)
      ? previous.filter((item) => item !== ingredient)
      : [...previous, ingredient]));
  }
  function handleAddToCart() {
    if (!canOrder) return;
    // Ponto da carne só vai para hambúrgueres
    addToCart(product, quantity, observation, selectedAddons, withMeatPoint ? meatPoint : undefined, removedIngredients);
    onClose();
  }

  const unitPrice = effectivePrice(product);
  const addonsTotal = selectedAddons.reduce((sum, addon) => sum + Number(addon.price), 0);
  const finalPrice = (unitPrice + addonsTotal) * quantity;
  const image = assetUrl(product.image);

  const footer = (
    <div className="w-full flex items-center gap-3">
      <div className="flex items-center gap-2 border border-gray-200 dark:border-slate-700 rounded-xl p-1 bg-white dark:bg-slate-900 shadow-sm shrink-0">
        <button type="button" onClick={() => setQuantity((value) => Math.max(1, value - 1))} aria-label="Diminuir quantidade" className="p-2 text-gray-700 dark:text-white hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg transition-colors"><Minus size={18} aria-hidden="true" /></button>
        <span className="font-bold w-6 text-center text-gray-900 dark:text-white" aria-live="polite">{quantity}</span>
        <button type="button" onClick={() => setQuantity((value) => Math.min(MAX_ITEM_QUANTITY, value + 1))} disabled={quantity >= MAX_ITEM_QUANTITY} aria-label="Aumentar quantidade" className="p-2 text-brand-ink dark:text-brand-ink-dark hover:bg-brand/10 rounded-lg transition-colors disabled:opacity-30"><Plus size={18} aria-hidden="true" /></button>
      </div>
      {canOrder ? (
        <button type="button" onClick={handleAddToCart} className="flex-1 min-w-0 bg-brand hover:bg-brand-hover text-brand-contrast py-3 rounded-xl font-bold flex justify-between gap-3 px-4 sm:px-6 transition-all shadow-lg shadow-black/10 active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900">
          <span>Adicionar</span>
          <span>{formatCurrency(finalPrice)}</span>
        </button>
      ) : (
        <button type="button" disabled className="flex-1 min-w-0 bg-gray-300 dark:bg-slate-700 text-gray-600 dark:text-gray-300 py-3 rounded-xl font-bold flex justify-center items-center gap-2 px-4 cursor-not-allowed">
          <Lock size={18} aria-hidden="true" /> {orderingAvailable ? 'Loja fechada' : 'Pedidos indisponíveis'}
        </button>
      )}
    </div>
  );

  return (
    <Modal open onClose={onClose} title={product.name} size="lg" initialFocusRef={introRef} footer={footer}>
      <div className="space-y-8">
        <div ref={introRef} tabIndex={-1} className="space-y-4 rounded-xl focus:outline-none">
          <div className="h-48 sm:h-64 -mx-6 -mt-6 bg-gray-100 dark:bg-slate-800">
            {image ? (
              <img src={image} alt={product.name} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center"><ChefHat size={48} className="text-gray-400 dark:text-slate-600" aria-hidden="true" /></div>
            )}
          </div>
          {product.description && <p className="text-gray-600 dark:text-gray-400">{product.description}</p>}
          <p className="text-xl font-bold text-gray-900 dark:text-white flex items-baseline gap-2">
            {hasPromotion(product) && (
              <span className="text-sm font-medium text-gray-400 line-through"><span className="sr-only">De </span>{formatCurrency(product.price)}</span>
            )}
            <span className={hasPromotion(product) ? 'text-red-600 dark:text-red-400' : undefined}>
              {hasPromotion(product) && <span className="sr-only">por </span>}{formatCurrency(unitPrice)}
            </span>
          </p>
        </div>

        {/* Ponto da Carne (só hambúrgueres) */}
        {withMeatPoint && (
          <div className="bg-brand/5 dark:bg-brand/10 p-4 rounded-xl border border-brand/20">
            <h3 className="font-bold text-gray-800 dark:text-white mb-3 flex items-center gap-2"><ChefHat size={18} className="text-brand-ink dark:text-brand-ink-dark" aria-hidden="true" />Ponto da Carne</h3>
            <div className="flex flex-wrap gap-2">
              {MEAT_POINTS.map((point) => (
                <button
                  key={point}
                  type="button"
                  onClick={() => setMeatPoint(point)}
                  aria-pressed={meatPoint === point}
                  className={`px-4 py-2 rounded-lg text-sm font-bold border transition-all ${
                    meatPoint === point
                      ? 'bg-brand text-brand-contrast border-brand shadow-md'
                      : 'bg-white dark:bg-slate-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700'
                  }`}
                >
                  {point}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Ingredientes */}
        {defaultIngredients.length > 0 && (
          <div>
            <h3 className="font-bold text-gray-800 dark:text-white mb-3">Retirar Ingredientes?</h3>
            <div className="grid grid-cols-1 min-[400px]:grid-cols-2 gap-2">
              {defaultIngredients.map((ingredient) => (
                <label key={ingredient} className="flex items-center gap-3 p-3 border border-gray-200 dark:border-slate-700 rounded-xl cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors">
                  <input
                    type="checkbox"
                    checked={removedIngredients.includes(ingredient)}
                    onChange={() => toggleIngredient(ingredient)}
                    className="w-5 h-5 rounded text-red-600 bg-gray-100 dark:bg-slate-800 border-gray-300 dark:border-slate-600 focus:ring-red-500"
                  />
                  <span className={`text-sm ${removedIngredients.includes(ingredient) ? 'text-red-600 dark:text-red-400 line-through decoration-red-500' : 'text-gray-700 dark:text-gray-300'}`}>{ingredient}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Adicionais */}
        {availableAddons.length > 0 && (
          <div>
            <h3 className="font-bold text-gray-800 dark:text-white mb-3">Adicionais</h3>
            {addonsFull && (
              <p role="status" className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                Limite de {MAX_ADDONS_PER_ITEM} adicionais por unidade atingido.
              </p>
            )}
            <div className="space-y-3">
              {availableAddons.map((addon) => {
                const qty = getAddonQuantity(addon.id);
                return (
                  <div key={addon.id} className={`flex items-center justify-between gap-3 p-3 border rounded-xl transition-all ${qty > 0 ? 'border-green-500 bg-green-50 dark:bg-green-900/20' : 'border-gray-100 dark:border-slate-700'}`}>
                    <div className="min-w-0">
                      <p className="font-bold text-gray-800 dark:text-gray-200">{addon.name}</p>
                      <p className="text-xs text-green-700 dark:text-green-400 font-bold">+ {formatCurrency(addon.price)}</p>
                    </div>
                    <div className="flex items-center gap-3 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 rounded-lg p-1 shadow-sm shrink-0">
                      <button type="button" onClick={() => removeAddon(addon.id)} disabled={qty === 0} aria-label={`Remover ${addon.name}`} className="p-1.5 hover:bg-gray-100 dark:hover:bg-slate-700 rounded disabled:opacity-30 text-gray-700 dark:text-white transition-colors"><Minus size={14} aria-hidden="true" /></button>
                      <span className="font-bold w-4 text-center text-gray-900 dark:text-white">{qty}</span>
                      <button type="button" onClick={() => addAddon(addon)} disabled={addonsFull} aria-label={`Adicionar ${addon.name}`} className="p-1.5 hover:bg-gray-100 dark:hover:bg-slate-700 rounded text-green-600 dark:text-green-400 transition-colors disabled:opacity-30"><Plus size={14} aria-hidden="true" /></button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div>
          <label htmlFor={observationId} className="font-bold text-gray-800 dark:text-white mb-2 flex items-center gap-2">
            <Info size={16} aria-hidden="true" />Observação
          </label>
          <textarea
            id={observationId}
            value={observation}
            onChange={(event) => setObservation(event.target.value)}
            maxLength={MAX_OBSERVATION_LENGTH}
            className="w-full p-3 border border-gray-200 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-brand outline-none transition-all"
            rows={3}
            placeholder="Ex: Sem sal, capricha no molho..."
          />
          <p className="text-[10px] text-gray-400 text-right mt-1">{observation.length}/{MAX_OBSERVATION_LENGTH}</p>
        </div>
      </div>
    </Modal>
  );
}
