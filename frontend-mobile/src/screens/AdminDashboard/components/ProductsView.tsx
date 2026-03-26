import React, { useState, useEffect, useMemo, useContext } from 'react';
import { 
  View, Text, TouchableOpacity, ScrollView, TextInput, 
  Image, ActivityIndicator, Alert, Modal, KeyboardAvoidingView, Platform 
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import api from '../../../services/api';
import { productService, Product } from '../../../services/productService';
import { ThemeContext } from '../../../contexts/ThemeContext';

const CATEGORIES = [
  { id: 'todos', label: 'Todos', icon: 'grid' },
  { id: 'hamburgueres', label: 'Lanches', icon: 'coffee' }, // Adaptando ícones pro Feather
  { id: 'combos', label: 'Combos', icon: 'box' },
  { id: 'acompanhamentos', label: 'Acomp.', icon: 'hash' },
  { id: 'bebidas', label: 'Bebidas', icon: 'droplet' },
  { id: 'sobremesas', label: 'Sobremesas', icon: 'heart' },
  { id: 'lixeira', label: 'Lixeira', icon: 'trash-2' },
];

export default function ProductsView() {
  const { activeTheme } = useContext(ThemeContext);
  
  const [products, setProducts] = useState<Product[]>([]);
  const [deletedProducts, setDeletedProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  
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
  const [category, setCategory] = useState('hamburgueres');

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    try {
      const data = await productService.getAll();
      setProducts(data);
      
      const trashRes = await api.get('/products/trash').catch(() => ({ data: [] }));
      setDeletedProducts(trashRes.data);
    } catch (error) {
      Alert.alert('Erro', 'Não foi possível carregar os produtos.');
    } finally {
      setLoading(false);
    }
  }

  // --- AÇÕES DO PRODUTO ---

  async function toggleAvailability(product: Product) {
    try {
      const newStatus = !product.available;
      // Atualização otimista
      setProducts(prev => prev.map(p => p.id === product.id ? { ...p, available: newStatus } : p));
      
      // Enviando para API
      const formData = new FormData();
      formData.append('available', String(newStatus));
      await api.patch(`/products/${product.id}`, formData, { headers: { 'Content-Type': 'multipart/form-data' }});
      
    } catch (error) {
      Alert.alert('Erro', 'Falha ao atualizar o status.');
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
              await api.delete(`/products/${product.id}`);
              loadData();
            } catch { Alert.alert('Erro', 'Não foi possível mover para a lixeira.'); }
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
              await api.patch(`/products/${product.id}/restore`);
              loadData();
            } catch { Alert.alert('Erro', 'Não foi possível restaurar.'); }
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
              await api.delete(`/products/${product.id}/permanent`);
              loadData();
            } catch { Alert.alert('Erro', 'Não foi possível excluir.'); }
          } 
        }
      ]
    );
  }

  // --- FORMULÁRIO ---

  function openCreateModal() {
    setProductToEdit(null);
    setName(''); setDescription(''); setPrice(''); setCategory('hamburgueres');
    setIsModalOpen(true);
  }

  function openEditModal(product: Product) {
    setProductToEdit(product);
    setName(product.name);
    setDescription(product.description);
    setPrice(String(product.price));
    setCategory(product.category);
    setIsModalOpen(true);
  }

  async function handleSave() {
    if (!name || !price || !category) {
      Alert.alert('Atenção', 'Preencha os campos obrigatórios.');
      return;
    }

    setSaving(true);
    try {
      const formData = new FormData();
      formData.append('name', name);
      formData.append('description', description);
      formData.append('price', price.replace(',', '.')); // Formata preço
      formData.append('category', category);

      if (productToEdit) {
        await api.patch(`/products/${productToEdit.id}`, formData, { headers: { 'Content-Type': 'multipart/form-data' }});
      } else {
        await api.post('/products', formData, { headers: { 'Content-Type': 'multipart/form-data' }});
      }
      
      setIsModalOpen(false);
      loadData();
    } catch (error) {
      Alert.alert('Erro', 'Não foi possível salvar o produto.');
    } finally {
      setSaving(false);
    }
  }

  // --- FILTROS ---

  const currentList = activeTab === 'lixeira' ? deletedProducts : products;

  const filteredList = useMemo(() => {
    return currentList.filter(p => {
      const matchesSearch = p.name.toLowerCase().includes(searchTerm.toLowerCase());
      if (activeTab === 'lixeira') return matchesSearch;
      const matchesCategory = activeTab === 'todos' || p.category === activeTab;
      return matchesSearch && matchesCategory;
    });
  }, [currentList, searchTerm, activeTab]);

  const getImageUrl = (imagePath: string | null | undefined) => {
    if (!imagePath) return 'https://via.placeholder.com/100?text=Sem+Foto';
    let cleanPath = imagePath.replace(/^\//, ''); 
    if (!cleanPath.startsWith('uploads/')) cleanPath = `uploads/${cleanPath}`;
    const base = api.defaults.baseURL?.replace(/\/$/, '') || '';
    return `${base}/${cleanPath}`;
  };

  const formatPrice = (p: number | string) => Number(p).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

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
          <Feather name="search" size={18} color={activeTheme === 'dark' ? '#64748b' : '#9ca3af'} />
          <TextInput 
            placeholder={activeTab === 'lixeira' ? "Buscar na lixeira..." : "Buscar produto..."} 
            placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
            className="flex-1 ml-2 text-gray-800 dark:text-white text-sm py-1"
            value={searchTerm}
            onChangeText={setSearchTerm}
          />
        </View>
      </View>

      {/* CATEGORIAS HORIZONTAIS */}
      <View className="border-b border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-800">
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 12 }}>
          {CATEGORIES.map((cat) => (
            <TouchableOpacity
              key={cat.id}
              onPress={() => setActiveTab(cat.id)}
              className={`flex-row items-center px-4 py-2 rounded-xl mr-2 border ${
                activeTab === cat.id 
                  ? 'bg-orange-50 dark:bg-orange-900/30 border-orange-200 dark:border-orange-800' 
                  : 'bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700'
              }`}
            >
              <Feather name={cat.icon as any} size={14} color={activeTab === cat.id ? '#ea580c' : (activeTheme === 'dark' ? '#94a3b8' : '#64748b')} />
              <Text className={`ml-2 text-sm font-bold ${activeTab === cat.id ? 'text-orange-600 dark:text-orange-500' : 'text-gray-500 dark:text-gray-400'}`}>
                {cat.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* LISTA DE PRODUTOS */}
      <ScrollView className="flex-1 px-4 pt-4" showsVerticalScrollIndicator={false}>
        {loading ? (
          <ActivityIndicator size="large" color="#ea580c" className="mt-10" />
        ) : filteredList.length === 0 ? (
          <Text className="text-center text-gray-500 dark:text-gray-400 mt-10">Nenhum produto encontrado.</Text>
        ) : (
          filteredList.map(product => (
            <View key={product.id} className={`bg-white dark:bg-slate-800 rounded-2xl p-3 mb-4 flex-row border border-gray-100 dark:border-slate-700 shadow-sm ${(!product.available || activeTab === 'lixeira') ? 'opacity-70' : ''}`}>
              
              <View className="w-20 h-20 rounded-xl bg-gray-100 dark:bg-slate-900 overflow-hidden mr-3">
                <Image source={{ uri: getImageUrl(product.image) }} className={`w-full h-full ${(!product.available || activeTab === 'lixeira') ? 'grayscale' : ''}`} resizeMode="cover" />
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
                    {product.category}
                  </Text>
                )}
                
                <View className="flex-row justify-between items-center mt-auto pt-2">
                  {/* BOTÕES DE STATUS E AÇÕES */}
                  {activeTab === 'lixeira' ? (
                    <View className="flex-row items-center w-full justify-between">
                      <Text className="font-bold text-gray-500">{formatPrice(product.price)}</Text>
                      <View className="flex-row">
                        <TouchableOpacity onPress={() => requestRestore(product)} className="p-2 bg-green-50 dark:bg-green-900/20 rounded-lg mr-2">
                          <Feather name="rotate-ccw" size={16} color="#16a34a" />
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => requestPermanentDelete(product)} className="p-2 bg-red-50 dark:bg-red-900/20 rounded-lg">
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

                      <View className="flex-row items-center gap-2">
                        <TouchableOpacity onPress={() => openEditModal(product)} className="p-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                          <Feather name="edit-2" size={14} color="#3b82f6" />
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => requestDelete(product)} className="p-2 bg-red-50 dark:bg-red-900/20 rounded-lg">
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

      {/* MODAL DE CRIAR/EDITAR (Simplificado para Mobile) */}
      <Modal visible={isModalOpen} animationType="slide" transparent>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} className="flex-1 justify-end bg-black/50">
          <View className="bg-white dark:bg-slate-900 rounded-t-3xl p-6 h-[80%]">
            <View className="flex-row justify-between items-center mb-6">
              <Text className="text-xl font-bold text-gray-800 dark:text-white">{productToEdit ? 'Editar Produto' : 'Novo Produto'}</Text>
              <TouchableOpacity onPress={() => setIsModalOpen(false)}>
                <Feather name="x" size={24} color={activeTheme === 'dark' ? '#94a3b8' : '#64748b'} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} className="space-y-4">
              <View>
                <Text className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-1">Nome do Produto</Text>
                <TextInput value={name} onChangeText={setName} className="bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl px-4 py-3 text-gray-800 dark:text-white" placeholder="Ex: X-Bacon" />
              </View>

              <View>
                <Text className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-1">Preço (R$)</Text>
                <TextInput value={price} onChangeText={setPrice} keyboardType="numeric" className="bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl px-4 py-3 text-gray-800 dark:text-white" placeholder="0.00" />
              </View>

              <View>
                <Text className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-1">Categoria (ID)</Text>
                <TextInput value={category} onChangeText={setCategory} className="bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl px-4 py-3 text-gray-800 dark:text-white" placeholder="hamburgueres, bebidas..." autoCapitalize="none" />
              </View>

              <View className="mb-8">
                <Text className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-1">Descrição</Text>
                <TextInput value={description} onChangeText={setDescription} multiline numberOfLines={3} className="bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl px-4 py-3 text-gray-800 dark:text-white h-24 text-top" placeholder="Ingredientes..." style={{ textAlignVertical: 'top' }} />
              </View>

              <TouchableOpacity onPress={handleSave} disabled={saving} className="bg-orange-600 py-4 rounded-xl items-center shadow-sm shadow-orange-600/30">
                {saving ? <ActivityIndicator color="#fff" /> : <Text className="text-white font-bold text-lg">Salvar Produto</Text>}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

    </View>
  );
}