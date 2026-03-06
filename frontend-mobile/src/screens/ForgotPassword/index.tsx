import React, { useState, useContext } from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import Feather from '@expo/vector-icons/Feather';

import { ThemeContext } from '../../contexts/ThemeContext';
import api from '../../services/api';

export default function ForgotPassword() {
  const navigation = useNavigation();
  const { activeTheme } = useContext(ThemeContext);

  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleResetPassword() {
    if (!email) {
      Alert.alert('Atenção', 'Digite seu e-mail cadastrado.');
      return;
    }

    setLoading(true);
    try {
      // Rota que você precisa criar no backend NestJS (AuthController)
      await api.post('/auth/forgot-password', { email });
      
      Alert.alert(
        'E-mail Enviado!', 
        'Se este e-mail estiver cadastrado, você receberá as instruções para redefinir sua senha.',
        [{ text: 'Voltar ao Login', onPress: () => navigation.goBack() }]
      );
    } catch (error) {
      console.error(error);
      Alert.alert('Ops', 'Ocorreu um erro ao tentar recuperar a senha.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView 
      className="flex-1 bg-gray-50 dark:bg-slate-900"
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View className="pt-16 px-6 pb-4 bg-white dark:bg-slate-800 shadow-sm z-10 flex-row items-center">
        <TouchableOpacity 
          onPress={() => navigation.goBack()}
          className="w-10 h-10 bg-gray-100 dark:bg-slate-900 rounded-full justify-center items-center"
        >
          <Feather name="arrow-left" size={24} color="#f97316" />
        </TouchableOpacity>
        <Text className="text-2xl font-bold text-slate-900 dark:text-white ml-4">Recuperar Senha</Text>
      </View>

      <View className="flex-1 px-6 justify-center pb-20">
        <View className="items-center mb-8">
          <View className="w-20 h-20 bg-orange-100 dark:bg-orange-900/30 rounded-full items-center justify-center mb-6">
            <Feather name="key" size={32} color="#f97316" />
          </View>
          <Text className="text-slate-500 dark:text-slate-400 text-center text-base leading-6">
            Não se preocupe! Digite o e-mail associado à sua conta e enviaremos as instruções para você redefinir sua senha.
          </Text>
        </View>

        <View className="bg-white dark:bg-slate-800 rounded-xl px-4 py-3 flex-row items-center border border-gray-200 dark:border-slate-700 shadow-sm dark:shadow-none mb-6">
          <Feather name="mail" size={20} color={activeTheme === 'dark' ? '#9ca3af' : '#64748b'} />
          <TextInput 
            placeholder="Seu e-mail de cadastro"
            placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
            className="flex-1 ml-3 text-slate-900 dark:text-white text-base"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
          />
        </View>

        <TouchableOpacity 
          className="w-full bg-orange-600 rounded-xl py-4 flex-row justify-center items-center active:scale-95 shadow-md shadow-orange-600/30"
          onPress={handleResetPassword}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text className="text-white font-bold text-lg">Enviar Instruções</Text>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}