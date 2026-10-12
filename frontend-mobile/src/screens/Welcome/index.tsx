import React from 'react';
import { View, Text, TouchableOpacity, Image } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import Feather from '@expo/vector-icons/Feather';

import { AppStackParamList, LoginType } from '../../routes/app.routes';
import { BRAND } from '../../config/brand';
import BrandWordmark from '../../components/BrandWordmark';

export default function Welcome() {
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  const insets = useSafeAreaInsets();

  function handleNavigateToSignIn(type: LoginType) {
    navigation.navigate('SignIn', { type });
  }

  function handleGoBack() {
    // Volta para a loja sem empilhar outra Home
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.popTo('Home');
  }

  return (
    <View className="flex-1 bg-gray-50 dark:bg-slate-900 justify-center items-center p-6">

      {/* BOTÃO VOLTAR */}
      <TouchableOpacity
        className="absolute left-6 w-10 h-10 bg-white dark:bg-slate-800 rounded-full justify-center items-center z-10 shadow-sm dark:shadow-none border border-gray-200 dark:border-transparent"
        style={{ top: insets.top + 12 }}
        onPress={handleGoBack}
        accessibilityRole="button"
        accessibilityLabel="Voltar para a loja"
      >
        <Feather name="arrow-left" size={24} color="#f97316" />
      </TouchableOpacity>

      {/* Logo do App */}
      <View className="items-center mb-16 mt-10">
        <Image
          source={require('../../../assets/icon.png')}
          className="w-24 h-24 rounded-3xl mb-5"
        />
        <BrandWordmark size="xl" />
        <Text className="text-slate-500 dark:text-slate-400 mt-2 text-base text-center px-4">
          {BRAND.tagline}
        </Text>
      </View>

      {/* Botões de Ação */}
      <View className="w-full">

        {/* Botão Login Normal (Cliente) */}
        <TouchableOpacity
          className="w-full bg-orange-600 py-4 rounded-xl flex-row justify-center items-center active:scale-95 mb-4 shadow-md shadow-orange-600/30"
          onPress={() => handleNavigateToSignIn('cliente')}
        >
          <Feather name="user" size={20} color="#fff" />
          <Text className="text-white font-bold text-lg ml-2">Entrar como Cliente</Text>
        </TouchableOpacity>

        {/* Botão Login Funcionário */}
        <TouchableOpacity
          className="w-full bg-white dark:bg-slate-800 py-4 rounded-xl flex-row justify-center items-center border border-gray-200 dark:border-slate-700 active:scale-95 shadow-sm dark:shadow-none"
          onPress={() => handleNavigateToSignIn('funcionario')}
        >
          <Feather name="briefcase" size={20} color="#f97316" />
          <Text className="text-orange-500 font-bold text-lg ml-2">Acesso de Funcionário</Text>
        </TouchableOpacity>

        <TouchableOpacity className="mt-6 items-center" onPress={() => navigation.navigate('SignUp')}>
          <Text className="text-slate-500 dark:text-slate-400 text-base">
            Novo por aqui? <Text className="text-orange-600 dark:text-orange-500 font-bold">Crie sua conta</Text>
          </Text>
        </TouchableOpacity>

      </View>

      {/* Rodapé */}
      <Text className="text-slate-400 dark:text-slate-500 text-sm absolute" style={{ bottom: insets.bottom + 16 }}>
        Versão {Constants.expoConfig?.version ?? '1.0.0'}
      </Text>
    </View>
  );
}
