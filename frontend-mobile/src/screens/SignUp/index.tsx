import React, { useState, useContext } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Feather from '@expo/vector-icons/Feather';

import { AppStackParamList } from '../../routes/app.routes';
import { ThemeContext } from '../../contexts/ThemeContext';
import api from '../../services/api';

export default function SignUp() {
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  const { activeTheme } = useContext(ThemeContext);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleRegister() {
    if (!name || !email || !password) {
      Alert.alert('Atenção', 'Nome, e-mail e senha são obrigatórios.');
      return;
    }

    if (password.length < 9) {
      Alert.alert('Senha Fraca', 'A senha deve ter no mínimo 9 caracteres, contendo letra maiúscula e um número ou símbolo.');
      return;
    }

    setLoading(true);
    try {
      await api.post('/users', {
        name,
        email,
        phone,
        password,
        role: 'CLIENT'
      });

      Alert.alert('Sucesso!', 'Conta criada com sucesso! Faça login para continuar.', [
        { text: 'Ir para Login', onPress: () => navigation.navigate('SignIn', { type: 'cliente' }) }
      ]);
    } catch (error: any) {
      const message = error.response?.data?.message || 'Erro ao criar conta. Verifique os dados.';
      Alert.alert('Ops!', Array.isArray(message) ? message[0] : message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView 
      className="flex-1 bg-gray-50 dark:bg-slate-900"
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View className="pt-16 px-6 pb-4 bg-white dark:bg-slate-800 shadow-sm z-10 flex-row items-center">
        <TouchableOpacity 
          onPress={() => navigation.goBack()}
          className="w-10 h-10 bg-gray-100 dark:bg-slate-900 rounded-full justify-center items-center"
        >
          <Feather name="arrow-left" size={24} color="#f97316" />
        </TouchableOpacity>
        <Text className="text-2xl font-bold text-slate-900 dark:text-white ml-4">Criar Conta</Text>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 24, paddingBottom: 60 }}>
        
        <Text className="text-slate-500 dark:text-slate-400 mb-8 text-base">
          Preencha os dados abaixo para criar sua conta no TorresBurgers e pedir as melhores opções da região! 🍔
        </Text>

        <View className="space-y-4 mb-8">
          <View className="bg-white dark:bg-slate-800 rounded-xl px-4 py-3 flex-row items-center border border-gray-200 dark:border-slate-700 shadow-sm dark:shadow-none">
            <Feather name="user" size={20} color={activeTheme === 'dark' ? '#9ca3af' : '#64748b'} />
            <TextInput 
              placeholder="Nome completo *"
              placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
              className="flex-1 ml-3 text-slate-900 dark:text-white text-base"
              value={name}
              onChangeText={setName}
              maxLength={50}
            />
          </View>

          <View className="bg-white dark:bg-slate-800 rounded-xl px-4 py-3 flex-row items-center border border-gray-200 dark:border-slate-700 shadow-sm dark:shadow-none">
            <Feather name="mail" size={20} color={activeTheme === 'dark' ? '#9ca3af' : '#64748b'} />
            <TextInput 
              placeholder="E-mail *"
              placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
              className="flex-1 ml-3 text-slate-900 dark:text-white text-base"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
            />
          </View>

          <View className="bg-white dark:bg-slate-800 rounded-xl px-4 py-3 flex-row items-center border border-gray-200 dark:border-slate-700 shadow-sm dark:shadow-none">
            <Feather name="phone" size={20} color={activeTheme === 'dark' ? '#9ca3af' : '#64748b'} />
            <TextInput 
              placeholder="Celular com DDD"
              placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
              className="flex-1 ml-3 text-slate-900 dark:text-white text-base"
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
              maxLength={15}
            />
          </View>

          <View className="bg-white dark:bg-slate-800 rounded-xl px-4 py-3 flex-row items-center border border-gray-200 dark:border-slate-700 shadow-sm dark:shadow-none">
            <Feather name="lock" size={20} color={activeTheme === 'dark' ? '#9ca3af' : '#64748b'} />
            <TextInput 
              placeholder="Senha forte *"
              placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
              className="flex-1 ml-3 text-slate-900 dark:text-white text-base"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
            />
          </View>
        </View>

        <TouchableOpacity 
          className="w-full bg-orange-600 rounded-xl py-4 flex-row justify-center items-center active:scale-95 shadow-md shadow-orange-600/30"
          onPress={handleRegister}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text className="text-white font-bold text-lg">Cadastrar</Text>
          )}
        </TouchableOpacity>

      </ScrollView>
    </KeyboardAvoidingView>
  );
}