import React, { useState, useEffect, useMemo, useContext, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, TextInput,
  ActivityIndicator, Alert, Modal, KeyboardAvoidingView, RefreshControl,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { productService, Product } from '../../../services/productService';
import { ThemeContext } from '../../../contexts/ThemeContext';
import RemoteImage from '../../../components/RemoteImage';
import { PRODUCT_CATEGORIES, categoryLabel, FeatherIconName } from '../../../utils/catalog';
import { formatPrice, parseMoney } from '../../../utils/format';
import { getErrorMessage, getErrorStatus } from '../../../utils/errors';

const TABS: { id: string; label: string; icon: FeatherIconName }[] = [
  { id: 'todos', label: 'Todos', icon: 'grid' },
  ...PRODUCT_CATEGORIES.map(({ id, label, icon }) => ({ id, label, icon })),
  { id: 'lixeira', label: 'Lixeira', icon: 'trash-2' },
];

const DEFAULT_CATEGORY = 'hamburgueres';

export default function ProductsView() {
  const { activeTheme } = useContext(ThemeContext);
  const isDark = activeTheme === 'dark';

  const [products, setProducts] = useState<Product[]>([]);
  const [deletedProducts, setDeletedProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState('todos');

  // Controle do Modal de Formulário
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [productToEdit, setProductToEdit] = useState<Product | null>(null);
  const [saving, setSaving] = useState(false);

  // Estados do Formulário
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [category, setCategory] = useState(DEFAULT_CATEGORY);

  const loadData = useCallback(async () => {
    try {
      const [active, trash] = await Promise.all([
        productService.getAll(),
        productService.getTrash().catch(() => [] as Product[]),
      ]);
      setProducts(active);
      setDeletedProducts(trash);
    } catch (error) {
      Alert.alert('Erro', getErrorMessage(error, 'Não foi possível carregar os produtos.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleRefresh() {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }

  // --- AÇÕES DO PRODUTO ---

  async function toggleAvailability(product: Product) {
    const newStatus = !product.available;
    // Atualização otimista
    setProducts(prev => prev.map(p => p.id === product.id ? { ...p, available: newStatus } : p));
    try {
      await productService.update(product.id, { available: newStatus });
    } catch (error) {
      Alert.alert('Erro', getErrorMessage(error, 'Falha ao atualizar o status.'));
      loadData(); // reverte se falhar
    }
  }

  function requestDelete(product: Product) {
    Alert.alert(
      'Mover para Lixeira?',
      `"${product.name}" deixará de aparecer no cardápio.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Mover', style: 'destructive', onPress: async () => {
            try {
              await productService.remove(product.id);
              loadData();
            } catch (error) {
              Alert.alert('Erro', getErrorMessage(error, 'Não foi possível mover para a lixeira.'));
            }
          }
        }
      ]
    );
  }

  function requestRestore(product: Product) {
    Alert.alert(
      'Restaurar Produto?',
      `"${product.name}" voltará para o cardápio.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Restaurar', onPress: async () => {
            try {
              await productService.restore(product.id);
              loadData();
            } catch (error) {
              Alert.alert('Erro', getErrorMessage(error, 'Não foi possível restaurar.'));
            }
          }
        }
      ]
    );
  }

  function requestPermanentDelete(product: Product) {
    Alert.alert(
      'Excluir Permanentemente?',
      `ATENÇÃO: "${product.name}" será apagado para sempre.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Apagar', style: 'destructive', onPress: async () => {
            try {
              await productService.removePermanently(product.id);
              loadData();
            } catch (error) {
              if (getErrorStatus(error) === 409) {
                // Produto já vendido: o histórico dos pedidos depende dele
                Alert.alert(
                  'Produto com pedidos',
                  `"${product.name}" aparece em pedidos já realizados e não pode ser excluído definitivamente. Ele continua na lixeira, fora do cardápio.`
                );
              } else {
                Alert.alert('Erro', getErrorMessage(error, 'Não foi possível excluir.'));
              }
            }
          }
        }
      ]
    );
  }

  // --- FORMULÁRIO ---

  function openCreateModal() {
    setProductToEdit(null);
    setName(''); setDescription(''); setPrice('');
    setCategory(activeTab !== 'todos' && activeTab !== 'lixeira' ? activeTab : DEFAULT_CATEGORY);
    setIsModalOpen(true);
  }

  function openEditModal(product: Product) {
    setProductToEdit(product);
    setName(product.name);
    setDescription(product.description ?? '');
    setPrice(String(product.price ?? '').replace('.', ','));
    setCategory(PRODUCT_CATEGORIES.some((c) => c.id === product.category) ? product.category : DEFAULT_CATEGORY);
    setIsModalOpen(true);
  }

  function closeModal() {
    if (!saving) setIsModalOpen(false);
  }

  async function handleSave() {
    // Aceita "29,90", "29.90" ou "R$ 29,90"
    const numericPrice = parseMoney(price);

    if (!name.trim() || !price.trim()) {
      Alert.alert('Atenção', 'Preencha o nome e o preço do produto.');
      return;
    }
    if (!/\d/.test(price) || numericPrice < 0) {
      Alert.alert('Preço inválido', 'Informe um valor como 29,90.');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        price: numericPrice.toFixed(2),
        category,
      };

      if (productToEdit) {
        await productService.update(productToEdit.id, payload);
      } else {
        await productService.create(payload);
      }

      setIsModalOpen(false);
      loadData();
    } catch (error) {
      Alert.alert('Erro', getErrorMessage(error, 'Não foi possível salvar o produto.'));
    } finally {
      setSaving(false);
    }
  }

  // --- FILTROS ---

  const currentList = activeTab === 'lixeira' ? deletedProducts : products;

  const filteredList = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return currentList.filter(p => {
      const matchesSearch = p.name.toLowerCase().includes(term);
      if (activeTab === 'lixeira') return matchesSearch;
      const matchesCategory = activeTab === 'todos' || p.category === activeTab;
      return matchesSearch && matchesCategory;
    });
  }, [currentList, searchTerm, activeTab]);

  const countFor = (tabId: string) => {
    if (tabId === 'lixeira') return deletedProducts.length;
    if (tabId === 'todos') return products.length;
    return products.filter((p) => p.category === tabId).length;
  };

  const inputClass = 'bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl px-4 py-3 text-gray-800 dark:text-white';
  const placeholderColor = isDark ? '#64748b' : '#9ca3af';

  return (
    <View className="flex-1">

      {/* HEADER E BUSCA FIXOS */}
      <View className="px-4 py-4 bg-white dark:bg-slate-800 border-b border-gray-100 dark:border-slate-700">
        <View className="flex-row justify-between items-center mb-4">
          <View>
            <Text className="text-xl font-bold text-gray-800 dark:text-white">Cardápio</Text>
            <Text className="text-xs text-gray-500 dark:text-gray-400">Gerencie produtos e estoque</Text>
          </View>
          {activeTab !== 'lixeira' && (
            <TouchableOpacity onPress={openCreateModal} className="bg-orange-600 px-4 py-2 rounded-xl flex-row items-center active:scale-95 shadow-sm shadow-orange-600/30">
              <Feather name="plus" size={16} color="#fff" />
              <Text className="text-white font-bold ml-1 text-sm">Novo</Text>
            </TouchableOpacity>
          )}
        </View>

        <View className="flex-row items-center bg-gray-50 dark:bg-slate-900 rounded-xl px-3 py-2 border border-gray-100 dark:border-slate-700">
          <Feather name="search" size={18} color={placeholderColor} />
          <TextInput
            placeholder={activeTab === 'lixeira' ? "Buscar na lixeira..." : "Buscar produto..."}
            placeholderTextColor={placeholderColor}
            className="flex-1 ml-2 text-gray-800 dark:text-white text-sm py-1"
            value={searchTerm}
            onChangeText={setSearchTerm}
          />
        </View>
      </View>

      {/* CATEGORIAS HORIZONTAIS */}
      <View className="border-b border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-800">
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 12 }}>
          {TABS.map((tab) => (
            <TouchableOpacity
              key={tab.id}
              onPress={() => setActiveTab(tab.id)}
              className={`flex-row items-center px-4 py-2 rounded-xl mr-2 border ${
                activeTab === tab.id
                  ? 'bg-orange-50 dark:bg-orange-900/30 border-orange-200 dark:border-orange-800'
                  : 'bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700'
              }`}
            >
              <Feather name={tab.icon} size={14} color={activeTab === tab.id ? '#ea580c' : (isDark ? '#94a3b8' : '#64748b')} />
              <Text className={`ml-2 text-sm font-bold ${activeTab === tab.id ? 'text-orange-600 dark:text-orange-500' : 'text-gray-500 dark:text-gray-400'}`}>
                {tab.label} ({countFor(tab.id)})
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* LISTA DE PRODUTOS */}
      <ScrollView
        className="flex-1 px-4 pt-4"
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#f97316" colors={['#f97316']} />}
      >
        {loading ? (
          <ActivityIndicator size="large" color="#ea580c" className="mt-10" />
        ) : filteredList.length === 0 ? (
          <Text className="text-center text-gray-500 dark:text-gray-400 mt-10">
            {activeTab === 'lixeira' ? 'A lixeira está vazia.' : 'Nenhum produto encontrado.'}
          </Text>
        ) : (
          filteredList.map(product => (
            <View key={product.id} className={`bg-white dark:bg-slate-800 rounded-2xl p-3 mb-4 flex-row border border-gray-100 dark:border-slate-700 shadow-sm ${(!product.available || activeTab === 'lixeira') ? 'opacity-70' : ''}`}>

              <View className="w-20 h-20 rounded-xl bg-gray-100 dark:bg-slate-900 overflow-hidden mr-3">
                <RemoteImage path={product.image} className="w-full h-full" />
              </View>

              <View className="flex-1 justify-center">
                <View className="flex-row justify-between items-start">
                  <Text className="font-bold text-gray-800 dark:text-white text-base flex-1" numberOfLines={1}>{product.name}</Text>
                  {activeTab !== 'lixeira' && (
                    <Text className="font-bold text-orange-600 dark:text-orange-400 text-sm">{formatPrice(product.price)}</Text>
                  )}
                </View>

                {activeTab !== 'lixeira' && (
                  <Text className="text-[10px] font-bold text-blue-500 bg-blue-50 dark:bg-blue-900/30 self-start px-2 py-0.5 rounded uppercase mt-1">
                    {categoryLabel(product.category)}
                  </Text>
                )}

                <View className="flex-row justify-between items-center mt-auto pt-2">
                  {/* BOTÕES DE STATUS E AÇÕES */}
                  {activeTab === 'lixeira' ? (
                    <View className="flex-row items-center w-full justify-between">
                      <Text className="font-bold text-gray-500">{formatPrice(product.price)}</Text>
                      <View className="flex-row">
                        <TouchableOpacity
                          onPress={() => requestRestore(product)}
                          accessibilityRole="button"
                          accessibilityLabel={`Restaurar ${product.name}`}
                          className="p-2 bg-green-50 dark:bg-green-900/20 rounded-lg mr-2"
                        >
                          <Feather name="rotate-ccw" size={16} color="#16a34a" />
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => requestPermanentDelete(product)}
                          accessibilityRole="button"
                          accessibilityLabel={`Excluir ${product.name} permanentemente`}
                          className="p-2 bg-red-50 dark:bg-red-900/20 rounded-lg"
                        >
                          <Feather name="x-circle" size={16} color="#ef4444" />
                        </TouchableOpacity>
                      </View>
                    </View>
                  ) : (
                    <>
                      <TouchableOpacity
                        onPress={() => toggleAvailability(product)}
                        className={`flex-row items-center px-2 py-1 rounded-lg border ${product.available ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'}`}
                      >
                        <Feather name={product.available ? 'check-circle' : 'alert-triangle'} size={12} color={product.available ? '#16a34a' : '#ef4444'} />
                        <Text className={`text-[10px] font-bold ml-1 ${product.available ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
                          {product.available ? 'Disponível' : 'Esgotado'}
                        </Text>
                      </TouchableOpacity>

                      <View className="flex-row items-center">
                        <TouchableOpacity
                          onPress={() => openEditModal(product)}
                          accessibilityRole="button"
                          accessibilityLabel={`Editar ${product.name}`}
                          className="p-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg mr-2"
                        >
                          <Feather name="edit-2" size={14} color="#3b82f6" />
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => requestDelete(product)}
                          accessibilityRole="button"
                          accessibilityLabel={`Mover ${product.name} para a lixeira`}
                          className="p-2 bg-red-50 dark:bg-red-900/20 rounded-lg"
                        >
                          <Feather name="trash-2" size={14} color="#ef4444" />
                        </TouchableOpacity>
                      </View>
                    </>
                  )}
                </View>

              </View>
            </View>
          ))
        )}
        <View className="h-20" />
      </ScrollView>

      {/* MODAL DE CRIAR/EDITAR (o botão voltar do Android fecha via onRequestClose) */}
      <Modal visible={isModalOpen} animationType="slide" transparent onRequestClose={closeModal}>
        {/* "padding" nas duas plataformas: o "height" não encolhe o flex-1 do NativeWind (ver KeyboardAwareScreen) */}
        <KeyboardAvoidingView behavior="padding" className="flex-1 justify-end bg-black/50">
          <View className="bg-white dark:bg-slate-900 rounded-t-3xl p-6 h-[85%]">
            <View className="flex-row justify-between items-center mb-6">
              <Text className="text-xl font-bold text-gray-800 dark:text-white">{productToEdit ? 'Editar Produto' : 'Novo Produto'}</Text>
              <TouchableOpacity onPress={closeModal} accessibilityRole="button" accessibilityLabel="Fechar">
                <Feather name="x" size={24} color={isDark ? '#94a3b8' : '#64748b'} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <View className="mb-4">
                <Text className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-1">Nome do Produto</Text>
                <TextInput value={name} onChangeText={setName} maxLength={100} className={inputClass} placeholder="Ex: X-Bacon da Casa" placeholderTextColor={placeholderColor} />
              </View>

              <View className="mb-4">
                <Text className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-1">Preço (R$)</Text>
                <TextInput value={price} onChangeText={setPrice} keyboardType="decimal-pad" className={inputClass} placeholder="29,90" placeholderTextColor={placeholderColor} />
              </View>

              <View className="mb-4">
                <Text className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-2">Categoria</Text>
                <View className="flex-row flex-wrap">
                  {PRODUCT_CATEGORIES.map((option) => {
                    const selected = category === option.id;
                    return (
                      <TouchableOpacity
                        key={option.id}
                        onPress={() => setCategory(option.id)}
                        className={`flex-row items-center px-3 py-2 rounded-xl mr-2 mb-2 border ${selected ? 'bg-orange-50 dark:bg-orange-900/30 border-orange-300 dark:border-orange-700' : 'bg-gray-50 dark:bg-slate-800 border-gray-200 dark:border-slate-700'}`}
                      >
                        <Text className="mr-1">{option.emoji}</Text>
                        <Text className={`text-sm font-bold ${selected ? 'text-orange-600 dark:text-orange-400' : 'text-gray-600 dark:text-gray-300'}`}>{option.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              <View className="mb-8">
                <Text className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-1">Descrição</Text>
                <TextInput value={description} onChangeText={setDescription} multiline numberOfLines={3} className={`${inputClass} h-24`} placeholder="Ingredientes..." placeholderTextColor={placeholderColor} style={{ textAlignVertical: 'top' }} />
              </View>

              <Text className="text-xs text-gray-400 dark:text-gray-500 mb-4">
                Foto, ingredientes e adicionais permitidos são editados pelo painel web.
              </Text>

              <TouchableOpacity onPress={handleSave} disabled={saving} className="bg-orange-600 py-4 rounded-xl items-center shadow-sm shadow-orange-600/30 mb-8">
                {saving ? <ActivityIndicator color="#fff" /> : <Text className="text-white font-bold text-lg">Salvar Produto</Text>}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

    </View>
  );
}
