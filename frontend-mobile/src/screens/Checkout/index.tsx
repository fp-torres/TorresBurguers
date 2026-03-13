import React, { useState, useContext, useCallback } from 'react';
import { View, Text, TouchableOpacity, ScrollView, TextInput, ActivityIndicator, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Feather from '@expo/vector-icons/Feather';

import { AppStackParamList } from '../../routes/app.routes';
import { CartContext } from '../../contexts/CartContext';
import { ThemeContext } from '../../contexts/ThemeContext';
import { AuthContext } from '../../contexts/AuthContext'; 
import api from '../../services/api';

interface Address {
  id: number;
  street: string;
  number: string;
  neighborhood: string;
  city: string;
  nickname?: string;
}

export default function Checkout() {
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  
  const { cart, totalCartValue, clearCart } = useContext(CartContext);
  const { activeTheme } = useContext(ThemeContext);
  const { user } = useContext(AuthContext); 

  const [orderType, setOrderType] = useState<'DELIVERY' | 'TAKEOUT'>('DELIVERY');
  const [paymentMethod, setPaymentMethod] = useState('PIX');
  const [changeFor, setChangeFor] = useState('');
  
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [selectedAddress, setSelectedAddress] = useState<number | null>(null);
  const [loadingAddresses, setLoadingAddresses] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  // Novo estado para controlar a expansão da lista de endereços
  const [showAllAddresses, setShowAllAddresses] = useState(false);

  useFocusEffect(
    useCallback(() => {
      async function fetchAddresses() {
        setLoadingAddresses(true);
        try {
          const response = await api.get('/addresses');
          setAddresses(response.data);
          
          if (response.data.length > 0 && !selectedAddress) {
            // Seleciona automaticamente o último endereço cadastrado
            setSelectedAddress(response.data[response.data.length - 1].id);
          }
        } catch (error) {
          console.error('Erro ao buscar endereços:', error);
        } finally {
          setLoadingAddresses(false);
        }
      }
      fetchAddresses();
    }, [selectedAddress])
  );

  const formatPrice = (price: number) => {
    return Number(price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };

  async function handleFinishOrder() {
    if (orderType === 'DELIVERY' && !selectedAddress) {
      Alert.alert('Atenção', 'Selecione um endereço para entrega.');
      return;
    }

    if (paymentMethod === 'DINHEIRO' && !changeFor) {
      Alert.alert('Atenção', 'Informe para quanto precisa de troco, ou digite "Sem troco".');
      return;
    }

    setIsSubmitting(true);

    try {
      const itemsPayload = cart.map(item => {
        const addonIds: number[] = [];
        item.addons.forEach(a => {
          for (let i = 0; i < a.quantity; i++) {
            addonIds.push(a.addon.id);
          }
        });

        return {
          productId: item.product.id,
          quantity: item.quantity,
          addonIds: addonIds.length > 0 ? addonIds : undefined,
          observation: item.product.id ? undefined : undefined, 
        };
      });

      const payload = {
        type: orderType,
        addressId: orderType === 'DELIVERY' ? selectedAddress : undefined,
        paymentMethod: paymentMethod,
        changeFor: paymentMethod === 'DINHEIRO' ? changeFor : undefined,
        items: itemsPayload,
      };

      if (paymentMethod === 'PIX') {
        const pixResponse = await api.post('/payment/pix', { amount: totalCartValue });
        
        const finalPayload = { ...payload, paymentId: pixResponse.data.id };
        await api.post('/orders', finalPayload);
        
        clearCart();
        
        navigation.navigate('PaymentPix', {
          payment_id: pixResponse.data.id,
          qr_code: pixResponse.data.qr_code,
          qr_code_base64: pixResponse.data.qr_code_base64,
          total: totalCartValue
        });

      } else if (paymentMethod === 'CARTAO_CREDITO' || paymentMethod === 'CARTAO_DEBITO') {
        navigation.navigate('PaymentCard', {
          payload_order: payload,
          total: totalCartValue,
          email: user?.email || 'cliente@email.com'
        });
        setIsSubmitting(false);

      } else {
        await api.post('/orders', payload);
        clearCart();
        Alert.alert(
          'Pedido Confirmado! 🎉', 
          'Seu pedido foi recebido e vai começar a ser preparado.',
          [{ text: 'Ver Meus Pedidos', onPress: () => navigation.navigate('Home') }]
        );
      }

    } catch (error: any) {
      console.error('Erro ao finalizar pedido:', error);
      Alert.alert('Ops!', 'Houve um erro ao processar seu pedido. Tente novamente.');
      setIsSubmitting(false);
    }
  }

  // Prepara a lista de endereços (inverte para o mais novo ficar no topo)
  const reversedAddresses = [...addresses].reverse();
  const displayedAddresses = showAllAddresses ? reversedAddresses : reversedAddresses.slice(0, 3);

  return (
    <KeyboardAvoidingView 
      className="flex-1 bg-gray-50 dark:bg-slate-900" 
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View className="pt-16 px-6 pb-4 bg-white dark:bg-slate-800 shadow-sm z-10">
        <View className="flex-row items-center">
          <TouchableOpacity 
            onPress={() => navigation.goBack()}
            className="w-10 h-10 bg-gray-100 dark:bg-slate-900 rounded-full justify-center items-center"
          >
            <Feather name="arrow-left" size={24} color="#f97316" />
          </TouchableOpacity>
          <Text className="text-2xl font-bold text-slate-900 dark:text-white ml-4">Checkout</Text>
        </View>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 24, paddingBottom: 120 }}>
        
        <Text className="text-lg font-bold text-slate-900 dark:text-white mb-4">Como você deseja receber?</Text>
        <View className="flex-row justify-between mb-8">
          <TouchableOpacity 
            className={`flex-1 flex-row items-center justify-center py-4 rounded-xl border ${orderType === 'DELIVERY' ? 'bg-orange-50 border-orange-500 dark:bg-orange-600/20' : 'bg-white border-gray-200 dark:bg-slate-800 dark:border-slate-700'} mr-2`}
            onPress={() => setOrderType('DELIVERY')}
          >
            <Feather name="truck" size={20} color={orderType === 'DELIVERY' ? '#f97316' : (activeTheme === 'dark' ? '#9ca3af' : '#64748b')} />
            <Text className={`ml-2 font-bold ${orderType === 'DELIVERY' ? 'text-orange-600 dark:text-orange-500' : 'text-slate-500 dark:text-slate-400'}`}>Entrega</Text>
          </TouchableOpacity>

          <TouchableOpacity 
            className={`flex-1 flex-row items-center justify-center py-4 rounded-xl border ${orderType === 'TAKEOUT' ? 'bg-orange-50 border-orange-500 dark:bg-orange-600/20' : 'bg-white border-gray-200 dark:bg-slate-800 dark:border-slate-700'} ml-2`}
            onPress={() => setOrderType('TAKEOUT')}
          >
            <Feather name="shopping-bag" size={20} color={orderType === 'TAKEOUT' ? '#f97316' : (activeTheme === 'dark' ? '#9ca3af' : '#64748b')} />
            <Text className={`ml-2 font-bold ${orderType === 'TAKEOUT' ? 'text-orange-600 dark:text-orange-500' : 'text-slate-500 dark:text-slate-400'}`}>Retirada</Text>
          </TouchableOpacity>
        </View>

        {orderType === 'DELIVERY' && (
          <View className="mb-8">
            <View className="flex-row justify-between items-end mb-4">
              <Text className="text-lg font-bold text-slate-900 dark:text-white">Endereço de Entrega</Text>
              
              <TouchableOpacity onPress={() => navigation.navigate('AddAddress')}>
                <Text className="text-orange-500 font-bold">+ Novo</Text>
              </TouchableOpacity>
            </View>

            {loadingAddresses ? (
              <ActivityIndicator size="small" color="#f97316" />
            ) : addresses.length === 0 ? (
              <View className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-dashed border-gray-300 dark:border-slate-600 items-center">
                <Feather name="map-pin" size={32} color={activeTheme === 'dark' ? '#475569' : '#9ca3af'} className="mb-2" />
                <Text className="text-slate-500 dark:text-slate-400 text-center">
                  Você ainda não tem endereços.{"\n"}Clique em + Novo para adicionar.
                </Text>
              </View>
            ) : (
              <View>
                {displayedAddresses.map(addr => (
                  <TouchableOpacity 
                    key={addr.id}
                    onPress={() => setSelectedAddress(addr.id)}
                    className={`p-4 rounded-xl mb-3 flex-row items-center border ${selectedAddress === addr.id ? 'border-orange-500 bg-orange-50 dark:bg-orange-600/10' : 'border-gray-200 bg-white dark:border-slate-700 dark:bg-slate-800'}`}
                  >
                    <View className={`w-5 h-5 rounded-full border-2 flex items-center justify-center mr-3 flex-shrink-0 ${selectedAddress === addr.id ? 'border-orange-500' : 'border-gray-300 dark:border-slate-600'}`}>
                      {selectedAddress === addr.id && <View className="w-2.5 h-2.5 rounded-full bg-orange-500" />}
                    </View>
                    {/* flex-1 e numberOfLines evitam que o texto escape da caixa */}
                    <View className="flex-1">
                      <Text className="font-bold text-slate-900 dark:text-white text-base" numberOfLines={1}>
                        {addr.nickname ? `${addr.nickname} - ` : ''}{addr.street}, {addr.number}
                      </Text>
                      <Text className="text-slate-500 dark:text-slate-400 text-sm" numberOfLines={1}>
                        {addr.neighborhood} - {addr.city}
                      </Text>
                    </View>
                  </TouchableOpacity>
                ))}
                
                {/* Botão sutil de "Ver Todos" (só aparece se tiver mais que 3) */}
                {addresses.length > 3 && (
                  <TouchableOpacity 
                    onPress={() => setShowAllAddresses(!showAllAddresses)}
                    className="py-2 items-center active:opacity-70"
                  >
                    <Text className="text-slate-500 dark:text-slate-400 font-medium text-sm">
                      {showAllAddresses ? 'Ocultar endereços' : `Ver todos os ${addresses.length} endereços`}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
          </View>
        )}

        <Text className="text-lg font-bold text-slate-900 dark:text-white mb-4">Forma de Pagamento</Text>
        <View className="flex-row flex-wrap justify-between mb-4">
          {['PIX', 'CARTAO_CREDITO', 'CARTAO_DEBITO', 'DINHEIRO'].map((method) => (
            <TouchableOpacity 
              key={method}
              onPress={() => setPaymentMethod(method)}
              className={`w-[48%] py-3 px-2 rounded-xl border mb-3 flex-row items-center justify-center ${paymentMethod === method ? 'border-orange-500 bg-orange-50 dark:bg-orange-600/10' : 'border-gray-200 bg-white dark:border-slate-700 dark:bg-slate-800'}`}
            >
              <Text className={`font-bold text-center text-sm ${paymentMethod === method ? 'text-orange-600 dark:text-orange-500' : 'text-slate-600 dark:text-slate-300'}`}>
                {method.replace('_', ' ')}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {paymentMethod === 'DINHEIRO' && (
          <View className="mb-8">
            <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">Troco para quanto?</Text>
            <TextInput 
              placeholder="Ex: 50, 100 ou 'Sem troco'"
              placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
              className="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl px-4 py-3 text-slate-900 dark:text-white text-base"
              value={changeFor}
              onChangeText={setChangeFor}
            />
          </View>
        )}
      </ScrollView>

      <View className="absolute bottom-0 w-full bg-white dark:bg-slate-800 border-t border-gray-200 dark:border-slate-700 p-6 pb-8 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)]">
        <View className="flex-row justify-between mb-4">
          <Text className="text-slate-500 dark:text-slate-400 text-lg">Total a Pagar:</Text>
          <Text className="text-slate-900 dark:text-white font-bold text-2xl">{formatPrice(totalCartValue)}</Text>
        </View>

        <TouchableOpacity 
          className="w-full bg-green-600 rounded-xl py-4 flex-row justify-center items-center active:scale-95 shadow-md shadow-green-600/30"
          onPress={handleFinishOrder}
          disabled={isSubmitting}
        >
          {isSubmitting ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <Text className="text-white font-bold text-lg">Confirmar Pedido</Text>
              <Feather name="check-circle" size={24} color="#fff" className="ml-2" />
            </>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}