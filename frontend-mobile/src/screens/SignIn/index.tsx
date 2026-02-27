import React, { useState, useContext } from 'react';
import { 
  View, Text, TextInput, TouchableOpacity, 
  ActivityIndicator, KeyboardAvoidingView, Platform, Alert 
} from 'react-native';
import { AuthContext } from '../../contexts/AuthContext';

export default function SignIn() {
  const { signIn } = useContext(AuthContext);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleLogin() {
    if (email === '' || password === '') {
      Alert.alert('Ops', 'Preencha todos os campos!');
      return;
    }

    setLoading(true);
    try {
      await signIn(email, password);
    } catch (error) {
      Alert.alert('Erro no Login', 'Verifique suas credenciais e tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView 
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="flex-1 bg-slate-900 justify-center px-8"
    >
      <View className="items-center mb-10">
        <Text className="text-4xl font-bold text-white mb-2">
          Torres<Text className="text-orange-500">Burgers</Text>
        </Text>
        <Text className="text-slate-400 text-base text-center">
          O melhor delivery da região na palma da sua mão.
        </Text>
      </View>

      <View className="space-y-4">
        <View>
          <Text className="text-slate-300 mb-1 ml-1 font-semibold">E-mail</Text>
          <TextInput
            placeholder="Digite seu e-mail"
            placeholderTextColor="#64748b"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            className="w-full bg-slate-800 text-white rounded-xl px-4 py-4 border border-slate-700 focus:border-orange-500"
          />
        </View>

        <View>
          <Text className="text-slate-300 mb-1 ml-1 font-semibold">Senha</Text>
          <TextInput
            placeholder="Sua senha secreta"
            placeholderTextColor="#64748b"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            className="w-full bg-slate-800 text-white rounded-xl px-4 py-4 border border-slate-700 focus:border-orange-500"
          />
        </View>

        <TouchableOpacity 
          onPress={handleLogin}
          disabled={loading}
          className="w-full bg-orange-600 rounded-xl py-4 items-center justify-center mt-4 shadow-lg active:scale-95"
        >
          {loading ? (
            <ActivityIndicator size="small" color="#FFF" />
          ) : (
            <Text className="text-white font-bold text-lg">Entrar</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity className="items-center mt-4">
          <Text className="text-orange-500 font-semibold">
            Ainda não tem conta? Cadastre-se
          </Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}