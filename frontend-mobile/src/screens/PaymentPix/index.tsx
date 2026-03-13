import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, Image, Alert, ActivityIndicator, SafeAreaView, ScrollView } from 'react-native';
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
            { text: 'Voltar', onPress: () => navigation.reset({ index: 0, routes: [{ name: 'Home' }] }) }
          ]);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    // 2. Polling: Checa o status do pagamento a cada 5 segundos
    const poller = setInterval(async () => {
      try {
        setChecking(true);
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
      } finally {
        // Faz o ícone de loading piscar suavemente dando sensação de busca real
        setTimeout(() => setChecking(false), 1000); 
      }
    }, 5000);

    // O retorno do useEffect limpa os intervalos caso o usuário saia da tela
    return () => {
      clearInterval(timer);
      clearInterval(poller);
    };
  }, [payment_id]);

  const copyToClipboard = async () => {
    await Clipboard.setStringAsync(qr_code);
    Alert.alert('Copiado!', 'Código PIX copiado para a área de transferência.');
  };

  const handleCancelPayment = () => {
    Alert.alert(
      'Cancelar Pagamento',
      'Tem certeza que deseja cancelar? O seu pedido não será preparado.',
      [
        { text: 'Não', style: 'cancel' },
        { 
          text: 'Sim, cancelar', 
          style: 'destructive',
          onPress: () => {
            // Como a limpeza dos timers está no return do useEffect, 
            // basta navegar para a Home que o polling morre automaticamente.
            navigation.reset({ index: 0, routes: [{ name: 'Home' }] });
          }
        }
      ]
    );
  };

  const minutes = Math.floor(timeLeft / 60);
  const seconds = timeLeft % 60;
  const timeString = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

  const formatPrice = (price: number) => {
    return Number(price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };

  return (
    <SafeAreaView className="flex-1 bg-slate-900">
      
      {/* CABEÇALHO COM BOTÃO DE VOLTAR */}
      <View className="flex-row items-center px-6 pt-12 pb-4">
        <TouchableOpacity 
          onPress={handleCancelPayment}
          className="w-10 h-10 bg-slate-800 rounded-full justify-center items-center active:scale-95"
        >
          <Feather name="arrow-left" size={24} color="#fff" />
        </TouchableOpacity>
        <Text className="text-xl font-bold text-white ml-4">Finalizar Pagamento</Text>
      </View>

      <ScrollView 
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24, paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
      >
        <View className="bg-white w-full rounded-3xl p-8 items-center shadow-lg">
          
          <View className="w-16 h-16 bg-teal-100 rounded-full items-center justify-center mb-4">
            <Image source={{ uri: 'https://logospng.org/download/pix/logo-pix-icone-1024.png' }} className="w-8 h-8" resizeMode="contain" />
          </View>

          <Text className="text-2xl font-bold text-slate-900 mb-2">Pague com PIX</Text>
          <Text className="text-slate-500 text-center mb-6">
            Abra o app do seu banco, escolha PIX e aponte a câmera, ou cole o código abaixo.
          </Text>

          <Text className="text-3xl font-bold text-teal-600 mb-6">{formatPrice(total)}</Text>

          {/* QR CODE */}
          <View className="p-2 border-2 border-dashed border-gray-300 rounded-2xl mb-6 bg-white">
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

          <View className="flex-row items-center justify-center mb-4">
            {checking ? (
              <ActivityIndicator size="small" color="#0f766e" className="mr-2" />
            ) : (
              <Feather name="loader" size={16} color="#64748b" className="mr-2" />
            )}
            <Text className="text-slate-500 font-medium">Aguardando pagamento...</Text>
          </View>

          <View className="bg-orange-50 px-4 py-2 rounded-full mb-6 flex-row items-center">
            <Feather name="clock" size={16} color="#ea580c" /> 
            <Text className="text-orange-600 font-bold ml-2">Expira em: {timeString}</Text>
          </View>

          {/* BOTÃO DE CANCELAR */}
          <TouchableOpacity 
            className="flex-row items-center justify-center py-3 px-4 active:scale-95 rounded-lg hover:bg-red-50"
            onPress={handleCancelPayment}
          >
            <Feather name="x-circle" size={18} color="#ef4444" />
            <Text className="text-red-500 font-bold text-base ml-2">Cancelar Pedido</Text>
          </TouchableOpacity>

        </View>
      </ScrollView>

    </SafeAreaView>
  );
}