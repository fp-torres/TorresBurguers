import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
// AQUI: Puxando do app.routes que unificamos!
import { AppStackParamList } from '../../routes/app.routes'; 
import Feather from '@expo/vector-icons/Feather';

export default function Welcome() {
  // AQUI: Usando o AppStackParamList
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();

  // Função para navegar para a tela de SignIn avisando qual botão foi clicado
  function handleNavigateToSignIn(type: 'cliente' | 'funcionario') {
    navigation.navigate('SignIn', { type });
  }

  return (
    <View className="flex-1 bg-slate-900 justify-center items-center p-6">
      
      {/* Logo do App */}
      <View className="items-center mb-16">
        <View className="w-24 h-24 bg-slate-800 rounded-full items-center justify-center mb-4 shadow-lg border border-slate-700">
          <Text className="text-4xl">🍔</Text>
        </View>
        <Text className="text-4xl font-bold text-white">
          Torres<Text className="text-orange-500">Burgers</Text>
        </Text>
        <Text className="text-slate-400 mt-2 text-base text-center">
          O melhor delivery da região, agora na palma da sua mão.
        </Text>
      </View>

      {/* Botões de Ação */}
      <View className="w-full space-y-4">
        
        {/* Botão Login Normal (Cliente) */}
        <TouchableOpacity 
          className="w-full bg-orange-600 py-4 rounded-xl flex-row justify-center items-center active:scale-95 mb-4"
          onPress={() => handleNavigateToSignIn('cliente')}
        >
          <Feather name="user" size={20} color="#fff" className="mr-2" />
          <Text className="text-white font-bold text-lg ml-2">Entrar como Cliente</Text>
        </TouchableOpacity>

        {/* Botão Login Funcionário */}
        <TouchableOpacity 
          className="w-full bg-slate-800 py-4 rounded-xl flex-row justify-center items-center border border-slate-700 active:scale-95"
          onPress={() => handleNavigateToSignIn('funcionario')}
        >
          <Feather name="briefcase" size={20} color="#f97316" className="mr-2" />
          <Text className="text-orange-500 font-bold text-lg ml-2">Acesso Restrito</Text>
        </TouchableOpacity>

      </View>

      {/* Rodapé */}
      <Text className="text-slate-500 text-sm absolute bottom-8">
        Versão 1.0.0
      </Text>
    </View>
  );
}