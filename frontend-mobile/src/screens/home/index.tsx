import React, { useContext } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { AuthContext } from '../../contexts/AuthContext';

export default function Home() {
  const { signOut, user } = useContext(AuthContext);
  
  return (
    <View className="flex-1 items-center justify-center p-6 bg-slate-900">
      <Text className="text-3xl font-bold text-white mb-2">
        Torres<Text className="text-orange-500">Burgers</Text>
      </Text>
      <Text className="text-xl font-medium text-slate-300 mb-8">
        Olá, <Text className="text-orange-500 font-bold">{user?.name}</Text>! 👋
      </Text>
      
      <Text className="text-slate-400 text-center mb-8">
        Em breve seus hambúrgueres aparecerão aqui! 🍔
      </Text>

      <TouchableOpacity 
        onPress={signOut}
        className="bg-red-600 px-8 py-4 rounded-xl shadow-lg active:scale-95"
      >
        <Text className="text-white font-bold text-lg">Sair da Conta</Text>
      </TouchableOpacity>
    </View>
  );
}