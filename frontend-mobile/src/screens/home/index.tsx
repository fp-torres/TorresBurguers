import React, { useContext, useEffect, useState, useMemo } from 'react';
import { View, Text, TouchableOpacity, FlatList, Image, ActivityIndicator, Alert, ScrollView, TextInput } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Feather from '@expo/vector-icons/Feather';

import { AuthContext } from '../../contexts/AuthContext';
import { CartContext } from '../../contexts/CartContext'; 
import { ThemeContext } from '../../contexts/ThemeContext'; 
import api from '../../services/api';
import { AppStackParamList } from '../../routes/app.routes'; 
import Footer from '../../components/Footer';

// =================================================================
// 🎛️ PAINEL DE SIMULAÇÃO MOBILE
// =================================================================
const TEST_DAY: number | null = null; // 0 (Dom) a 6 (Sáb). Coloque null para dia atual.
const FORCE_GAME_DAY = false; 
// =================================================================

const DAILY_OFFERS: Record<number, any> = {
  0: { title: "Domingo em Família", subtitle: "Combos gigantes para o fim de semana.", image: "https://images.unsplash.com/photo-1594212699903-ec8a3eca50f5?q=80&w=800&auto=format&fit=crop", icon: "shopping-bag", isClosed: false },
  1: { title: "Loja Fechada", subtitle: "Segunda é dia de pausa! Recarregando energias.", image: "https://images.unsplash.com/photo-1559339352-11d035aa65de?q=80&w=800&auto=format&fit=crop", icon: "lock", isClosed: true },
  2: { title: "Terça do Smash", subtitle: "O verdadeiro sabor da chapa. Smashs a partir de R$ 19,90.", image: "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?q=80&w=800&auto=format&fit=crop", icon: "zap", isClosed: false },
  3: { title: "Quarta do Delivery", subtitle: "Entrega por nossa conta! Peça em casa.", image: "https://images.unsplash.com/photo-1550989460-0adf9ea622e2?q=80&w=800&auto=format&fit=crop", icon: "truck", isClosed: false },
  4: { title: "Quinta da Batata", subtitle: "Comprou burger, a batata sai pela metade do preço.", image: "https://images.unsplash.com/photo-1541592106381-b31e9677c0e5?q=80&w=800&auto=format&fit=crop", icon: "star", isClosed: false },
  5: { title: "Sextou com Bacon", subtitle: "Tudo fica melhor com bacon. Adicionais em dobro!", image: "https://images.unsplash.com/photo-1607013251379-e6eecfffe234?q=80&w=800&auto=format&fit=crop", icon: "zap", isClosed: false }, 
  6: { title: "Sabadou com Torres", subtitle: "Chame os amigos! Balde + Combo Monster.", image: "https://images.unsplash.com/photo-1598182198871-d3f4ab4fd181?q=80&w=800&auto=format&fit=crop", icon: "coffee", isClosed: false }
};

const CATEGORIES = [
  { id: 'combos', label: 'Combos', icon: '🍟' },
  { id: 'hamburgueres', label: 'Lanches', icon: '🍔' },
  { id: 'entradas', label: 'Entradas', icon: '🧅' },
  { id: 'acompanhamentos', label: 'Porções', icon: '🥓' },
  { id: 'bebidas', label: 'Bebidas', icon: '🥤' },
  { id: 'sobremesas', label: 'Sobremesas', icon: '🍦' },
  { id: 'molhos', label: 'Molhos', icon: '🥣' },
  { id: 'todos', label: 'Todos', icon: '⭐' },
];

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

