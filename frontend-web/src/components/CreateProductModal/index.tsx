import { useState, useRef, useEffect, useCallback, useId } from 'react';
import type { ChangeEvent, FormEvent, MouseEvent } from 'react';
import { Upload, Loader2, CheckCircle, Plus, Trash2, Edit2, Check } from 'lucide-react';
import { productService, type Addon, type Product } from '../../services/productService';
import { assetUrl, getApiErrorMessage } from '../../services/api';
import { planRestrictionMessage } from '../../services/storeSubscriptionService';
import { toastPlanLimit } from '../../layouts/DefaultLayout/planLimit';
import toast from 'react-hot-toast';
import ConfirmModal from '../ConfirmModal';
import { Modal, buttonClass, fieldControlClass } from '../ui';
import { normalizeCurrency, currencyToNumber } from '../../utils/masks';
import { MAX_PRICE, PRODUCT_CATEGORIES, toMoneyInput } from '../../utils/catalog';
import { formatCurrency } from '../../utils/format';

interface CreateProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  productToEdit?: Product | null;
  /** 403 do plano ao criar (limite de produtos): a tela mostra o aviso com o atalho para a Assinatura. */
  onLimitReached?: (message: string) => void;
}

// Agrupamento dos adicionais (texto livre na API): "geral" e as categorias do cardápio que usam adicionais
const ADDON_CATEGORIES = [
  { id: 'todos', label: 'Todos' },
  { id: 'geral', label: 'Geral' },
  { id: 'hamburgueres', label: 'Hambúrgueres' },
  { id: 'bebidas', label: 'Bebidas' },
  { id: 'sobremesas', label: 'Sobremesas' },
  { id: 'acompanhamentos', label: 'Acompanhamentos' },
];

// Mesmas regras da API para a imagem do produto
const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const LABEL_CLASS = 'block text-xs font-bold text-gray-700 dark:text-gray-300 uppercase mb-1';
const SMALL_INPUT_CLASS = 'px-3 py-1.5 text-xs border border-gray-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-orange-500 focus:border-orange-500 bg-white dark:bg-slate-800 text-gray-900 dark:text-white';

export default function CreateProductModal({ isOpen, onClose, onSuccess, productToEdit, onLimitReached }: CreateProductModalProps) {
  if (!isOpen) return null;
  // Cada abertura monta o formulário do zero (sem imagem ou campos de uma edição anterior)
  return (
    <ProductForm
      key={productToEdit?.id ?? 'novo'}
      productToEdit={productToEdit ?? null}
      onClose={onClose}
      onSuccess={onSuccess}
      onLimitReached={onLimitReached}
    />
  );
}

interface ProductFormProps {
  productToEdit: Product | null;
  onClose: () => void;
  onSuccess: () => void;
  onLimitReached?: (message: string) => void;
}

