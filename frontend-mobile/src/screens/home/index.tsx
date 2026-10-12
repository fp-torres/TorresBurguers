import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, Image, ActivityIndicator, ScrollView, TextInput, RefreshControl } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';

import { AuthContext } from '../../contexts/AuthContext';
import { CartContext } from '../../contexts/CartContext';
import { ThemeContext } from '../../contexts/ThemeContext';
import { StoreContext } from '../../contexts/StoreContext';
import api from '../../services/api';
import { AppStackParamList } from '../../routes/app.routes';
import Footer from '../../components/Footer';
import BrandWordmark from '../../components/BrandWordmark';
import RemoteImage from '../../components/RemoteImage';
import { PRODUCT_CATEGORIES, effectivePrice, hasPromotion, FeatherIconName } from '../../utils/catalog';
import { firstName, formatPrice } from '../../utils/format';

// Imagens do banner por dia da semana (0 = domingo). Os textos vêm de GET /promotions/banner.
const WEEKDAY_IMAGES = [
  'https://images.unsplash.com/photo-1594212699903-ec8a3eca50f5?q=80&w=800&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?q=80&w=800&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?q=80&w=800&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1550989460-0adf9ea622e2?q=80&w=800&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1541592106381-b31e9677c0e5?q=80&w=800&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1607013251379-e6eecfffe234?q=80&w=800&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1598182198871-d3f4ab4fd181?q=80&w=800&auto=format&fit=crop',
];
const FOOTBALL_IMAGE = 'https://images.unsplash.com/photo-1574629810360-7efbbe195018?q=80&w=800&auto=format&fit=crop';
const CLOSED_IMAGE = 'https://images.unsplash.com/photo-1559339352-11d035aa65de?q=80&w=800&auto=format&fit=crop';

// Sugestões usadas só se a API de promoções não responder. Sem descontos nem cupons:
// o checkout não aplica nada além do preço promocional de cada produto.
const FALLBACK_OFFERS = [
  { title: 'Domingo em Família', subtitle: 'Combos para dividir com quem você gosta.' },
  { title: 'Segunda com Sabor', subtitle: 'Comece a semana com um smash burger da casa.' },
  { title: 'Terça do Burger', subtitle: 'Burgers da casa, montados na hora do pedido.' },
  { title: 'Quarta do Delivery', subtitle: 'Peça sem sair de casa: a gente leva até você.' },
  { title: 'Quinta da Batata', subtitle: 'Uma porção crocante para acompanhar o seu burger.' },
  { title: 'Sextou com Bacon', subtitle: 'Tudo fica melhor com bacon. Turbine o seu lanche.' },
  { title: 'Sabadou com a gente', subtitle: 'Chame os amigos e escolha os combos da casa.' },
];

const CATEGORIES = [
  { id: 'todos', label: 'Todos', emoji: '⭐' },
  ...PRODUCT_CATEGORIES.filter((category) => category.id !== 'adicionais'),
];

/** Resposta de GET /promotions/banner (texto neutro; cupons não são exibidos). */
interface PromotionBanner {
  type: 'football' | 'promo';
  title?: string;
  message?: string;
  subtitle?: string;
  subMessage?: string;
  details?: { home?: string; away?: string; tournament?: string; time?: string };
}

interface BannerView {
  tag: string;
  title: string;
  subtitle: string;
  image: string;
  icon: FeatherIconName;
  closed: boolean;
}

const THEME_LABELS: Record<string, string> = { system: 'do sistema', light: 'claro', dark: 'escuro' };

interface Product {
  id: number;
  name: string;
  description: string;
  price: number | string;
  promotion_price: number | string | null;
  image: string | null;
  category: string;
  available: boolean;
}

/** Descrição do card para leitores de tela: nome, descrição, preço (o anterior na promoção) e ação. */
function productCardLabel(product: Product, isOpen: boolean, isPromo = false): string {
  const price = hasPromotion(product)
    ? `de ${formatPrice(product.price)} por ${formatPrice(effectivePrice(product))}`
    : formatPrice(effectivePrice(product));
  return [isPromo ? 'Oferta' : '', product.name, product.description?.trim(), price, isOpen ? 'Adicionar' : 'Loja fechada']
    .filter(Boolean)
    .join(', ');
}

