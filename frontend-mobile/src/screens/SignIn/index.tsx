import React, { useState, useContext } from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { useRoute, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Feather from '@expo/vector-icons/Feather';
import { AuthContext } from '../../contexts/AuthContext';
import { AppStackParamList } from '../../routes/app.routes'; 

type SignInRouteProp = {
  key: string;
  name: "SignIn";
  params: { type: 'cliente' | 'funcionario' };
};

export default function SignIn() {
  const { signIn } = useContext(AuthContext);
  const route = useRoute<SignInRouteProp>();
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  
  const loginType = route.params?.type || 'cliente';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  function handleGoBack() {
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.navigate('Welcome'); 
    }
  }

  async function handleLogin() {
    if (email === '' || password === '') {
      Alert.alert('Atenção', 'Preencha todos os campos!');
      return;
    }

    setLoading(true);
    try {
      await signIn(email, password);
      navigation.reset({
        index: 0,
        routes: [{ name: 'Home' }],
      });
    } catch (error) {
      setLoading(false); 
    }
  }

  return (
    <KeyboardAvoidingView 
      className="flex-1 bg-gray-50 dark:bg-slate-900"
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View className="flex-1 px-6 justify-center">
        
        <TouchableOpacity 
          className="absolute top-16 left-6 w-10 h-10 bg-white dark:bg-slate-800 rounded-full justify-center items-center z-10 shadow-sm dark:shadow-none border border-gray-200 dark:border-transparent"
          onPress={handleGoBack}
        >
          <Feather name="arrow-left" size={24} color="#f97316" />
        </TouchableOpacity>

        <View className="mb-10 mt-10">
          <Text className="text-4xl font-bold text-slate-900 dark:text-white mb-2">
            {loginType === 'cliente' ? 'Bem-vindo(a)!' : 'Acesso Restrito'}
          </Text>
          <Text className="text-slate-500 dark:text-slate-400 text-base">
            {loginType === 'cliente' 
              ? 'Faça login para pedir seu hambúrguer.' 
              : 'Faça login com sua conta corporativa.'}
          </Text>
        </View>

        <View className="space-y-4">
          <View className="bg-white dark:bg-slate-800 rounded-xl px-4 py-3 flex-row items-center border border-gray-200 dark:border-slate-700 mb-4 shadow-sm dark:shadow-none">
            <Feather name="mail" size={20} color="#9ca3af" className="dark:text-slate-400" />
            <TextInput 
              placeholder="Digite seu e-mail"
              placeholderTextColor="#9ca3af"
              className="flex-1 ml-3 text-slate-900 dark:text-white text-base"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
            />
          </View>

          <View className="bg-white dark:bg-slate-800 rounded-xl px-4 py-3 flex-row items-center border border-gray-200 dark:border-slate-700 mb-8 shadow-sm dark:shadow-none">
            <Feather name="lock" size={20} color="#9ca3af" className="dark:text-slate-400" />
            <TextInput 
              placeholder="Sua senha"
              placeholderTextColor="#9ca3af"
              className="flex-1 ml-3 text-slate-900 dark:text-white text-base"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
            />
          </View>
        </View>

        <TouchableOpacity 
          className="w-full bg-orange-600 rounded-xl py-4 flex-row justify-center items-center active:scale-95 shadow-md shadow-orange-600/30"
          onPress={handleLogin}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text className="text-white font-bold text-lg">Entrar</Text>
          )}
        </TouchableOpacity>

      </View>
    </KeyboardAvoidingView>
  );
}