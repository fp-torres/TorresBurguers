import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, Image, Alert, ActivityIndicator } from 'react-native';
import { useRoute, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Clipboard from 'expo-clipboard';
import Feather from '@expo/vector-icons/Feather';

import { AppStackParamList } from '../../routes/app.routes';
import api from '../../services/api';

type PixRouteProp = {
  key: string;
  name: "PaymentPix";
  params: { payment_id: number; qr_code: string; qr_code_base64: string; total: number };
};

export default function PaymentPix() {
  const route = useRoute<PixRouteProp>();
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  const { payment_id, qr_code, qr_code_base64, total } = route.params;

  const [timeLeft, setTimeLeft] = useState(600); // 10 minutos (600 segundos)
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    // 1. Timer Regressivo
    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          Alert.alert('Tempo esgotado', 'O QR Code do PIX expirou.', [
            { text: 'Voltar', onPress: () => navigation.navigate('Home') }
          ]);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    // 2. Polling: Checa o status do pagamento a cada 5 segundos
    const poller = setInterval(async () => {
      try {
        const response = await api.get(`/payment/status/${payment_id}`);
        if (response.data.status === 'approved') {
          clearInterval(timer);
          clearInterval(poller);
          Alert.alert('Pagamento Aprovado! 🎉', 'Seu PIX foi confirmado e a cozinha já começou a preparar!', [
            { text: 'Ir para Pedidos', onPress: () => navigation.reset({ index: 0, routes: [{ name: 'Home' }] }) }
          ]);
        }
      } catch (e) {
        // Ignora erros silenciosos do polling
      }
    }, 5000);

    return () => {
      clearInterval(timer);
      clearInterval(poller);
    };
  }, [payment_id]);

  const copyToClipboard = async () => {
    await Clipboard.setStringAsync(qr_code);
    Alert.alert('Copiado!', 'Código PIX copiado para a área de transferência.');
  };

  const minutes = Math.floor(timeLeft / 60);
  const seconds = timeLeft % 60;
  const timeString = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

  const formatPrice = (price: number) => {
    return Number(price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };

  return (
    <View className="flex-1 bg-slate-900 justify-center items-center px-6">
      
      <View className="bg-white w-full rounded-3xl p-8 items-center shadow-lg">
        <View className="w-16 h-16 bg-teal-100 rounded-full items-center justify-center mb-4">
          <Image source={{ uri: 'https://logospng.org/download/pix/logo-pix-icone-1024.png' }} className="w-8 h-8" resizeMode="contain" />
        </View>

        <Text className="text-2xl font-bold text-slate-900 mb-2">Pague com PIX</Text>
        <Text className="text-slate-500 text-center mb-6">
          Abra o app do seu banco, escolha PIX e aponte a câmera, ou cole o código abaixo.
        </Text>

        <Text className="text-3xl font-bold text-teal-600 mb-6">{formatPrice(total)}</Text>

        {/* QR CODE (Base64 vindo do backend) */}
        <View className="p-2 border-2 border-dashed border-gray-300 rounded-2xl mb-6">
          <Image 
            source={{ uri: `data:image/jpeg;base64,${qr_code_base64}` }} 
            className="w-48 h-48"
          />
        </View>

        <TouchableOpacity 
          className="bg-slate-100 flex-row items-center justify-center py-4 px-6 rounded-xl w-full active:scale-95 mb-6"
          onPress={copyToClipboard}
        >
          <Feather name="copy" size={20} color="#0f766e" />
          <Text className="text-teal-700 font-bold text-lg ml-2">Copiar Código PIX</Text>
        </TouchableOpacity>

        <View className="flex-row items-center justify-center mb-2">
          {checking ? <ActivityIndicator size="small" color="#0f766e" className="mr-2" /> : <Feather name="loader" size={16} color="#64748b" className="mr-2" />}
          <Text className="text-slate-500 font-medium">Aguardando pagamento...</Text>
        </View>

        <Text className="text-red-500 font-bold text-lg mt-2 flex-row items-center">
          <Feather name="clock" size={18} color="#ef4444" /> Expira em: {timeString}
        </Text>
      </View>

    </View>
  );
}