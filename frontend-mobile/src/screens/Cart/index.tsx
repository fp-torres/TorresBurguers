import React, { useContext } from 'react';
import { View, Text, TouchableOpacity, FlatList, Image, Alert } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Feather from '@expo/vector-icons/Feather';

import { CartContext, CartItem } from '../../contexts/CartContext';
import { AuthContext } from '../../contexts/AuthContext';
import { AppStackParamList } from '../../routes/app.routes'; 
import api from '../../services/api';

export default function Cart() {
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  
  const { cart, removeItemFromCart, totalCartValue } = useContext(CartContext);
  const { user } = useContext(AuthContext);

  const formatPrice = (price: number) => {
    return Number(price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };

  function handleCheckout() {
    if (!user) {
      Alert.alert(
        'Falta pouco! 🍔', 
        'Para finalizar seu pedido, você precisa acessar sua conta.',
        [
          { text: 'Cancelar', style: 'cancel' },
          { text: 'Fazer Login', onPress: () => navigation.navigate('Welcome') }
        ]
      );
      return;
    }
    navigation.navigate('Checkout');
  }

  const renderCartItem = ({ item }: { item: CartItem }) => (
    <View className="bg-slate-800 p-4 rounded-2xl mb-4 flex-row items-center shadow-md">
      <Image 
        source={{ 
          uri: item.product.image 
            ? `${api.defaults.baseURL}/${item.product.image.replace(/^\//, '')}` 
            : 'https://via.placeholder.com/100?text=Sem+Foto' 
        }} 
        className="w-20 h-20 rounded-xl bg-slate-700"
        resizeMode="cover"
      />
      
      <View className="flex-1 ml-4 justify-center">
        <View className="flex-row justify-between items-start">
          <Text className="text-white font-bold text-lg flex-1 mr-2" numberOfLines={2}>
            {item.quantity}x {item.product.name}
          </Text>
          <TouchableOpacity onPress={() => removeItemFromCart(item.id)} className="p-2 bg-slate-900 rounded-lg">
            <Feather name="trash-2" size={20} color="#ef4444" />
          </TouchableOpacity>
        </View>

        {item.addons.length > 0 && (
          <View className="mt-1 mb-2">
            {item.addons.map((addonItem, index) => (
              <Text key={index} className="text-slate-400 text-xs">
                + {addonItem.quantity}x {addonItem.addon.name}
              </Text>
            ))}
          </View>
        )}
        
        <Text className="text-orange-500 font-bold text-lg mt-1">
          {formatPrice(item.total)}
        </Text>
      </View>
    </View>
  );

  return (
    <View className="flex-1 bg-slate-900 pt-16">
      <View className="flex-row items-center px-6 mb-6">
        <TouchableOpacity 
          onPress={() => navigation.goBack()}
          className="w-10 h-10 bg-slate-800 rounded-full justify-center items-center"
        >
          <Feather name="arrow-left" size={24} color="#f97316" />
        </TouchableOpacity>
        <Text className="text-2xl font-bold text-white ml-4">Seu Pedido</Text>
      </View>

      <FlatList
        data={cart}
        keyExtractor={(item) => item.id}
        renderItem={renderCartItem}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 120 }}
        ListEmptyComponent={
          <View className="items-center justify-center mt-20">
            <Feather name="shopping-bag" size={64} color="#475569" className="mb-4" />
            <Text className="text-slate-400 text-lg text-center">
              Seu carrinho está vazio.{"\n"}Que tal adicionar um lanche? 🍔
            </Text>
          </View>
        }
      />

      {cart.length > 0 && (
        <View className="absolute bottom-0 w-full bg-slate-800 border-t border-slate-700 p-6 pb-8">
          <View className="flex-row justify-between mb-4">
            <Text className="text-slate-300 text-lg">Total do pedido:</Text>
            <Text className="text-white font-bold text-2xl">{formatPrice(totalCartValue)}</Text>
          </View>

          <TouchableOpacity 
            className="w-full bg-green-600 rounded-xl py-4 flex-row justify-center items-center active:scale-95"
            onPress={handleCheckout}
          >
            <Text className="text-white font-bold text-lg">Avançar para Pagamento</Text>
            <Feather name="chevron-right" size={24} color="#fff" className="ml-2" />
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}