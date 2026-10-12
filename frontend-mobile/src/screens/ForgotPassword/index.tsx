import React from 'react';
import { View, Text, TouchableOpacity, Alert, Linking, ScrollView } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';

import { BRAND } from '../../config/brand';

/**
 * Não existe recuperação automática de senha: um administrador redefine a senha
 * pela tela de Usuários do painel, ou o cliente fala com o suporte.
 */
export default function ForgotPassword() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  async function handleContactSupport() {
    const subject = encodeURIComponent(`Redefinição de senha - ${BRAND.name}`);
    const body = encodeURIComponent('Olá! Preciso redefinir a senha da minha conta. Meu e-mail de cadastro é: ');
    const url = `mailto:${BRAND.supportEmail}?subject=${subject}&body=${body}`;
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert('Fale com o suporte', `Envie um e-mail para ${BRAND.supportEmail} informando o e-mail da sua conta.`);
    }
  }

  return (
    <View className="flex-1 bg-gray-50 dark:bg-slate-900">
      <View className="px-6 pb-4 bg-white dark:bg-slate-800 shadow-sm z-10 flex-row items-center" style={{ paddingTop: insets.top + 16 }}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          className="w-10 h-10 bg-gray-100 dark:bg-slate-900 rounded-full justify-center items-center"
          accessibilityRole="button"
          accessibilityLabel="Voltar"
        >
          <Feather name="arrow-left" size={24} color="#f97316" />
        </TouchableOpacity>
        <Text className="text-2xl font-bold text-slate-900 dark:text-white ml-4">Recuperar Senha</Text>
      </View>

      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24, paddingBottom: insets.bottom + 60 }}>
        <View className="items-center mb-8">
          <View className="w-20 h-20 bg-orange-100 dark:bg-orange-900/30 rounded-full items-center justify-center mb-6">
            <Feather name="key" size={32} color="#f97316" />
          </View>
          <Text className="text-xl font-bold text-slate-900 dark:text-white text-center mb-3">
            Esqueceu sua senha?
          </Text>
          <Text className="text-slate-500 dark:text-slate-400 text-center text-base leading-6">
            Por segurança, a senha é redefinida pela nossa equipe: um administrador pode criar uma nova senha
            para você na tela de Usuários do painel.
          </Text>
        </View>

        <View className="bg-white dark:bg-slate-800 rounded-2xl p-5 border border-gray-100 dark:border-slate-700 mb-6">
          <View className="flex-row items-start mb-4">
            <Feather name="briefcase" size={18} color="#ea580c" style={{ marginTop: 2 }} />
            <Text className="text-slate-600 dark:text-slate-300 ml-3 flex-1">
              <Text className="font-bold text-slate-900 dark:text-white">Faz parte da equipe? </Text>
              Peça ao administrador da loja para redefinir sua senha.
            </Text>
          </View>
          <View className="flex-row items-start">
            <Feather name="mail" size={18} color="#ea580c" style={{ marginTop: 2 }} />
            <Text className="text-slate-600 dark:text-slate-300 ml-3 flex-1">
              <Text className="font-bold text-slate-900 dark:text-white">É cliente? </Text>
              Escreva para {BRAND.supportEmail} com o e-mail da sua conta.
            </Text>
          </View>
        </View>

        <TouchableOpacity
          className="w-full bg-orange-600 rounded-xl py-4 flex-row justify-center items-center active:scale-95 shadow-md shadow-orange-600/30 mb-4"
          onPress={handleContactSupport}
        >
          <Feather name="mail" size={20} color="#fff" />
          <Text className="text-white font-bold text-lg ml-2">Falar com o suporte</Text>
        </TouchableOpacity>

        <TouchableOpacity className="py-3 items-center" onPress={() => navigation.goBack()}>
          <Text className="text-orange-600 dark:text-orange-500 font-bold text-base">Voltar ao login</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}
