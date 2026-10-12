import React, { useEffect, useRef, useState, useContext } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Modal, Animated, TextInput } from 'react-native';
import { RouteProp, useRoute, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';

import api from '../../services/api';
import { AppStackParamList } from '../../routes/app.routes';
import { CartContext } from '../../contexts/CartContext';
import { ThemeContext } from '../../contexts/ThemeContext';
import { StoreContext } from '../../contexts/StoreContext';
import RemoteImage from '../../components/RemoteImage';
import KeyboardAwareScreen, { useKeyboardVisible } from '../../components/KeyboardAwareScreen';
import {
  DEFAULT_MEAT_POINT, MAX_OBSERVATION_LENGTH, MEAT_POINTS, effectivePrice, hasMeatPoint, hasPromotion,
} from '../../utils/catalog';
import { formatPrice } from '../../utils/format';
import { getErrorMessage, getErrorStatus } from '../../utils/errors';

interface Addon {
  id: number;
  name: string;
  price: number | string;
  available?: boolean;
}

interface Product {
  id: number;
  name: string;
  description: string;
  price: number | string;
  promotion_price: number | string | null;
  image: string | null;
  category?: string | null;
  available?: boolean;
  allowed_addons?: Addon[];
}

interface SelectedAddon {
  addon: Addon;
  quantity: number;
}

// Limites aceitos pelo backend por item do pedido
const MAX_QUANTITY = 50;
const MAX_ADDON_QUANTITY = 10;
/** Soma das unidades de todos os adicionais de um item (addonIds do backend: no máximo 50). */
const MAX_ADDONS_PER_ITEM = 50;

export default function ProductDetails() {
  const route = useRoute<RouteProp<AppStackParamList, 'ProductDetails'>>();
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  const { product_id } = route.params;
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();

  const { addItemToCart } = useContext(CartContext);
  const { activeTheme } = useContext(ThemeContext);
  const { isOpen, closedMessage } = useContext(StoreContext);

  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [quantity, setQuantity] = useState(1);
  const [selectedAddons, setSelectedAddons] = useState<SelectedAddon[]>([]);
  const [meatPoint, setMeatPoint] = useState<string>(DEFAULT_MEAT_POINT);
  const [observation, setObservation] = useState('');

  // Faixa atrás da barra de status: aparece quando o conteúdo rola por baixo dela
  const scrollY = useRef(new Animated.Value(0)).current;

  // Controle do Modal de Sucesso
  const [successModalVisible, setSuccessModalVisible] = useState(false);

  useEffect(() => {
    async function fetchProduct() {
      setLoading(true);
      try {
        const response = await api.get<Product | null>(`/products/${product_id}`);
        // Produto removido pode voltar vazio: mostra aviso em vez de carregar para sempre
        if (!response.data) {
          setErrorMessage('Este produto não está mais disponível.');
        } else {
          setProduct(response.data);
          setErrorMessage(null);
        }
      } catch (error) {
        setErrorMessage(getErrorStatus(error) === 404
          ? 'Este produto não está mais disponível.'
          : getErrorMessage(error, 'Não foi possível carregar os detalhes do produto.'));
      } finally {
        setLoading(false);
      }
    }
    fetchProduct();
  }, [product_id]);

  function handleGoBack() {
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.popTo('Home');
    }
  }

  const availableAddons = (product?.allowed_addons ?? []).filter((addon) => addon.available !== false);

  const totalAddonUnits = selectedAddons.reduce((acc, item) => acc + item.quantity, 0);
  const addonLimitReached = totalAddonUnits >= MAX_ADDONS_PER_ITEM;

  const handleAddonIncrement = (addon: Addon) => {
    setSelectedAddons((current) => {
      if (current.reduce((acc, item) => acc + item.quantity, 0) >= MAX_ADDONS_PER_ITEM) return current;
      const existing = current.find((item) => item.addon.id === addon.id);
      if (!existing) return [...current, { addon, quantity: 1 }];
      if (existing.quantity >= MAX_ADDON_QUANTITY) return current;
      return current.map((item) => item.addon.id === addon.id ? { ...item, quantity: item.quantity + 1 } : item);
    });
  };

  const handleAddonDecrement = (addonId: number) => {
    setSelectedAddons((current) => current
      .map((item) => item.addon.id === addonId ? { ...item, quantity: item.quantity - 1 } : item)
      .filter((item) => item.quantity > 0));
  };

  const getAddonQuantity = (addonId: number) => {
    const item = selectedAddons.find(a => a.addon.id === addonId);
    return item ? item.quantity : 0;
  };

  const calculateTotal = () => {
    if (!product) return 0;
    const basePrice = effectivePrice(product);
    const addonsTotal = selectedAddons.reduce((acc, item) => acc + (Number(item.addon.price) * item.quantity), 0);
    return (basePrice + addonsTotal) * quantity;
  };

  const withMeatPoint = !!product && hasMeatPoint(product);
  const productAvailable = product?.available !== false;
  const canAdd = isOpen && productAvailable;

  function handleAddToCart() {
    if (!product || !canAdd) return;

    addItemToCart({
      product: {
        id: product.id,
        name: product.name,
        price: Number(product.price),
        promotion_price: product.promotion_price == null || product.promotion_price === '' ? null : Number(product.promotion_price),
        image: product.image,
        category: product.category ?? null,
      },
      quantity,
      addons: selectedAddons.map((item) => ({
        addon: { id: item.addon.id, name: item.addon.name, price: Number(item.addon.price) },
        quantity: item.quantity,
      })),
      // Ponto da carne só vai para hambúrgueres; observação vazia não entra na linha
      meatPoint: withMeatPoint ? meatPoint : undefined,
      observation,
    });

    // Mostra o Modal personalizado em vez do Alert do sistema
    setSuccessModalVisible(true);
  }

  // Ações do Modal
  function handleContinueShopping() {
    setSuccessModalVisible(false);
    navigation.popTo('Home');
  }

  function handleGoToCart() {
    setSuccessModalVisible(false);
    navigation.replace('Cart');
  }

  if (loading) {
    return (
      <View className="flex-1 bg-gray-50 dark:bg-slate-900 justify-center items-center">
        <ActivityIndicator size="large" color="#f97316" />
      </View>
    );
  }

  if (!product) {
    return (
      <View className="flex-1 bg-gray-50 dark:bg-slate-900 justify-center items-center px-8">
        <Feather name="alert-circle" size={48} color={activeTheme === 'dark' ? '#475569' : '#94a3b8'} />
        <Text className="text-slate-600 dark:text-slate-300 text-center text-base mt-4 mb-6">
          {errorMessage ?? 'Produto não encontrado.'}
        </Text>
        <TouchableOpacity className="bg-orange-600 px-6 py-3 rounded-xl" onPress={handleGoBack}>
          <Text className="text-white font-bold">Voltar ao cardápio</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const addButtonLabel = !isOpen ? 'Loja fechada' : !productAvailable ? 'Indisponível' : 'Adicionar';

  return (
    <KeyboardAwareScreen className="flex-1 bg-gray-50 dark:bg-slate-900">

      {/* MODAL DE SUCESSO PÓS-ADIÇÃO */}
      <Modal
        animationType="fade"
        transparent={true}
        visible={successModalVisible}
        onRequestClose={handleContinueShopping}
      >
        <View className="flex-1 bg-black/50 justify-center items-center px-6">
          <View className="bg-white dark:bg-slate-800 w-full rounded-3xl p-6 items-center shadow-xl">
            <View className="w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full items-center justify-center mb-4">
              <Feather name="check" size={32} color="#16a34a" />
            </View>

            <Text className="text-xl font-bold text-slate-900 dark:text-white mb-2 text-center">
              Adicionado com Sucesso!
            </Text>
            <Text className="text-slate-500 dark:text-slate-400 text-center mb-6">
              O lanche já está no seu carrinho. Continuar comprando ou ver o Carrinho?
            </Text>

            <View className="w-full flex-row justify-between">
              <TouchableOpacity
                className="flex-1 bg-gray-100 dark:bg-slate-700 py-4 rounded-xl items-center mr-2 active:scale-95 border border-gray-200 dark:border-slate-600"
                onPress={handleContinueShopping}
              >
                <Text className="text-slate-700 dark:text-slate-300 font-bold">Continuar</Text>
              </TouchableOpacity>

              <TouchableOpacity
                className="flex-1 bg-orange-600 py-4 rounded-xl items-center ml-2 active:scale-95 shadow-md shadow-orange-600/30"
                onPress={handleGoToCart}
              >
                <Text className="text-white font-bold">Ver Carrinho</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Animated.ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 24 }}
        scrollEventThrottle={16}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: true })}
      >

        {/* Container da Imagem */}
        <View className="relative w-full h-72 bg-gray-200 dark:bg-slate-800">
          <RemoteImage path={product.image} className="w-full h-full" iconSize={48} />

          <TouchableOpacity
            className="absolute left-4 w-10 h-10 bg-white/90 dark:bg-slate-900/80 rounded-full justify-center items-center shadow-sm"
            style={{ top: insets.top + 8 }}
            onPress={handleGoBack}
            accessibilityRole="button"
            accessibilityLabel="Voltar"
          >
            <Feather name="arrow-left" size={24} color="#f97316" />
          </TouchableOpacity>
        </View>

        <View className="p-6">
          {!isOpen && (
            <View className="flex-row items-center bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900/40 rounded-xl p-3 mb-4">
              <Feather name="lock" size={16} color="#ef4444" />
              <Text className="text-red-700 dark:text-red-300 text-sm ml-2 flex-1">Loja fechada. {closedMessage}</Text>
            </View>
          )}

          <Text className="text-3xl font-bold text-slate-900 dark:text-white mb-2">{product.name}</Text>
          <Text className="text-slate-500 dark:text-slate-400 text-base mb-4 leading-6">{product.description}</Text>
          <View className="flex-row items-end mb-6">
            <Text className="text-orange-500 font-bold text-2xl">
              {formatPrice(effectivePrice(product))}
            </Text>
            {hasPromotion(product) && (
              <Text className="text-slate-400 text-base line-through ml-3 mb-0.5">{formatPrice(product.price)}</Text>
            )}
          </View>

          {/* Ponto da carne (só hambúrgueres) */}
          {withMeatPoint && (
            <View className="mb-6">
              <Text className="text-xl font-bold text-slate-900 dark:text-white mb-3">Ponto da carne 🔥</Text>
              <View className="flex-row flex-wrap" accessibilityRole="radiogroup">
                {MEAT_POINTS.map((point) => {
                  const selected = meatPoint === point;
                  return (
                    <TouchableOpacity
                      key={point}
                      onPress={() => setMeatPoint(point)}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected }}
                      accessibilityLabel={`Ponto da carne: ${point}`}
                      className={`px-4 py-2.5 rounded-xl mr-2 mb-2 border ${selected ? 'bg-orange-600 border-orange-600' : 'bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700'}`}
                    >
                      <Text className={`font-bold text-sm ${selected ? 'text-white' : 'text-slate-700 dark:text-slate-300'}`}>{point}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          )}

          {availableAddons.length > 0 && (
            <View className="mb-6">
              <Text className="text-xl font-bold text-slate-900 dark:text-white mb-4">Turbine seu lanche 🥓</Text>

              {availableAddons.map((addon) => {
                const addonQuantity = getAddonQuantity(addon.id);
                const addonCapReached = addonQuantity >= MAX_ADDON_QUANTITY;
                const canIncrement = !addonLimitReached && !addonCapReached;
                return (
                  <View key={addon.id} className="flex-row items-center justify-between bg-white dark:bg-slate-800 p-4 rounded-xl mb-3 border border-gray-100 dark:border-transparent shadow-sm dark:shadow-none">
                    <View className="flex-1">
                      <Text className="text-slate-900 dark:text-white font-medium text-base">{addon.name}</Text>
                      <Text className="text-orange-500 text-sm">+{formatPrice(addon.price)}</Text>
                      {addonCapReached && (
                        <Text className="text-xs text-orange-600 dark:text-orange-400 mt-0.5" accessibilityLiveRegion="polite">
                          Máximo de {MAX_ADDON_QUANTITY} deste adicional.
                        </Text>
                      )}
                    </View>

                    <View className="flex-row items-center bg-gray-100 dark:bg-slate-900 rounded-lg p-1">
                      <TouchableOpacity
                        onPress={() => handleAddonDecrement(addon.id)}
                        disabled={addonQuantity === 0}
                        accessibilityRole="button"
                        accessibilityLabel={`Tirar um ${addon.name}`}
                        accessibilityState={{ disabled: addonQuantity === 0 }}
                        className="p-2"
                      >
                        <Feather
                          name="minus"
                          size={20}
                          color={addonQuantity > 0 ? "#f97316" : (activeTheme === 'dark' ? "#475569" : "#9ca3af")}
                        />
                      </TouchableOpacity>

                      <Text
                        className="text-slate-900 dark:text-white font-bold px-3"
                        accessibilityLabel={`${addonQuantity} de ${addon.name}`}
                      >
                        {addonQuantity}
                      </Text>

                      <TouchableOpacity
                        onPress={() => handleAddonIncrement(addon)}
                        disabled={!canIncrement}
                        accessibilityRole="button"
                        accessibilityLabel={`Adicionar um ${addon.name}`}
                        accessibilityState={{ disabled: !canIncrement }}
                        className="p-2"
                      >
                        <Feather name="plus" size={20} color={canIncrement ? "#f97316" : (activeTheme === 'dark' ? "#475569" : "#9ca3af")} />
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })}

              {addonLimitReached && (
                <Text className="text-xs text-orange-600 dark:text-orange-400 ml-1" accessibilityLiveRegion="polite">
                  Limite de {MAX_ADDONS_PER_ITEM} adicionais por item atingido.
                </Text>
              )}
            </View>
          )}

          {/* Observação para a cozinha */}
          <View>
            {/* Contador ao lado do título: continua visível com o teclado aberto */}
            <View className="flex-row justify-between items-end mb-3">
              <Text className="text-xl font-bold text-slate-900 dark:text-white">Observação</Text>
              <Text className="text-xs text-slate-400 dark:text-slate-500">
                {observation.length}/{MAX_OBSERVATION_LENGTH}
              </Text>
            </View>
            <TextInput
              value={observation}
              onChangeText={setObservation}
              maxLength={MAX_OBSERVATION_LENGTH}
              multiline
              placeholder="Ex.: sem sal, capricha no molho..."
              placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
              accessibilityLabel="Observação para a cozinha"
              className="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl px-4 py-3 text-slate-900 dark:text-white text-base h-24"
              style={{ textAlignVertical: 'top' }}
            />
          </View>
        </View>
      </Animated.ScrollView>

      {/* Fundo da barra de status: o conteúdo rolado não passa por baixo dos ícones do sistema */}
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: insets.top,
          backgroundColor: activeTheme === 'dark' ? '#0f172a' : '#f9fafb',
          opacity: scrollY.interpolate({ inputRange: [180, 260], outputRange: [0, 1], extrapolate: 'clamp' }),
        }}
      />

      {/* RODAPÉ (no fluxo: sobe junto com o teclado) */}
      <View
        className="bg-white dark:bg-slate-800 border-t border-gray-200 dark:border-slate-700 px-5 pt-5 flex-row justify-between items-center"
        style={{ paddingBottom: keyboardVisible ? 12 : Math.max(insets.bottom, 12) + 8 }}
      >
        <View className="flex-row items-center bg-gray-100 dark:bg-slate-900 rounded-xl p-1 mr-4 border border-gray-200 dark:border-slate-700">
          <TouchableOpacity
            onPress={() => setQuantity(Math.max(1, quantity - 1))}
            accessibilityRole="button"
            accessibilityLabel="Diminuir quantidade"
            className="p-3"
          >
            <Feather
              name="minus"
              size={20}
              color={quantity > 1 ? (activeTheme === 'dark' ? "#fff" : "#0f172a") : (activeTheme === 'dark' ? "#475569" : "#9ca3af")}
            />
          </TouchableOpacity>

          <Text className="text-slate-900 dark:text-white font-bold text-lg px-4">{quantity}</Text>

          <TouchableOpacity
            onPress={() => setQuantity(Math.min(MAX_QUANTITY, quantity + 1))}
            accessibilityRole="button"
            accessibilityLabel="Aumentar quantidade"
            className="p-3"
          >
            <Feather
              name="plus"
              size={20}
              color={quantity < MAX_QUANTITY ? (activeTheme === 'dark' ? "#fff" : "#0f172a") : (activeTheme === 'dark' ? "#475569" : "#9ca3af")}
            />
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          className={`flex-1 rounded-xl py-4 flex-row justify-center items-center ${canAdd ? 'bg-orange-600 active:scale-95 shadow-md shadow-orange-600/30' : 'bg-gray-300 dark:bg-slate-700'}`}
          onPress={handleAddToCart}
          disabled={!canAdd}
        >
          <Text className={`font-bold text-lg mr-2 ${canAdd ? 'text-white' : 'text-gray-500 dark:text-gray-400'}`}>{addButtonLabel}</Text>
          {canAdd && <Text className="text-white font-bold text-lg">{formatPrice(calculateTotal())}</Text>}
        </TouchableOpacity>
      </View>
    </KeyboardAwareScreen>
  );
}
