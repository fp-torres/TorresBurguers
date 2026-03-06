import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import Feather from '@expo/vector-icons/Feather';

export default function Checkout() {
  const navigation = useNavigation();

  return (
    <View className="flex-1 bg-slate-900 pt-16 px-6">
      <View className="flex-row items-center mb-6">
        <TouchableOpacity 
          onPress={() => navigation.goBack()}
          className="w-10 h-10 bg-slate-800 rounded-full justify-center items-center"
        >
          <Feather name="arrow-left" size={24} color="#f97316" />
        </TouchableOpacity>
        <Text className="text-2xl font-bold text-white ml-4">Finalizar Pedido</Text>
      </View>

      <Text className="text-white mt-10 text-center">
        A tela de pagamento será construída aqui! 🚀
      </Text>
    </View>
  );
}