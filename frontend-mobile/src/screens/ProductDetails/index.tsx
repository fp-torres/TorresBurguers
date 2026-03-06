import React, { useEffect, useState, useContext } from 'react';
import { View, Text, TouchableOpacity, Image, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { useRoute, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Feather from '@expo/vector-icons/Feather';
import api from '../../services/api';
import { AppStackParamList } from '../../routes/app.routes'; 

import { CartContext } from '../../contexts/CartContext';
// AQUI: Importamos o ThemeContext para ler qual é a cor atual da tela
import { ThemeContext } from '../../contexts/ThemeContext';

interface Addon {
  id: number;
  name: string;
  price: number;
}

interface Product {
  id: number;
  name: string;
  description: string;
  price: number;
  promotion_price: number | null;
  image: string | null;
  allowed_addons: Addon[];
}

interface SelectedAddon {
  addon: Addon;
  quantity: number;
}

type ProductDetailsRouteProp = {
  key: string;
  name: "ProductDetails";
  params: { product_id: number };
};

export default function ProductDetails() {
  const route = useRoute<ProductDetailsRouteProp>();
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  const { product_id } = route.params;

  const { addItemToCart } = useContext(CartContext);
  const { activeTheme } = useContext(ThemeContext); // Consumindo o tema ativo

  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  
  const [quantity, setQuantity] = useState(1);
  const [selectedAddons, setSelectedAddons] = useState<SelectedAddon[]>([]);

  useEffect(() => {
    async function fetchProduct() {
      try {
        const response = await api.get(`/products/${product_id}`);
        setProduct(response.data);
      } catch (error) {
        console.error('Erro ao buscar produto:', error);
        Alert.alert('Erro', 'Não foi possível carregar os detalhes do produto.');
        navigation.goBack();
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
      navigation.navigate('Home'); 
    }
  }

  const formatPrice = (price: number) => {
    return Number(price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };

  const handleAddonIncrement = (addon: Addon) => {
    const existingIndex = selectedAddons.findIndex(item => item.addon.id === addon.id);
    if (existingIndex >= 0) {
      const newList = [...selectedAddons];
      newList[existingIndex].quantity += 1;
      setSelectedAddons(newList);
    } else {
      setSelectedAddons([...selectedAddons, { addon, quantity: 1 }]);
    }
  };

  const handleAddonDecrement = (addonId: number) => {
    const existingIndex = selectedAddons.findIndex(item => item.addon.id === addonId);
    if (existingIndex >= 0) {
      const newList = [...selectedAddons];
      if (newList[existingIndex].quantity > 1) {
        newList[existingIndex].quantity -= 1;
        setSelectedAddons(newList);
      } else {
        newList.splice(existingIndex, 1);
        setSelectedAddons(newList);
      }
    }
  };

  const getAddonQuantity = (addonId: number) => {
    const item = selectedAddons.find(a => a.addon.id === addonId);
    return item ? item.quantity : 0;
  };

  const calculateTotal = () => {
    if (!product) return 0;
    const basePrice = Number(product.promotion_price || product.price);
    const addonsTotal = selectedAddons.reduce((acc, item) => acc + (Number(item.addon.price) * item.quantity), 0);
    return (basePrice + addonsTotal) * quantity;
  };

  function handleAddToCart() {
    if (!product) return;

    const newItem = {
      product: {
        id: product.id,
        name: product.name,
        price: product.price,
        promotion_price: product.promotion_price,
        image: product.image,
      },
      quantity: quantity,
      addons: selectedAddons,
      total: calculateTotal()
    };

    addItemToCart(newItem);

    Alert.alert('Sucesso!', 'Seu lanche foi adicionado ao carrinho! 🍔', [
      {
        text: 'Continuar Comprando',
        onPress: () => navigation.navigate('Home')
      }
    ]);
  }

  const getImageUrl = (imagePath: string | null) => {
    if (!imagePath) return 'https://via.placeholder.com/400?text=Sem+Foto';
    let cleanPath = imagePath.replace(/^\//, ''); 
    if (!cleanPath.startsWith('uploads/')) {
      cleanPath = `uploads/${cleanPath}`;
    }
    const base = api.defaults.baseURL?.replace(/\/$/, '') || '';
    return `${base}/${cleanPath}`;
  };

  if (loading || !product) {
    return (
      <View className="flex-1 bg-gray-50 dark:bg-slate-900 justify-center items-center">
        <ActivityIndicator size="large" color="#f97316" />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-gray-50 dark:bg-slate-900">
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 100 }}>
        
        {/* Container da Imagem */}
        <View className="relative w-full h-72 bg-gray-200 dark:bg-slate-800">
          <Image 
            source={{ uri: getImageUrl(product.image) }}
            className="w-full h-full"
            resizeMode="cover"
          />
          
          <TouchableOpacity 
            className="absolute top-12 left-4 w-10 h-10 bg-white/90 dark:bg-slate-900/80 rounded-full justify-center items-center shadow-sm"
            onPress={handleGoBack}
          >
            <Feather name="arrow-left" size={24} color="#f97316" />
          </TouchableOpacity>
        </View>

        <View className="p-6">
          <Text className="text-3xl font-bold text-slate-900 dark:text-white mb-2">{product.name}</Text>
          <Text className="text-slate-500 dark:text-slate-400 text-base mb-4 leading-6">{product.description}</Text>
          <Text className="text-orange-500 font-bold text-2xl mb-6">
            {formatPrice(product.promotion_price || product.price)}
          </Text>

          {product.allowed_addons && product.allowed_addons.length > 0 && (
            <View>
              <Text className="text-xl font-bold text-slate-900 dark:text-white mb-4">Turbine seu lanche 🥓</Text>
              
              {product.allowed_addons.map((addon) => (
                <View key={addon.id} className="flex-row items-center justify-between bg-white dark:bg-slate-800 p-4 rounded-xl mb-3 border border-gray-100 dark:border-transparent shadow-sm dark:shadow-none">
                  <View className="flex-1">
                    <Text className="text-slate-900 dark:text-white font-medium text-base">{addon.name}</Text>
                    <Text className="text-orange-500 text-sm">+{formatPrice(addon.price)}</Text>
                  </View>

                  <View className="flex-row items-center bg-gray-100 dark:bg-slate-900 rounded-lg p-1">
                    <TouchableOpacity onPress={() => handleAddonDecrement(addon.id)} className="p-2">
                      <Feather 
                        name="minus" 
                        size={20} 
                        color={getAddonQuantity(addon.id) > 0 ? "#f97316" : (activeTheme === 'dark' ? "#475569" : "#9ca3af")} 
                      />
                    </TouchableOpacity>
                    
                    <Text className="text-slate-900 dark:text-white font-bold px-3">
                      {getAddonQuantity(addon.id)}
                    </Text>
                    
                    <TouchableOpacity onPress={() => handleAddonIncrement(addon)} className="p-2">
                      <Feather name="plus" size={20} color="#f97316" />
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>

      {/* RODAPÉ FIXO */}
      <View className="absolute bottom-0 w-full bg-white dark:bg-slate-800 border-t border-gray-200 dark:border-slate-700 p-5 flex-row justify-between items-center shadow-lg">
        
        <View className="flex-row items-center bg-gray-100 dark:bg-slate-900 rounded-xl p-1 mr-4">
          <TouchableOpacity onPress={() => setQuantity(Math.max(1, quantity - 1))} className="p-3">
            <Feather 
              name="minus" 
              size={20} 
              color={quantity > 1 ? (activeTheme === 'dark' ? "#fff" : "#0f172a") : (activeTheme === 'dark' ? "#475569" : "#9ca3af")} 
            />
          </TouchableOpacity>
          
          <Text className="text-slate-900 dark:text-white font-bold text-lg px-4">{quantity}</Text>
          
          <TouchableOpacity onPress={() => setQuantity(quantity + 1)} className="p-3">
            <Feather 
              name="plus" 
              size={20} 
              color={activeTheme === 'dark' ? "#fff" : "#0f172a"} 
            />
          </TouchableOpacity>
        </View>

        <TouchableOpacity 
          className="flex-1 bg-orange-600 rounded-xl py-4 flex-row justify-center items-center active:scale-95 shadow-md shadow-orange-600/30"
          onPress={handleAddToCart}
        >
          <Text className="text-white font-bold text-lg mr-2">Adicionar</Text>
          <Text className="text-white font-bold text-lg">{formatPrice(calculateTotal())}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}