export default function Home() {
  const { user } = useContext(AuthContext) as any;
  const { cart, totalCartValue } = useContext(CartContext); 
  const { themeMode, activeTheme, cycleTheme } = useContext(ThemeContext);
  
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();

  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  
  const [banner, setBanner] = useState<any>(DAILY_OFFERS[0]);
  const [activeCategory, setActiveCategory] = useState('combos'); 
  const [searchTerm, setSearchTerm] = useState('');
  
  const [visibleCount, setVisibleCount] = useState(6);

  // Estado para o Admin controlar abertura/fechamento da loja
  const [isStoreOpen, setIsStoreOpen] = useState(true); 

  useEffect(() => {
    fetchProducts();
    loadBanner();
    // Aqui futuramente você pode colocar a chamada da API para checar se a loja está aberta:
    // fetchStoreStatus();
  }, []);

  useEffect(() => {
    setVisibleCount(6);
  }, [activeCategory, searchTerm]);

  async function loadBanner() {
    const todayIndex = TEST_DAY !== null ? TEST_DAY : new Date().getDay();
    let currentBanner = DAILY_OFFERS[todayIndex] || DAILY_OFFERS[0];
    
    if ((todayIndex === 3 || todayIndex === 0) && !currentBanner.isClosed) {
      if (FORCE_GAME_DAY) {
         currentBanner = {
            title: "Hoje tem Jogão! ⚽",
            subtitle: `SIMULAÇÃO: Flamengo x Vasco às 21:30 - Brasileirão.`,
            image: "https://images.unsplash.com/photo-1574629810360-7efbbe195018?q=80&w=800&auto=format&fit=crop", 
            icon: "award",
            isClosed: false
         };
      } else {
        try {
          const { data } = await api.get('/promotions/football');
          if (data && data.hasGame) {
            currentBanner = {
              title: "Hoje tem Jogão! ⚽",
              subtitle: `${data.home} x ${data.away} às ${data.time} - ${data.tournament}.`,
              image: "https://images.unsplash.com/photo-1574629810360-7efbbe195018?q=80&w=800&auto=format&fit=crop", 
              icon: "award",
              isClosed: false
            };
          }
        } catch (error) {
          // Sem jogo hoje
        }
      }
    }
    setBanner(currentBanner);
  }

  async function fetchProducts() {
    try {
      const response = await api.get('/products');
      const availableProducts = response.data.filter((p: Product) => p.available);
      setProducts(availableProducts);
    } catch (error) {
      console.error('Erro ao buscar produtos:', error);
    } finally {
      setLoading(false);
    }
  }

  const handleProductPress = (productId: number) => {
    // Validação usando o status da loja e do banner
    if (banner.isClosed || !isStoreOpen) {
      Alert.alert("Loja Fechada", "Nossa loja está fechada no momento. Volte mais tarde!");
      return;
    }
    navigation.navigate('ProductDetails', { product_id: productId });
  };

  const formatPrice = (price: number) => Number(price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  const getImageUrl = (imagePath: string | null | undefined) => {
    if (!imagePath) return 'https://via.placeholder.com/100?text=Sem+Foto';
    let cleanPath = imagePath.replace(/^\//, ''); 
    if (!cleanPath.startsWith('uploads/')) cleanPath = `uploads/${cleanPath}`;
    const base = api.defaults.baseURL?.replace(/\/$/, '') || '';
    return `${base}/${cleanPath}`;
  };

  const getThemeIcon = () => {
    if (themeMode === 'system') return 'smartphone';
    return themeMode === 'dark' ? 'moon' : 'sun';
  };

  const comboProducts = useMemo(() => products.filter(p => p.category === 'combos'), [products]);
  const promoProducts = useMemo(() => products.filter(p => Number(p.price) < 30 && p.category === 'hamburgueres'), [products]);

  const mainList = products.filter(product => {
    if (searchTerm.trim() !== '') {
      return product.name.toLowerCase().includes(searchTerm.toLowerCase());
    }
    return activeCategory === 'todos' || product.category === activeCategory;
  });

  const displayedList = mainList.slice(0, visibleCount);

  const renderHorizontalCard = (product: Product, isPromo = false) => (
    <TouchableOpacity 
      key={product.id}
      onPress={() => handleProductPress(product.id)}
      disabled={banner.isClosed || !isStoreOpen}
      className={`w-64 bg-white dark:bg-slate-800 p-4 rounded-3xl mr-4 border border-gray-100 dark:border-slate-700 shadow-sm overflow-hidden
        ${banner.isClosed || !isStoreOpen ? 'opacity-80' : 'active:scale-95'}
      `}
    >
      {isPromo && (
        <View className="absolute top-0 right-0 bg-red-600 px-3 py-1 rounded-bl-2xl z-10">
          <Text className="text-white text-[10px] font-bold">OFERTA</Text>
        </View>
      )}
      <View className="h-32 bg-gray-50 dark:bg-slate-900 rounded-2xl mb-4 overflow-hidden relative">
        <Image source={{ uri: getImageUrl(product.image) }} className="w-full h-full" resizeMode="cover" />
        {(banner.isClosed || !isStoreOpen) && <View className="absolute inset-0 bg-black/40" />}
      </View>
      
      <Text className="font-bold text-gray-800 dark:text-white text-lg mb-1" numberOfLines={1}>{product.name}</Text>
      <Text className="text-xs text-gray-500 dark:text-gray-400 mb-3" numberOfLines={1}>{product.description}</Text>
      
      <View className="flex-row justify-between items-center mt-auto">
        <Text className="font-extrabold text-lg text-gray-900 dark:text-gray-100">
          {formatPrice(product.promotion_price || product.price)}
        </Text>
        <View className={`px-4 py-2 rounded-xl ${banner.isClosed || !isStoreOpen ? 'bg-gray-300 dark:bg-slate-700' : 'bg-slate-900 dark:bg-orange-600'}`}>
          <Text className={`text-xs font-bold ${banner.isClosed || !isStoreOpen ? 'text-gray-500 dark:text-gray-400' : 'text-white'}`}>
            {banner.isClosed || !isStoreOpen ? 'Fechado' : 'Add'}
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );

  const renderVerticalCard = ({ item }: { item: Product }) => (
    <TouchableOpacity 
      onPress={() => handleProductPress(item.id)}
      disabled={banner.isClosed || !isStoreOpen}
      className={`bg-white dark:bg-slate-800 p-4 rounded-3xl mb-4 flex-row items-center border border-gray-100 dark:border-slate-700 shadow-sm
        ${banner.isClosed || !isStoreOpen ? 'opacity-70 grayscale' : 'active:scale-95'}
      `}
    >
      <View className="w-24 h-24 rounded-2xl bg-gray-100 dark:bg-slate-900 overflow-hidden relative">
        <Image source={{ uri: getImageUrl(item.image) }} className="w-full h-full" resizeMode="cover" />
        {(banner.isClosed || !isStoreOpen) && <View className="absolute inset-0 bg-black/50" />}
      </View>
      
      <View className="flex-1 ml-4 justify-center">
        <Text className="text-slate-900 dark:text-white font-bold text-lg" numberOfLines={1}>{item.name}</Text>
        <Text className="text-slate-500 dark:text-slate-400 text-xs mt-1 mb-2 leading-4" numberOfLines={2}>{item.description}</Text>
        
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center">
            {item.promotion_price ? (
              <>
                <Text className="text-orange-500 font-bold text-lg mr-2">{formatPrice(item.promotion_price)}</Text>
                <Text className="text-slate-400 text-xs line-through">{formatPrice(item.price)}</Text>
              </>
            ) : (
              <Text className="text-slate-900 dark:text-white font-bold text-lg">{formatPrice(item.price)}</Text>
            )}
          </View>
          
          <View className={`w-8 h-8 rounded-full items-center justify-center ${banner.isClosed || !isStoreOpen ? 'bg-gray-200 dark:bg-slate-700' : 'bg-orange-100 dark:bg-orange-600/20'}`}>
            <Feather name="plus" size={16} color={banner.isClosed || !isStoreOpen ? '#9ca3af' : '#ea580c'} />
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );

  const listHeaderComponent = (
    <View>
      {/* 1. Header Fixo Superior */}
      <View className="flex-row justify-between items-start px-6 mb-6">
        <View>
          <View className="flex-row items-center mb-1">
            <Text className="text-2xl font-bold text-slate-900 dark:text-white mr-2">
              Torres<Text className="text-orange-500">Burgers</Text>
            </Text>
            {/* ÍCONE DE STATUS DA LOJA */}
            <View className={`p-1.5 rounded-full ${isStoreOpen ? 'bg-green-100 dark:bg-green-900/30' : 'bg-red-100 dark:bg-red-900/30'}`}>
              <Feather name={isStoreOpen ? 'unlock' : 'lock'} size={14} color={isStoreOpen ? '#16a34a' : '#ef4444'} />
            </View>
          </View>
          <Text className="text-base text-slate-600 dark:text-slate-400">
            {user ? `E aí, ${user.name.split(' ')[0]}! 👋` : 'Bem-vindo(a) visitante! 🍔'}
          </Text>
        </View>
        
        <View className="flex-row items-center">
          <TouchableOpacity onPress={cycleTheme} className="mr-3 p-2 bg-gray-200 dark:bg-slate-800 rounded-full border border-gray-300 dark:border-slate-700 active:scale-95">
            <Feather name={getThemeIcon() as any} size={18} color={activeTheme === 'dark' ? '#fbbf24' : '#475569'} />
          </TouchableOpacity>
          {user ? (
            <TouchableOpacity onPress={() => navigation.navigate('Profile')} className="w-10 h-10 rounded-full bg-orange-600 border-2 border-orange-200 dark:border-slate-700 justify-center items-center">
              {user.avatar ? <Image source={{ uri: getImageUrl(user.avatar) }} className="w-full h-full rounded-full" /> : <Text className="text-white font-bold text-lg">{user.name.charAt(0)}</Text>}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity onPress={() => navigation.navigate('Welcome')} className="bg-orange-600 px-4 py-2 rounded-lg active:scale-95 shadow-md">
              <Text className="text-white font-bold text-sm">Entrar</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* 2. Banner do Dia (Design Melhorado com Bloco Escuro para Leitura) */}
      <View className="px-6 mb-8">
        <View className="w-full h-64 rounded-3xl overflow-hidden shadow-xl relative bg-slate-900">
          <Image source={{ uri: banner.image }} className="absolute inset-0 w-full h-full" resizeMode="cover" />
          
          {/* Fundo escuro leve para não estourar a imagem superior */}
          <View className={`absolute inset-0 ${banner.isClosed ? 'bg-black/60' : 'bg-black/20'}`} />
          
          {/* Bloco Sólido na Base garantindo 100% de leitura do texto */}
          <View className="absolute bottom-0 w-full bg-black/80 px-5 py-4">
            <View className={`self-start px-3 py-1 rounded-full mb-2 flex-row items-center ${banner.isClosed ? 'bg-red-600' : 'bg-orange-600'}`}>
              <Feather name={banner.isClosed ? 'lock' : 'clock'} size={12} color="#fff" />
              <Text className="text-white text-[10px] font-bold ml-1.5 uppercase tracking-wider">
                {banner.isClosed ? 'LOJA FECHADA' : 'OFERTA DE HOJE'}
              </Text>
            </View>
            <Text className="text-2xl font-extrabold text-white mb-1 leading-tight">{banner.title}</Text>
            <Text className="text-sm text-gray-200 font-medium leading-relaxed" numberOfLines={2}>{banner.subtitle}</Text>
          </View>
        </View>
      </View>

      {/* 3. Barra de Pesquisa */}
      <View className="px-6 mb-8">
        <View className="flex-row items-center bg-white dark:bg-slate-800 rounded-2xl px-4 py-1 shadow-sm border border-gray-100 dark:border-slate-700">
          <Feather name="search" size={20} color="#f97316" />
          <TextInput 
            placeholder="O que você quer comer hoje?"
            placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
            className="flex-1 py-4 ml-3 text-slate-900 dark:text-white text-base"
            value={searchTerm}
            onChangeText={setSearchTerm}
          />
        </View>
      </View>

      {/* 4. Vitrines Horizontais */}
      {!searchTerm && (
        <>
          {activeCategory === 'todos' && comboProducts.length > 0 && (
            <View className="mb-8">
              <View className="flex-row items-center px-6 mb-4">
                <Feather name="shopping-bag" size={20} color="#ea580c" />
                <Text className="text-xl font-bold text-slate-900 dark:text-white ml-2">Combos Matadores</Text>
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 24 }}>
                {comboProducts.map(p => renderHorizontalCard(p))}
              </ScrollView>
            </View>
          )}

          {promoProducts.length > 0 && (
            <View className="mb-8">
              <View className="flex-row items-center px-6 mb-4">
                <Feather name="zap" size={20} color="#ef4444" />
                <Text className="text-xl font-bold text-slate-900 dark:text-white ml-2">Imperdíveis</Text>
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 24 }}>
                {promoProducts.map(p => renderHorizontalCard(p, true))}
              </ScrollView>
            </View>
          )}
        </>
      )}

      {/* 5. Categorias */}
      <View className="mb-6">
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 24 }}>
          {CATEGORIES.map((cat) => (
            <TouchableOpacity
              key={cat.id}
              onPress={() => setActiveCategory(cat.id)}
              className={`flex-row items-center px-5 py-2.5 rounded-full mr-3 border transition-colors ${
                activeCategory === cat.id 
                  ? 'bg-slate-900 dark:bg-orange-600 border-slate-900 dark:border-orange-600' 
                  : 'bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700'
              }`}
            >
              <Text className="text-sm mr-2">{cat.icon}</Text>
              <Text className={`font-bold ${activeCategory === cat.id ? 'text-white' : 'text-slate-600 dark:text-slate-400'}`}>
                {cat.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    </View>
  );

  const listFooterComponent = (
    <View>
      {visibleCount < mainList.length && (
        <TouchableOpacity 
          className="mx-6 mb-8 py-3 border border-orange-200 dark:border-slate-700 bg-orange-50/50 dark:bg-slate-800 rounded-xl items-center flex-row justify-center active:scale-95"
          onPress={() => setVisibleCount(prev => prev + 6)}
        >
          <Text className="text-orange-600 dark:text-orange-400 font-bold mr-2">Ver mais produtos</Text>
          <Feather name="chevron-down" size={16} color={activeTheme === 'dark' ? '#fb923c' : '#ea580c'} />
        </TouchableOpacity>
      )}

      {!loading && mainList.length === 0 && (
         <View className="items-center py-10 px-6">
           <Feather name="inbox" size={48} color={activeTheme === 'dark' ? '#334155' : '#cbd5e1'} />
           <Text className="text-slate-500 dark:text-slate-400 text-center mt-4 text-base">
             Nenhum produto encontrado nesta busca ou categoria.
           </Text>
         </View>
      )}

      <Footer />
      {cart.length > 0 && <View className="h-24" />}
    </View>
  );

  return (
    <View className="flex-1 bg-gray-50 dark:bg-slate-900 pt-14">
      {loading ? (
        <View className="flex-1 justify-center items-center">
          <ActivityIndicator size="large" color="#f97316" />
        </View>
      ) : (
        <FlatList
          data={displayedList} 
          keyExtractor={(item) => String(item.id)}
          renderItem={renderVerticalCard}
          ListHeaderComponent={listHeaderComponent} 
          ListFooterComponent={listFooterComponent}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 20 }}
          style={{ paddingHorizontal: 0 }} 
          keyboardShouldPersistTaps="handled" 
        />
      )}

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
          <Text className="text-white font-bold text-xl">{formatPrice(totalCartValue)}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}