function ProductForm({ productToEdit, onClose, onSuccess, onLimitReached }: ProductFormProps) {
  const formId = useId();
  const imageInputId = useId();
  const nameId = useId();
  const priceId = useId();
  const categoryId = useId();
  const promotionId = useId();
  const ingredientsId = useId();
  const descriptionId = useId();
  const [loading, setLoading] = useState(false);
  const objectUrlRef = useRef<string | null>(null);

  const [name, setName] = useState(productToEdit?.name ?? '');
  const [description, setDescription] = useState(productToEdit?.description ?? '');
  const [price, setPrice] = useState(toMoneyInput(productToEdit?.price));
  const [promotionPrice, setPromotionPrice] = useState(toMoneyInput(productToEdit?.promotion_price));
  const [category, setCategory] = useState(productToEdit?.category ?? 'hamburgueres');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(assetUrl(productToEdit?.image) ?? null);
  const [ingredientsText, setIngredientsText] = useState(productToEdit?.ingredients?.join(', ') ?? '');

  const [allAddons, setAllAddons] = useState<Addon[]>([]);
  const [addonsError, setAddonsError] = useState<string | null>(null);
  const [selectedAddonIds, setSelectedAddonIds] = useState<number[]>(productToEdit?.allowed_addons?.map(a => a.id) ?? []);
  // Na edição, a aba de adicionais começa na categoria do produto (se existir)
  const [addonTab, setAddonTab] = useState(
    productToEdit && ADDON_CATEGORIES.some(c => c.id === productToEdit.category) ? productToEdit.category : 'todos',
  );

  const [newAddonName, setNewAddonName] = useState('');
  const [newAddonPrice, setNewAddonPrice] = useState('');
  const [creatingAddon, setCreatingAddon] = useState(false);

  const [editingAddonId, setEditingAddonId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editPrice, setEditPrice] = useState('');

  const [addonToDelete, setAddonToDelete] = useState<Addon | null>(null);
  const [deletingAddon, setDeletingAddon] = useState(false);

  const loadAddons = useCallback(async () => {
    try {
      const data = await productService.getAllAddons();
      setAllAddons(Array.isArray(data) ? data : []);
      setAddonsError(null);
    } catch (error) {
      setAddonsError(getApiErrorMessage(error, 'Erro ao carregar os adicionais.'));
    }
  }, []);

  useEffect(() => {
    void loadAddons();
  }, [loadAddons]);

  // Libera a pré-visualização local da imagem ao fechar
  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
  }, []);

  function handleRestricted(error: unknown, fallback: string) {
    const planMessage = planRestrictionMessage(error);
    if (planMessage) {
      toastPlanLimit(planMessage);
      onLimitReached?.(planMessage);
    } else {
      toast.error(getApiErrorMessage(error, fallback), { duration: 6000 });
    }
  }

  async function handleCreateAddon() {
    if (!newAddonName.trim()) return;
    if (!newAddonPrice) {
      toast.error('Informe o preço do adicional (pode ser R$ 0,00).');
      return;
    }
    setCreatingAddon(true);
    try {
      const catToSave = addonTab === 'todos' ? 'geral' : addonTab;

      const created = await productService.createAddon({
        name: newAddonName.trim(),
        price: currencyToNumber(newAddonPrice),
        category: catToSave
      });

      setNewAddonName(''); setNewAddonPrice('');
      await loadAddons();
      setSelectedAddonIds(prev => (prev.includes(created.id) ? prev : [...prev, created.id]));
      toast.success('Adicional criado!');
    } catch (error) {
      handleRestricted(error, 'Erro ao criar adicional.');
    } finally {
      setCreatingAddon(false);
    }
  }

  function requestDeleteAddon(addon: Addon, e: MouseEvent) {
    e.stopPropagation();
    setAddonToDelete(addon);
  }

  async function executeDeleteAddon() {
    if (!addonToDelete) return;
    const id = addonToDelete.id;
    setDeletingAddon(true);
    try {
      await productService.deleteAddon(id);
      await loadAddons();
      setSelectedAddonIds(prev => prev.filter(aid => aid !== id));
      toast.success('Adicional excluído.');
      setAddonToDelete(null);
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Erro ao excluir o adicional.'));
    } finally {
      setDeletingAddon(false);
    }
  }

  function startEditingAddon(addon: Addon, e: MouseEvent) {
    e.stopPropagation();
    setEditingAddonId(addon.id);
    setEditName(addon.name);
    setEditPrice(toMoneyInput(addon.price));
  }

  async function saveEditAddon(id: number, e: MouseEvent) {
    e.stopPropagation();
    if (!editName.trim() || !editPrice) {
      toast.error('Informe o nome e o preço do adicional.');
      return;
    }
    try {
      await productService.updateAddon(id, {
        name: editName.trim(),
        price: currencyToNumber(editPrice)
      });
      setEditingAddonId(null);
      await loadAddons();
      toast.success('Atualizado!');
    } catch (error) { toast.error(getApiErrorMessage(error, 'Erro ao atualizar.')); }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ''; // permite escolher o mesmo arquivo de novo
    if (!file) return;

    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      toast.error('Use uma imagem JPG, PNG ou WebP.');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast.error('Imagem muito grande! O limite é 5MB.');
      return;
    }

    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = URL.createObjectURL(file);
    setImageFile(file);
    setPreview(objectUrlRef.current);
  }

  function toggleAddonSelection(id: number) {
    setSelectedAddonIds(prev => prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (loading) return;

    const trimmedName = name.trim();
    if (!trimmedName) { toast.error('Informe o nome do produto.'); return; }
    if (!price) { toast.error('Informe o preço do produto.'); return; }

    const priceValue = currencyToNumber(price);
    if (priceValue > MAX_PRICE) { toast.error('O preço máximo é R$ 99.999.999,99.'); return; }
    // Promocional vazio ou R$ 0,00 = sem promoção (a API também trata zero como "sem promoção")
    const typedPromotion = promotionPrice ? currencyToNumber(promotionPrice) : 0;
    const promotionValue = typedPromotion > 0 ? typedPromotion : null;
    if (promotionValue !== null && promotionValue >= priceValue) {
      toast.error('O preço promocional deve ser menor que o preço normal.');
      return;
    }

    setLoading(true);
    try {
      // Multipart com os nomes de campo do DTO de produto da API (imagem no campo "file")
      const formData = new FormData();
      formData.append('name', trimmedName);
      formData.append('description', description.trim());
      formData.append('price', String(priceValue));
      formData.append('category', category);
      // Promoção: na edição, vazio remove o preço promocional
      if (promotionValue !== null) formData.append('promotion_price', String(promotionValue));
      else if (productToEdit) formData.append('promotion_price', '');

      if (!productToEdit) formData.append('available', 'true');

      // Listas: um campo por item. Lista vazia vai como campo vazio, o que limpa a lista na edição.
      const ingredients = ingredientsText.split(',').map(i => i.trim()).filter(Boolean);
      if (ingredients.length > 0) ingredients.forEach(ing => formData.append('ingredients', ing));
      else formData.append('ingredients', '');

      if (selectedAddonIds.length > 0) selectedAddonIds.forEach(id => formData.append('allowed_addons_ids', String(id)));
      else formData.append('allowed_addons_ids', '');

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
    } catch (error) {
      // 403 = limite de produtos do plano (ou loja sem permissão de alterar o cardápio)
      handleRestricted(error, 'Erro ao salvar o produto.');
    } finally {
      setLoading(false);
    }
  }

  const filteredAddons = allAddons.filter(addon => {
    if (addonTab === 'todos') return true;
    return addon.category === addonTab || (!addon.category && addonTab === 'geral');
  });

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={productToEdit ? 'Editar Produto' : 'Novo Produto'}
      dismissible={!loading}
      closeOnOverlayClick={false}
      footer={(
        <>
          <button type="button" onClick={onClose} disabled={loading} className={buttonClass('ghost')}>Cancelar</button>
          {/* Fora do <form>, ligado a ele pelo atributo form: o "required" dos campos é respeitado */}
          <button type="submit" form={formId} disabled={loading} className="px-6 py-2.5 bg-green-600 hover:bg-green-700 text-white rounded-xl font-bold text-sm inline-flex items-center justify-center gap-2 disabled:opacity-50 transition-colors shadow-lg shadow-green-200 dark:shadow-none focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900">
            {loading ? <Loader2 className="animate-spin" size={18} aria-hidden="true" /> : <CheckCircle size={18} aria-hidden="true" />}
            {productToEdit ? 'Salvar Alterações' : 'Criar Produto'}
          </button>
        </>
      )}
    >
      <form id={formId} onSubmit={handleSubmit} className="space-y-6">
        <div className="flex flex-col md:flex-row gap-6">

          {/* Upload Imagem: campo de arquivo visualmente oculto (mas focável) atrás de um rótulo clicável */}
          <div className="w-full md:w-1/3 relative">
            <input
              id={imageInputId}
              type="file"
              onChange={handleFileChange}
              className="sr-only peer"
              accept={ACCEPTED_IMAGE_TYPES.join(',')}
            />
            <label
              htmlFor={imageInputId}
              className="aspect-square rounded-xl border-2 border-dashed border-gray-300 dark:border-slate-700 hover:border-orange-500 dark:hover:border-orange-500 peer-focus-visible:border-orange-500 peer-focus-visible:ring-2 peer-focus-visible:ring-orange-500 cursor-pointer flex flex-col items-center justify-center bg-gray-50 dark:bg-slate-800 relative group transition-colors"
            >
              {preview ? <img src={preview} alt="Imagem do produto" className="w-full h-full object-cover rounded-lg" /> : <Upload className="text-gray-400 dark:text-gray-500" aria-hidden="true" />}
              <span className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors rounded-lg flex items-center justify-center text-transparent group-hover:text-white font-bold">Alterar Imagem</span>
            </label>
            <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-2 text-center">JPG, PNG ou WebP até 5MB</p>
          </div>

          {/* Campos principais (rótulo seguido do campo) */}
          <div className="flex-1 space-y-4">
            <div>
              <label htmlFor={nameId} className={LABEL_CLASS}>Nome</label>
              <input id={nameId} required maxLength={100} value={name} onChange={e => setName(e.target.value)} className={fieldControlClass()} placeholder="Ex: X-Burguer" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor={priceId} className={LABEL_CLASS}>Preço</label>
                <input id={priceId} required inputMode="numeric" value={price} onChange={e => setPrice(normalizeCurrency(e.target.value))} className={fieldControlClass()} placeholder="R$ 0,00" />
              </div>
              <div>
                <label htmlFor={categoryId} className={LABEL_CLASS}>Categoria</label>
                <select id={categoryId} value={category} onChange={e => setCategory(e.target.value)} className={fieldControlClass()}>
                  {PRODUCT_CATEGORIES.map(option => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor={promotionId} className={LABEL_CLASS}>Preço Promocional</label>
                <input id={promotionId} inputMode="numeric" value={promotionPrice} onChange={e => setPromotionPrice(normalizeCurrency(e.target.value))} className={fieldControlClass()} placeholder="Opcional" />
              </div>
              <div>
                <label htmlFor={ingredientsId} className={LABEL_CLASS}>Ingredientes</label>
                <input id={ingredientsId} value={ingredientsText} onChange={e => setIngredientsText(e.target.value)} className={fieldControlClass()} placeholder="Pão, carne, queijo..." />
              </div>
            </div>
            <p className="text-[11px] text-gray-500 dark:text-gray-400 -mt-2">
              Preço promocional vazio = sem promoção. Ingredientes separados por vírgula (o cliente pode pedir para retirar).
            </p>
          </div>
        </div>

        <div>
          <label htmlFor={descriptionId} className={LABEL_CLASS}>Descrição</label>
          <textarea id={descriptionId} rows={2} maxLength={1000} value={description} onChange={e => setDescription(e.target.value)} className={fieldControlClass(false, 'resize-none')} placeholder="Descrição do produto..." />
        </div>

        {/* ÁREA DE ADICIONAIS */}
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 shadow-sm overflow-hidden">

          <div className="bg-gray-50 dark:bg-slate-900 px-4 py-3 border-b border-gray-200 dark:border-slate-700 flex flex-col gap-3">
            <div className="flex justify-between items-center gap-2">
               <h3 className="text-sm font-bold text-gray-800 dark:text-white flex items-center gap-2">
                 <Plus size={16} className="text-orange-600 dark:text-orange-400" aria-hidden="true" /> Gerenciar Adicionais
               </h3>
               <span className="text-xs text-gray-500 dark:text-gray-400" aria-live="polite">
                 {selectedAddonIds.length > 0 ? `${selectedAddonIds.length} selecionado(s)` : 'Selecione ou crie novos'}
               </span>
            </div>

            <div className="flex gap-1 overflow-x-auto pb-1 custom-scrollbar" role="group" aria-label="Categorias dos adicionais">
              {ADDON_CATEGORIES.map(cat => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setAddonTab(cat.id)}
                  aria-pressed={addonTab === cat.id}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
                    addonTab === cat.id
                      ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400'
                      : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-800'
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
                maxLength={60}
                aria-label="Nome do novo adicional"
                placeholder={`Novo item em "${ADDON_CATEGORIES.find(c => c.id === addonTab)?.label}"`}
                className={`flex-1 min-w-0 ${SMALL_INPUT_CLASS}`}
              />
              <input
                value={newAddonPrice}
                onChange={e => setNewAddonPrice(normalizeCurrency(e.target.value))}
                inputMode="numeric"
                aria-label="Preço do novo adicional"
                placeholder="R$ 0,00"
                className={`w-24 ${SMALL_INPUT_CLASS}`}
              />
              <button
                type="button"
                onClick={handleCreateAddon}
                disabled={creatingAddon || !newAddonName.trim()}
                className="bg-orange-600 hover:bg-orange-700 text-white px-3 py-1.5 rounded-lg text-xs font-bold disabled:opacity-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-1"
              >
                Adicionar
              </button>
            </div>
          </div>

          {/* Lista de Adicionais: cada item é uma caixa de seleção de verdade (teclado e leitores de tela) */}
          <div className="max-h-52 overflow-y-auto custom-scrollbar p-2 grid grid-cols-1 sm:grid-cols-2 gap-2 bg-white dark:bg-slate-900/20">
            {filteredAddons.map(addon => {
              const isSelected = selectedAddonIds.includes(addon.id);
              const checkbox = (
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleAddonSelection(addon.id)}
                  aria-label={editingAddonId === addon.id ? `Usar o adicional ${addon.name} neste produto` : undefined}
                  className="w-4 h-4 shrink-0 rounded accent-orange-500 cursor-pointer"
                />
              );
              return (
              <div
                key={addon.id}
                className={`group flex items-center justify-between p-2 border rounded-lg transition-all select-none focus-within:ring-2 focus-within:ring-orange-500 ${
                  isSelected
                    ? 'bg-orange-50 dark:bg-orange-900/10 border-orange-200 dark:border-orange-800'
                    : 'bg-white dark:bg-slate-800 border-gray-100 dark:border-slate-700 hover:border-gray-300 dark:hover:border-slate-600'
                }`}
              >
                {editingAddonId === addon.id ? (
                  <div className="flex items-center gap-3 flex-1 overflow-hidden">
                    {checkbox}
                    <div className="flex gap-2 flex-1">
                      <input value={editName} onChange={e => setEditName(e.target.value)} maxLength={60} aria-label="Nome do adicional" className="w-full text-xs px-1 border rounded bg-white dark:bg-slate-900 dark:text-white dark:border-slate-600" autoFocus />
                      <input value={editPrice} onChange={e => setEditPrice(normalizeCurrency(e.target.value))} inputMode="numeric" aria-label="Preço do adicional" className="w-16 text-xs px-1 border rounded bg-white dark:bg-slate-900 dark:text-white dark:border-slate-600" />
                    </div>
                  </div>
                ) : (
                  <label className="flex items-center gap-3 flex-1 overflow-hidden cursor-pointer">
                    {checkbox}
                    <span className="flex flex-col truncate">
                       <span className={`text-xs font-bold truncate ${isSelected ? 'text-orange-700 dark:text-orange-400' : 'text-gray-700 dark:text-gray-300'}`}>{addon.name}</span>
                       <span className="text-[10px] text-gray-500 dark:text-gray-400 font-medium">{formatCurrency(addon.price)}</span>
                    </span>
                  </label>
                )}

                <div className="flex items-center gap-1 pl-2 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                  {editingAddonId === addon.id ? (
                    <button type="button" onClick={(e) => saveEditAddon(addon.id, e)} aria-label={`Salvar o adicional ${addon.name}`} title="Salvar adicional" className="p-1 text-green-600 hover:bg-green-100 dark:hover:bg-green-900/30 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
                      <Check size={14} aria-hidden="true" />
                    </button>
                  ) : (
                    <button type="button" onClick={(e) => startEditingAddon(addon, e)} aria-label={`Editar o adicional ${addon.name}`} title="Editar adicional" className="p-1 text-blue-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
                      <Edit2 size={14} aria-hidden="true" />
                    </button>
                  )}

                  <button type="button" onClick={(e) => requestDeleteAddon(addon, e)} aria-label={`Excluir o adicional ${addon.name}`} title="Excluir adicional" className="p-1 text-gray-500 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              </div>
              );
            })}

            {filteredAddons.length === 0 && (
              <div className="col-span-full py-8 text-center text-xs text-gray-500 dark:text-gray-400">
                {addonsError ? (
                  <span role="alert">
                    {addonsError}{' '}
                    <button type="button" onClick={() => void loadAddons()} className="font-bold text-orange-600 dark:text-orange-400 hover:underline">Tentar novamente</button>
                  </span>
                ) : 'Nenhum adicional nesta categoria.'}
              </div>
            )}
          </div>
        </div>
      </form>

      <ConfirmModal
        isOpen={!!addonToDelete}
        onClose={() => setAddonToDelete(null)}
        onConfirm={executeDeleteAddon}
        closeOnConfirm={false}
        loading={deletingAddon}
        title="Excluir Adicional?"
        message={`"${addonToDelete?.name ?? 'O adicional'}" deixa de aparecer no cardápio e sai de todos os produtos que o oferecem. Adicionais não vão para a Lixeira: a exclusão não pode ser desfeita pelo painel. Os pedidos já feitos continuam com o nome e o preço da época.`}
        confirmLabel="Sim, Excluir"
        isDestructive
      />
    </Modal>
  );
}
