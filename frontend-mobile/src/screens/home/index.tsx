import React, { useContext, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, Image, ActivityIndicator, Alert, ScrollView } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Feather from '@expo/vector-icons/Feather';

import { AuthContext } from '../../contexts/AuthContext';
import { CartContext } from '../../contexts/CartContext'; 
// AQUI: Importamos o nosso contexto de Tema
import { ThemeContext } from '../../contexts/ThemeContext'; 
import api from '../../services/api';
import { AppStackParamList } from '../../routes/app.routes'; 

interface Product {
  id: number;
  name: string;
  description: string;
  price: number;
  promotion_price: number | null;
  image: string | null;
  category: string;
  available: boolean;
}

const CATEGORIES = [
  { id: 'todos', label: 'Todos', icon: '🍔' },
  { id: 'combos', label: 'Combos', icon: '🍟' },
  { id: 'hamburgueres', label: 'Lanches', icon: '🍔' },
  { id: 'entradas', label: 'Entradas', icon: '🧅' },
  { id: 'acompanhamentos', label: 'Porções', icon: '🥓' },
  { id: 'bebidas', label: 'Bebidas', icon: '🥤' },
  { id: 'sobremesas', label: 'Sobremesas', icon: '🍦' },
  { id: 'molhos', label: 'Molhos', icon: '🥣' },
];