export default function Home() {
  const { user } = useContext(AuthContext);
  const { cart, totalCartValue } = useContext(CartContext);
  const { themeMode, activeTheme, cycleTheme } = useContext(ThemeContext);
  const { isOpen, status, closedMessage, refresh: refreshStore } = useContext(StoreContext);
  const insets = useSafeAreaInsets();

  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();

  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const [promotion, setPromotion] = useState<PromotionBanner | null>(null);
  const [activeCategory, setActiveCategory] = useState('todos');
  const [searchTerm, setSearchTerm] = useState('');

  const [visibleCount, setVisibleCount] = useState(6);

  useEffect(() => {
    fetchProducts();
    fetchPromotion();
  }, []);

  // Ao voltar para a Home, confere de novo se a loja está aberta
  useFocusEffect(
    useCallback(() => {
      refreshStore();
    }, [refreshStore])
  );

  useEffect(() => {
    setVisibleCount(6);
  }, [activeCategory, searchTerm]);

  async function fetchProducts() {
    try {
      const response = await api.get<Product[] | null>('/products');
      const list = Array.isArray(response.data) ? response.data : [];
      setProducts(list.filter((p) => p.available));
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  async function fetchPromotion() {
    try {
      const { data } = await api.get<PromotionBanner | null>('/promotions/banner');
      setPromotion(data && (data.title || data.message) ? data : null);
    } catch {
      setPromotion(null); // Usa a oferta local do dia
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    await Promise.all([fetchProducts(), fetchPromotion(), refreshStore()]);
    setRefreshing(false);
  }

  const banner: BannerView = useMemo(() => {
    const weekday = new Date().getDay();

    if (!isOpen) {
      return { tag: 'LOJA FECHADA', title: 'Loja fechada', subtitle: closedMessage, image: CLOSED_IMAGE, icon: 'lock', closed: true };
    }

    if (promotion?.type === 'football') {
      const match = promotion.details?.home && promotion.details?.away
        ? `${promotion.details.home} x ${promotion.details.away}${promotion.details.time ? ` às ${promotion.details.time}` : ''}`
        : '';
      return {
        tag: promotion.details?.tournament ? promotion.details.tournament.toUpperCase() : 'HOJE TEM JOGO',
        title: promotion.title || 'Hoje tem jogo! ⚽',
        subtitle: promotion.message || match,
        image: FOOTBALL_IMAGE,
        icon: 'award',
        closed: false,
      };
    }

    if (promotion) {
      return {
        tag: 'SUGESTÃO DO DIA',
        title: promotion.title || FALLBACK_OFFERS[weekday].title,
        subtitle: promotion.message || promotion.subtitle || promotion.subMessage || FALLBACK_OFFERS[weekday].subtitle,
        image: WEEKDAY_IMAGES[weekday],
        icon: 'clock',
        closed: false,
      };
    }

    return { tag: 'SUGESTÃO DO DIA', ...FALLBACK_OFFERS[weekday], image: WEEKDAY_IMAGES[weekday], icon: 'clock', closed: false };
  }, [isOpen, closedMessage, promotion]);

  const handleProductPress = (productId: number) => {
    // Com a loja fechada o cliente ainda vê os detalhes, mas não consegue adicionar ao carrinho
    navigation.navigate('ProductDetails', { product_id: productId });
  };

  const getThemeIcon = (): FeatherIconName => {
    if (themeMode === 'system') return 'smartphone';
    return themeMode === 'dark' ? 'moon' : 'sun';
  };

  const comboProducts = useMemo(() => products.filter(p => p.category === 'combos'), [products]);
  const promoProducts = useMemo(() => products.filter(p => hasPromotion(p)), [products]);

  const mainList = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return products.filter(product => {
      if (term) {
        return product.name.toLowerCase().includes(term) || (product.description ?? '').toLowerCase().includes(term);
      }
      return activeCategory === 'todos' || product.category === activeCategory;
    });
  }, [products, searchTerm, activeCategory]);

  const displayedList = mainList.slice(0, visibleCount);

  const renderHorizontalCard = (product: Product, isPromo = false) => (
    <TouchableOpacity
      key={product.id}
      onPress={() => handleProductPress(product.id)}
      accessibilityRole="button"
      accessibilityLabel={productCardLabel(product, isOpen, isPromo)}
      accessibilityHint="Abre os detalhes do produto"
      className={`w-64 bg-white dark:bg-slate-800 p-4 rounded-3xl mr-4 border border-gray-100 dark:border-slate-700 shadow-sm overflow-hidden
        ${!isOpen ? 'opacity-80' : 'active:scale-95'}
      `}
    >
      {isPromo && (
        <View className="absolute top-0 right-0 bg-red-600 px-3 py-1 rounded-bl-2xl z-10">
          <Text className="text-white text-[10px] font-bold">OFERTA</Text>
        </View>
      )}
      <View className="h-32 bg-gray-50 dark:bg-slate-900 rounded-2xl mb-4 overflow-hidden relative">
        <RemoteImage path={product.image} className="w-full h-full" />
        {!isOpen && <View className="absolute inset-0 bg-black/40" />}
      </View>

      <Text className="font-bold text-gray-800 dark:text-white text-lg mb-1" numberOfLines={1}>{product.name}</Text>
      <Text className="text-xs text-gray-500 dark:text-gray-400 mb-3" numberOfLines={1}>{product.description}</Text>

      <View className="flex-row justify-between items-center mt-auto">
        <View>
          <Text className="font-extrabold text-lg text-gray-900 dark:text-gray-100">
            {formatPrice(effectivePrice(product))}
          </Text>
          {hasPromotion(product) && (
            <Text className="text-slate-400 text-xs line-through">{formatPrice(product.price)}</Text>
          )}
        </View>
        <View className={`px-4 py-2 rounded-xl ${!isOpen ? 'bg-gray-300 dark:bg-slate-700' : 'bg-slate-900 dark:bg-orange-600'}`}>
          <Text className={`text-xs font-bold ${!isOpen ? 'text-gray-500 dark:text-gray-400' : 'text-white'}`}>
            {!isOpen ? 'Fechado' : 'Adicionar'}
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );

  const renderVerticalCard = ({ item }: { item: Product }) => (
    <TouchableOpacity
      onPress={() => handleProductPress(item.id)}
      accessibilityRole="button"
      accessibilityLabel={productCardLabel(item, isOpen)}
      accessibilityHint="Abre os detalhes do produto"
      className={`bg-white dark:bg-slate-800 p-4 rounded-3xl mb-4 mx-6 flex-row items-center border border-gray-100 dark:border-slate-700 shadow-sm
        ${!isOpen ? 'opacity-70' : 'active:scale-95'}
      `}
    >
      <View className="w-24 h-24 rounded-2xl bg-gray-100 dark:bg-slate-900 overflow-hidden relative">
        <RemoteImage path={item.image} className="w-full h-full" />
        {!isOpen && <View className="absolute inset-0 bg-black/50" />}
      </View>

      <View className="flex-1 ml-4 justify-center">
        <Text className="text-slate-900 dark:text-white font-bold text-lg" numberOfLines={1}>{item.name}</Text>
        <Text className="text-slate-500 dark:text-slate-400 text-xs mt-1 mb-2 leading-4" numberOfLines={2}>{item.description}</Text>

        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center">
            {hasPromotion(item) ? (
              <>
                <Text className="text-orange-500 font-bold text-lg mr-2">{formatPrice(effectivePrice(item))}</Text>
                <Text className="text-slate-400 text-xs line-through">{formatPrice(item.price)}</Text>
              </>
            ) : (
              <Text className="text-slate-900 dark:text-white font-bold text-lg">{formatPrice(item.price)}</Text>
            )}
          </View>

          <View
            accessibilityLabel={isOpen ? `Adicionar ${item.name}` : 'Loja fechada'}
            className={`w-8 h-8 rounded-full items-center justify-center ${!isOpen ? 'bg-gray-200 dark:bg-slate-700' : 'bg-orange-100 dark:bg-orange-600/20'}`}
          >
            <Feather name={!isOpen ? 'lock' : 'plus'} size={16} color={!isOpen ? '#9ca3af' : '#ea580c'} />
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );

  const listHeaderComponent = (
    <View>
      {/* 1. Header Fixo Superior */}
      <View className="flex-row justify-between items-center px-6 mb-6">

        {/* Bloco da Esquerda (Logo e Bem vindo) - Flex 1 para empurrar o resto */}
        <View className="flex-1 mr-2">
          <View className="flex-row items-center mb-1">
            <View className="mr-2 flex-shrink">
              <BrandWordmark size="md" />
            </View>
            {/* Status da loja (só depois de consultar a API: sem resposta não afirmamos nada) */}
            {status ? (
              <View
                accessible
                accessibilityRole="text"
                accessibilityLabel={isOpen ? 'Loja aberta agora' : 'Loja fechada'}
                className={`flex-row items-center px-2 py-0.5 rounded-full ${isOpen ? 'bg-green-100 dark:bg-green-900/30' : 'bg-red-100 dark:bg-red-900/30'}`}
              >
                <View className={`w-1.5 h-1.5 rounded-full mr-1 ${isOpen ? 'bg-green-600' : 'bg-red-500'}`} />
                <Text className={`text-[10px] font-bold ${isOpen ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`} numberOfLines={1}>
                  {isOpen ? 'Aberto agora' : 'Fechado'}
                </Text>
              </View>
            ) : null}
          </View>
          <Text className="text-xs sm:text-base text-slate-600 dark:text-slate-400" numberOfLines={1}>
            {user ? `E aí, ${firstName(user.name)}! 👋` : 'Bem-vindo(a), visitante! 🍔'}
          </Text>
        </View>

        {/* Bloco da Direita (Botões) */}
        <View className="flex-row items-center">

          <TouchableOpacity
            onPress={() => navigation.navigate('Cart')}
            accessibilityRole="button"
            accessibilityLabel={cart.length > 0 ? `Carrinho, ${cart.length} ${cart.length === 1 ? 'item' : 'itens'}` : 'Carrinho vazio'}
            className="p-2 sm:p-2.5 bg-gray-200 dark:bg-slate-800 rounded-full border border-gray-300 dark:border-slate-700 active:scale-95 relative mr-2"
          >
            <Feather name="shopping-cart" size={18} color={activeTheme === 'dark' ? '#cbd5e1' : '#475569'} />
            {cart.length > 0 && (
              <View className="absolute -top-1 -right-1 bg-red-600 w-4 h-4 rounded-full items-center justify-center">
                <Text className="text-white text-[9px] font-bold">{cart.length}</Text>
              </View>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            onPress={cycleTheme}
            accessibilityRole="button"
            accessibilityLabel={`Tema ${THEME_LABELS[themeMode] ?? ''}`.trim()}
            accessibilityHint="Alterna entre o tema do sistema, claro e escuro"
            className="p-2 sm:p-2.5 bg-gray-200 dark:bg-slate-800 rounded-full border border-gray-300 dark:border-slate-700 active:scale-95 mr-2"
          >
            <Feather name={getThemeIcon()} size={18} color={activeTheme === 'dark' ? '#fbbf24' : '#475569'} />
          </TouchableOpacity>

          {user ? (
            <TouchableOpacity
              onPress={() => navigation.navigate('Profile')}
              accessibilityRole="button"
              accessibilityLabel="Minha conta"
              className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-orange-600 border-2 border-orange-200 dark:border-slate-700 justify-center items-center overflow-hidden"
            >
              {user.avatar
                ? <RemoteImage path={user.avatar} className="w-full h-full" fallbackIcon="user" iconSize={16} />
                : <Text className="text-white font-bold text-base">{user.name.charAt(0).toUpperCase()}</Text>}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              onPress={() => navigation.navigate('Welcome')}
              accessibilityRole="button"
              accessibilityLabel="Entrar"
              className="bg-orange-600 px-3 py-2 sm:px-4 rounded-lg active:scale-95 shadow-md"
            >
              <Text className="text-white font-bold text-xs sm:text-sm">Entrar</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* 2. Banner do Dia */}
      <View className="px-6 mb-8">
        <View className="w-full h-64 rounded-3xl overflow-hidden shadow-xl relative bg-slate-900">

          {/* IMAGEM E MÁSCARA ESCURA */}
          <Image source={{ uri: banner.image }} className="absolute inset-0 w-full h-full" resizeMode="cover" />
          <View className={`absolute inset-0 ${banner.closed ? 'bg-black/60' : 'bg-black/20'}`} />

          {/* Bloco Sólido na Base garantindo 100% de leitura do texto */}
          <View className="absolute bottom-0 w-full bg-black/80 px-5 py-4">
            <View className="flex-row items-center mb-2">
              <View className={`px-3 py-1 rounded-full flex-row items-center ${banner.closed ? 'bg-red-600' : 'bg-orange-600'}`}>
                <Feather name={banner.icon} size={12} color="#fff" />
                <Text className="text-white text-[10px] font-bold ml-1.5 uppercase tracking-wider" numberOfLines={1}>
                  {banner.tag}
                </Text>
              </View>
            </View>
            <Text className="text-2xl font-extrabold text-white mb-1 leading-tight" numberOfLines={2}>{banner.title}</Text>
            <Text className="text-sm text-gray-200 font-medium leading-relaxed" numberOfLines={2}>{banner.subtitle}</Text>
          </View>
        </View>
      </View>

      {!isOpen && (
        <View className="mx-6 mb-6 flex-row items-center bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900/40 rounded-2xl p-4">
          <Feather name="lock" size={18} color="#ef4444" />
          <Text className="text-red-700 dark:text-red-300 text-sm ml-3 flex-1">
            Loja fechada: você pode ver o cardápio, mas os pedidos estão pausados.
          </Text>
        </View>
      )}

      {isOpen && status?.opening_message?.trim() ? (
        <View className="mx-6 mb-6 flex-row items-center bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-900/40 rounded-2xl p-4">
          <Feather name="unlock" size={18} color="#16a34a" />
          <Text className="text-green-700 dark:text-green-300 text-sm ml-3 flex-1">{status.opening_message}</Text>
        </View>
      ) : null}

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
          {searchTerm ? (
            <TouchableOpacity onPress={() => setSearchTerm('')} className="p-1" accessibilityRole="button" accessibilityLabel="Limpar busca">
              <Feather name="x" size={18} color="#94a3b8" />
            </TouchableOpacity>
          ) : null}
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
              accessibilityRole="button"
              accessibilityLabel={`Categoria ${cat.label}`}
              accessibilityState={{ selected: activeCategory === cat.id }}
              className={`flex-row items-center px-5 py-2.5 rounded-full mr-3 border ${
                activeCategory === cat.id
                  ? 'bg-slate-900 dark:bg-orange-600 border-slate-900 dark:border-orange-600'
                  : 'bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700'
              }`}
            >
              <Text className="text-sm mr-2">{cat.emoji}</Text>
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
           <Feather name={loadError ? 'wifi-off' : 'inbox'} size={48} color={activeTheme === 'dark' ? '#334155' : '#cbd5e1'} />
           <Text className="text-slate-500 dark:text-slate-400 text-center mt-4 text-base">
             {loadError
               ? 'Não foi possível carregar o cardápio. Puxe a tela para baixo para tentar de novo.'
               : 'Nenhum produto encontrado nesta busca ou categoria.'}
           </Text>
         </View>
      )}

      <Footer />
      {cart.length > 0 && <View className="h-24" />}
    </View>
  );

  return (
    <View className="flex-1 bg-gray-50 dark:bg-slate-900" style={{ paddingTop: insets.top + 12 }}>
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
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#f97316" colors={['#f97316']} />}
        />
      )}

      {cart.length > 0 && (
        <TouchableOpacity
          className="absolute left-6 right-6 bg-orange-600 p-4 rounded-2xl flex-row justify-between items-center shadow-lg shadow-orange-600/30 active:scale-95"
          style={{ bottom: Math.max(insets.bottom, 12) + 12 }}
          onPress={() => navigation.navigate('Cart')}
          accessibilityRole="button"
          accessibilityLabel={`Ver carrinho, ${cart.length} ${cart.length === 1 ? 'item' : 'itens'}, ${formatPrice(totalCartValue)}`}
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
