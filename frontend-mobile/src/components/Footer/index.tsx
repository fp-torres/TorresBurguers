import React, { useContext } from 'react';
import { View, Text, TouchableOpacity, TextInput } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { AppStackParamList } from '../../routes/app.routes';
import { ThemeContext } from '../../contexts/ThemeContext';

export default function Footer() {
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  const { activeTheme } = useContext(ThemeContext);

  const isDark = activeTheme === 'dark';

  return (
    <View className="bg-white dark:bg-slate-950 pt-10 pb-24 border-t-4 border-orange-600 mt-8 px-6">
      
      {/* Sobre a Loja */}
      <View className="mb-8">
        <Text className="text-2xl font-bold text-slate-900 dark:text-white mb-2">
          Torres<Text className="text-orange-600">Burgers</Text>
        </Text>
        <Text className="text-slate-500 dark:text-slate-400 text-sm leading-6 mb-4">
          O autêntico sabor artesanal. Ingredientes selecionados, carne suculenta e receitas exclusivas feitas para você.
        </Text>
        <View className="flex-row gap-4">
          <TouchableOpacity className="bg-gray-100 dark:bg-slate-900 p-2.5 rounded-lg border border-transparent dark:border-slate-800">
            <Feather name="instagram" size={20} color={isDark ? '#9ca3af' : '#64748b'} />
          </TouchableOpacity>
          <TouchableOpacity className="bg-gray-100 dark:bg-slate-900 p-2.5 rounded-lg border border-transparent dark:border-slate-800">
            <Feather name="facebook" size={20} color={isDark ? '#9ca3af' : '#64748b'} />
          </TouchableOpacity>
          <TouchableOpacity className="bg-gray-100 dark:bg-slate-900 p-2.5 rounded-lg border border-transparent dark:border-slate-800">
            <Feather name="twitter" size={20} color={isDark ? '#9ca3af' : '#64748b'} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Navegação Rápida */}
      <View className="mb-8">
        <Text className="text-slate-900 dark:text-white font-bold text-lg mb-4">Navegação</Text>
        <View className="space-y-3">
          {['Cardápio Completo', 'Meu Carrinho', 'Acompanhar Pedidos'].map((item, index) => (
            <TouchableOpacity key={index} className="flex-row items-center gap-2 py-1">
              <View className="w-1.5 h-1.5 bg-orange-600 rounded-full" />
              <Text className="text-slate-600 dark:text-slate-400 text-sm">{item}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Atendimento */}
      <View className="mb-8">
        <Text className="text-slate-900 dark:text-white font-bold text-lg mb-4">Atendimento</Text>
        <View className="space-y-4">
          <View className="flex-row items-start gap-3">
            <Feather name="map-pin" size={18} color="#ea580c" className="mt-0.5" />
            <Text className="text-slate-600 dark:text-slate-400 text-sm flex-1">Rua das Flores, 123 - Centro{'\n'}Rio de Janeiro - RJ</Text>
          </View>
          <View className="flex-row items-start gap-3">
            <Feather name="clock" size={18} color="#ea580c" className="mt-0.5" />
            <View>
              <Text className="font-bold text-slate-900 dark:text-white text-sm">Terça a Domingo</Text>
              <Text className="text-slate-600 dark:text-slate-400 text-sm">12:00 às 04:00 (Madrugada)</Text>
            </View>
          </View>
          <View className="flex-row items-center gap-3">
            <Feather name="phone" size={18} color="#ea580c" />
            <Text className="text-slate-600 dark:text-slate-400 text-sm">(21) 99999-9999</Text>
          </View>
        </View>
      </View>

      {/* Descontos (Newsletter) */}
      <View className="mb-8">
        <Text className="text-slate-900 dark:text-white font-bold text-lg mb-2">Ganhe Descontos</Text>
        <Text className="text-slate-600 dark:text-slate-400 text-sm mb-4">Receba ofertas exclusivas e cupons secretos.</Text>
        <View className="flex-row gap-2">
          <TextInput 
            placeholder="Seu e-mail"
            placeholderTextColor={isDark ? '#64748b' : '#9ca3af'}
            className="flex-1 bg-gray-50 dark:bg-slate-900 text-slate-900 dark:text-white px-4 py-3 rounded-lg border border-gray-200 dark:border-slate-800 text-sm"
          />
          <TouchableOpacity className="bg-orange-600 px-4 justify-center items-center rounded-lg active:scale-95">
            <Feather name="arrow-right" size={20} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Direitos e Acesso Func */}
      <View className="border-t border-gray-100 dark:border-slate-800 pt-6 items-center">
        <Text className="text-xs text-slate-500 mb-4 text-center">
          &copy; 2026 TorresBurgers. Todos os direitos reservados.
        </Text>
        <TouchableOpacity onPress={() => navigation.navigate('SignIn', { type: 'funcionario' })}>
          <Text className="text-xs text-orange-600 font-bold">Área do Funcionário</Text>
        </TouchableOpacity>
      </View>
      
    </View>
  );
}