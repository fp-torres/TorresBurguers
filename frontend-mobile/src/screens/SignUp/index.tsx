import React, { useState, useContext } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';

import { AppStackParamList } from '../../routes/app.routes';
import { ThemeContext } from '../../contexts/ThemeContext';
import { AuthContext } from '../../contexts/AuthContext';
import KeyboardAwareScreen, { useKeyboardVisible } from '../../components/KeyboardAwareScreen';
import { BRAND } from '../../config/brand';
import { userService } from '../../services/userService';
import { getErrorMessage } from '../../utils/errors';
import { firstName } from '../../utils/format';

// Mesmas regras do backend (CreateUserDto)
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_REGEX = /^(?=.*[A-Z])(?=.*(\d|\W)).{9,}$/;

export default function SignUp() {
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  const { activeTheme } = useContext(ThemeContext);
  const { signIn } = useContext(AuthContext);
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleRegister() {
    if (!name.trim() || !email.trim() || !password) {
      Alert.alert('Atenção', 'Nome, e-mail e senha são obrigatórios.');
      return;
    }

    if (!EMAIL_REGEX.test(email.trim())) {
      Alert.alert('E-mail inválido', 'Confira o e-mail digitado.');
      return;
    }

    const digits = phone.replace(/\D/g, '');
    if (digits && digits.length < 10) {
      Alert.alert('Telefone inválido', 'Informe o celular com DDD (ex.: 21999999999) ou deixe o campo em branco.');
      return;
    }

    if (!PASSWORD_REGEX.test(password)) {
      Alert.alert('Senha Fraca', 'A senha deve ter no mínimo 9 caracteres, contendo letra maiúscula e um número ou símbolo.');
      return;
    }

    setLoading(true);
    try {
      // Telefone vazio não é enviado (o backend trata o campo como opcional)
      await userService.create({ name, email, phone: digits || undefined, password });
    } catch (error) {
      setLoading(false);
      Alert.alert('Ops!', getErrorMessage(error, 'Erro ao criar conta. Verifique os dados.'));
      return;
    }

    try {
      // Já entra na conta nova: as telas de acesso saem da pilha e o cliente volta para a loja/carrinho
      const user = await signIn(email, password);
      Alert.alert('Conta criada! 🎉', `Bem-vindo(a), ${firstName(user.name)}! Você já está conectado(a).`);
    } catch {
      setLoading(false);
      Alert.alert('Conta criada!', 'Faça login para continuar.', [
        { text: 'Ir para Login', onPress: () => navigation.popTo('SignIn', { type: 'cliente' }) }
      ]);
    }
  }

  return (
    <KeyboardAwareScreen className="flex-1 bg-gray-50 dark:bg-slate-900">
      <View className="px-6 pb-4 bg-white dark:bg-slate-800 shadow-sm z-10 flex-row items-center" style={{ paddingTop: insets.top + 16 }}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          className="w-10 h-10 bg-gray-100 dark:bg-slate-900 rounded-full justify-center items-center"
          accessibilityRole="button"
          accessibilityLabel="Voltar"
        >
          <Feather name="arrow-left" size={24} color="#f97316" />
        </TouchableOpacity>
        <Text className="text-2xl font-bold text-slate-900 dark:text-white ml-4">Criar Conta</Text>
      </View>

      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 24 }}
      >

        <Text className="text-slate-500 dark:text-slate-400 mb-8 text-base">
          Preencha os dados abaixo para criar sua conta no {BRAND.name} e pedir as melhores opções da região! 🍔
        </Text>

        <View>
          <View className="bg-white dark:bg-slate-800 rounded-xl px-4 mb-4 flex-row items-center border border-gray-200 dark:border-slate-700 shadow-sm dark:shadow-none">
            <Feather name="user" size={20} color={activeTheme === 'dark' ? '#9ca3af' : '#64748b'} />
            <TextInput
              placeholder="Nome completo *"
              placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
              className="flex-1 ml-3 py-4 text-slate-900 dark:text-white text-base"
              value={name}
              onChangeText={setName}
              maxLength={50}
              autoComplete="name"
            />
          </View>

          <View className="bg-white dark:bg-slate-800 rounded-xl px-4 mb-4 flex-row items-center border border-gray-200 dark:border-slate-700 shadow-sm dark:shadow-none">
            <Feather name="mail" size={20} color={activeTheme === 'dark' ? '#9ca3af' : '#64748b'} />
            <TextInput
              placeholder="E-mail *"
              placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
              className="flex-1 ml-3 py-4 text-slate-900 dark:text-white text-base"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
            />
          </View>

          <View className="bg-white dark:bg-slate-800 rounded-xl px-4 mb-4 flex-row items-center border border-gray-200 dark:border-slate-700 shadow-sm dark:shadow-none">
            <Feather name="phone" size={20} color={activeTheme === 'dark' ? '#9ca3af' : '#64748b'} />
            <TextInput
              placeholder="Celular com DDD (opcional)"
              placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
              className="flex-1 ml-3 py-4 text-slate-900 dark:text-white text-base"
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
              maxLength={15}
              autoComplete="tel"
            />
          </View>

          <View className="bg-white dark:bg-slate-800 rounded-xl px-4 flex-row items-center border border-gray-200 dark:border-slate-700 shadow-sm dark:shadow-none">
            <Feather name="lock" size={20} color={activeTheme === 'dark' ? '#9ca3af' : '#64748b'} />
            <TextInput
              placeholder="Senha forte *"
              placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
              className="flex-1 ml-3 py-4 text-slate-900 dark:text-white text-base"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              autoComplete="new-password"
            />
          </View>
          <Text className="text-xs text-slate-400 dark:text-slate-500 mt-2 ml-1">
            Mínimo de 9 caracteres, com letra maiúscula e um número ou símbolo.
          </Text>
        </View>

      </ScrollView>

      {/* Rodapé no fluxo: o botão de cadastrar fica visível acima do teclado */}
      <View
        className="bg-white dark:bg-slate-800 border-t border-gray-200 dark:border-slate-700 px-6 pt-4"
        style={{ paddingBottom: keyboardVisible ? 12 : Math.max(insets.bottom, 8) + 16 }}
      >
        <TouchableOpacity
          className="w-full bg-orange-600 rounded-xl py-4 flex-row justify-center items-center active:scale-95 shadow-md shadow-orange-600/30"
          onPress={handleRegister}
          disabled={loading}
          accessibilityRole="button"
        >
          {loading ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text className="text-white font-bold text-lg">Cadastrar</Text>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAwareScreen>
  );
}