export default function Home() {
  const { signOut, user } = useContext(AuthContext);
  const { cart, totalCartValue } = useContext(CartContext); 
  // Consumindo o Tema atual e a função de trocar
  const { theme, toggleTheme } = useContext(ThemeContext);
  
  const [products, setProducts] = useState<Product[]>([]);
  const [filteredProducts, setFilteredProducts] = useState<Product[]>([]);
  const [activeCategory, setActiveCategory] = useState('todos');
  const [loading, setLoading] = useState(true);
  
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();

  useEffect(() => {
    fetchProducts();
  }, []);

  useEffect(() => {
    if (activeCategory === 'todos') {
      setFilteredProducts(products);
    } else {
      setFilteredProducts(products.filter(item => item.category === activeCategory));
    }
  }, [activeCategory, products]);

  async function fetchProducts() {
    try {
      const response = await api.get('/products');
      const availableProducts = response.data.filter((p: Product) => p.available);
      setProducts(availableProducts);
      setFilteredProducts(availableProducts);
    } catch (error) {
      console.error('Erro ao buscar produtos:', error);
      Alert.alert('Erro', 'Não foi possível carregar o cardápio.');
    } finally {
      setLoading(false);
    }
  }

  const formatPrice = (price: number) => {
    return Number(price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };

  const getImageUrl = (imagePath: string | null) => {
    if (!imagePath) return 'https://via.placeholder.com/100?text=Sem+Foto';
    
    let cleanPath = imagePath.replace(/^\//, ''); 
    if (!cleanPath.startsWith('uploads/')) {
      cleanPath = `uploads/${cleanPath}`;
    }
    
    const base = api.defaults.baseURL?.replace(/\/$/, '') || '';
    return `${base}/${cleanPath}`;
  };

  const renderProduct = ({ item }: { item: Product }) => (
    <TouchableOpacity 
      // Repare como usamos bg-white para Light Mode e dark:bg-slate-800 para Dark Mode
      className="bg-white dark:bg-slate-800 p-4 rounded-2xl mb-4 flex-row items-center shadow-sm dark:shadow-md border border-gray-100 dark:border-transparent active:scale-95"
      onPress={() => navigation.navigate('ProductDetails', { product_id: item.id })}
    >
      <Image 
        source={{ uri: getImageUrl(item.image) }} 
        className="w-24 h-24 rounded-xl bg-gray-200 dark:bg-slate-700"
        resizeMode="cover"
      />
      
      <View className="flex-1 ml-4 justify-center">
        <Text className="text-slate-900 dark:text-white font-bold text-lg" numberOfLines={1}>
          {item.name}
        </Text>
        <Text className="text-slate-500 dark:text-slate-400 text-sm mt-1 mb-2" numberOfLines={2}>
          {item.description}
        </Text>
        
        <View className="flex-row items-center">
          {item.promotion_price ? (
            <>
              <Text className="text-orange-500 font-bold text-lg mr-2">
                {formatPrice(item.promotion_price)}
              </Text>
              <Text className="text-slate-400 dark:text-slate-500 text-sm line-through">
                {formatPrice(item.price)}
              </Text>
            </>
          ) : (
            <Text className="text-orange-500 font-bold text-lg">
              {formatPrice(item.price)}
            </Text>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );

  return (
    // Fundo principal: cinza bem clarinho no Light, slate-900 no Dark
    <View className="flex-1 bg-gray-50 dark:bg-slate-900 pt-16">
      
      {/* HEADER */}
      <View className="flex-row justify-between items-start px-6 mb-6">
        <View>
          <Text className="text-2xl font-bold text-slate-900 dark:text-white">
            Torres<Text className="text-orange-500">Burgers</Text>
          </Text>
          
          {user ? (
            <Text className="text-lg text-slate-600 dark:text-slate-300 mt-1">
              E aí, <Text className="text-orange-500 font-bold">{user.name.split(' ')[0]}</Text>! 👋
            </Text>
          ) : (
            <Text className="text-lg text-slate-600 dark:text-slate-300 mt-1">
              Bem-vindo(a) visitante! 🍔
            </Text>
          )}
        </View>

        {/* Lado Direito do Header: Botão de Tema + Botão de Login */}
        <View className="flex-row items-center">
          {/* BOTÃO DE TROCAR TEMA */}
          <TouchableOpacity 
            onPress={toggleTheme}
            className="mr-3 p-2 bg-gray-200 dark:bg-slate-800 rounded-full border border-gray-300 dark:border-slate-700 active:scale-95"
          >
            <Feather 
              name={theme === 'dark' ? 'sun' : 'moon'} 
              size={20} 
              color={theme === 'dark' ? '#fbbf24' : '#475569'} 
            />
          </TouchableOpacity>

          {user ? (
            <TouchableOpacity 
              onPress={signOut}
              className="bg-white dark:bg-slate-800 px-4 py-2 rounded-lg border border-gray-200 dark:border-slate-700 active:scale-95"
            >
              <Text className="text-red-500 dark:text-red-400 font-bold text-sm">Sair</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity 
              onPress={() => navigation.navigate('Welcome')}
              className="bg-orange-600 px-5 py-2 rounded-lg active:scale-95 shadow-md"
            >
              <Text className="text-white font-bold text-sm">Entrar</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* FILTROS HORIZONTAIS */}
      <View className="mb-6">
        <ScrollView 
          horizontal 
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 24 }}
        >
          {CATEGORIES.map((cat) => (
            <TouchableOpacity
              key={cat.id}
              onPress={() => setActiveCategory(cat.id)}
              className={`flex-row items-center px-4 py-2 rounded-full mr-3 border ${
                activeCategory === cat.id 
                  ? 'bg-orange-600 border-orange-600' 
                  : 'bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700'
              }`}
            >
              <Text className="text-base mr-2">{cat.icon}</Text>
              <Text className={`font-bold ${
                activeCategory === cat.id 
                  ? 'text-white' 
                  : 'text-slate-600 dark:text-slate-300'
              }`}>
                {cat.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      <Text className="text-xl font-bold text-slate-900 dark:text-white px-6 mb-4">
        {activeCategory === 'todos' ? 'Nosso Cardápio' : CATEGORIES.find(c => c.id === activeCategory)?.label}
      </Text>

      {/* LISTA DE PRODUTOS */}
      {loading ? (
        <View className="flex-1 justify-center items-center">
          <ActivityIndicator size="large" color="#f97316" />
        </View>
      ) : (
        <FlatList
          data={filteredProducts}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderProduct}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: cart.length > 0 ? 120 : 20 }}
          ListEmptyComponent={
            <View className="items-center mt-10">
              <Text className="text-4xl mb-2">🍽️</Text>
              <Text className="text-slate-500 dark:text-slate-400 text-center">
                Nenhum produto encontrado nesta categoria.
              </Text>
            </View>
          }
        />
      )}

      {/* BOTÃO FLUTUANTE DO CARRINHO */}
      {cart.length > 0 && (
        <TouchableOpacity 
          className="absolute bottom-6 left-6 right-6 bg-orange-600 p-4 rounded-2xl flex-row justify-between items-center shadow-lg shadow-orange-600/30 active:scale-95"
          onPress={() => navigation.navigate('Cart')}
        >
          <View className="flex-row items-center">
            <View className="bg-orange-800 w-8 h-8 rounded-full items-center justify-center mr-3">
              <Text className="text-white font-bold">{cart.length}</Text>
            </View>
            <Text className="text-white font-bold text-lg">Ver Carrinho</Text>
          </View>
          
          <Text className="text-white font-bold text-xl">
            {formatPrice(totalCartValue)}
          </Text>
        </TouchableOpacity>
      )}

    </View>
  );
}