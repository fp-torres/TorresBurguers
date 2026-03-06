import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { AppStackParamList } from '../../routes/app.routes'; 
import Feather from '@expo/vector-icons/Feather';

export default function Welcome() {
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();

  function handleNavigateToSignIn(type: 'cliente' | 'funcionario') {
    navigation.navigate('SignIn', { type });
  }

  return (
    <View className="flex-1 bg-gray-50 dark:bg-slate-900 justify-center items-center p-6">
      
      {/* BOTÃO VOLTAR */}
      <TouchableOpacity 
        className="absolute top-16 left-6 w-10 h-10 bg-white dark:bg-slate-800 rounded-full justify-center items-center z-10 shadow-sm dark:shadow-none border border-gray-200 dark:border-transparent"
        onPress={() => navigation.navigate('Home')}
      >
        <Feather name="arrow-left" size={24} color="#f97316" />
      </TouchableOpacity>

      {/* Logo do App */}
      <View className="items-center mb-16 mt-10">
        <View className="w-24 h-24 bg-white dark:bg-slate-800 rounded-full items-center justify-center mb-4 shadow-md dark:shadow-lg border border-gray-100 dark:border-slate-700">
          <Text className="text-4xl">🍔</Text>
        </View>
        <Text className="text-4xl font-bold text-slate-900 dark:text-white">
          Torres<Text className="text-orange-500">Burgers</Text>
        </Text>
        <Text className="text-slate-500 dark:text-slate-400 mt-2 text-base text-center px-4">
          O melhor delivery da região, agora na palma da sua mão.
        </Text>
      </View>

      {/* Botões de Ação */}
      <View className="w-full space-y-4">
        
        {/* Botão Login Normal (Cliente) */}
        <TouchableOpacity 
          className="w-full bg-orange-600 py-4 rounded-xl flex-row justify-center items-center active:scale-95 mb-4 shadow-md shadow-orange-600/30"
          onPress={() => handleNavigateToSignIn('cliente')}
        >
          <Feather name="user" size={20} color="#fff" className="mr-2" />
          <Text className="text-white font-bold text-lg ml-2">Entrar como Cliente</Text>
        </TouchableOpacity>

        {/* Botão Login Funcionário */}
        <TouchableOpacity 
          className="w-full bg-white dark:bg-slate-800 py-4 rounded-xl flex-row justify-center items-center border border-gray-200 dark:border-slate-700 active:scale-95 shadow-sm dark:shadow-none"
          onPress={() => handleNavigateToSignIn('funcionario')}
        >
          <Feather name="briefcase" size={20} color="#f97316" className="mr-2" />
          <Text className="text-orange-500 font-bold text-lg ml-2">Acesso de Funcionário</Text>
        </TouchableOpacity>

      </View>

      {/* Rodapé */}
      <Text className="text-slate-400 dark:text-slate-500 text-sm absolute bottom-8">
        Versão 1.0.0
      </Text>
    </View>
  );
}