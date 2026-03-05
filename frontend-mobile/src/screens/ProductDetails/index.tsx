import React, { useState, useContext } from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { useRoute, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Feather from '@expo/vector-icons/Feather';
import { AuthContext } from '../../contexts/AuthContext';
// Importamos a lista de rotas para o app saber pra onde pode ir
import { AppStackParamList } from '../../routes/app.routes'; 

type SignInRouteProp = {
  key: string;
  name: "SignIn";
  params: { type: 'cliente' | 'funcionario' };
};

export default function SignIn() {
  const { signIn } = useContext(AuthContext);
  const route = useRoute<SignInRouteProp>();
  
  // Navegação fortemente tipada
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  
  const loginType = route.params?.type || 'cliente';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  // --- BLINDAGEM DO BOTÃO VOLTAR ---
  function handleGoBack() {
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      // Se não tiver histórico (por causa do cache), força a ida pra Welcome
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
      
      // Logou com sucesso? Volta para a vitrine limpando o histórico!
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
      className="flex-1 bg-slate-900"
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View className="flex-1 px-6 justify-center">
        
        {/* Botão de Voltar com a função segura aplicada */}
        <TouchableOpacity 
          className="absolute top-16 left-6 w-10 h-10 bg-slate-800 rounded-full justify-center items-center z-10"
          onPress={handleGoBack}
        >
          <Feather name="arrow-left" size={24} color="#f97316" />
        </TouchableOpacity>

        <View className="mb-10 mt-10">
          <Text className="text-4xl font-bold text-white mb-2">
            {loginType === 'cliente' ? 'Bem-vindo(a)!' : 'Acesso Restrito'}
          </Text>
          <Text className="text-slate-400 text-base">
            {loginType === 'cliente' 
              ? 'Faça login para pedir seu hambúrguer.' 
              : 'Faça login com sua conta corporativa.'}
          </Text>
        </View>

        <View className="space-y-4">
          <View className="bg-slate-800 rounded-xl px-4 py-3 flex-row items-center border border-slate-700 mb-4">
            <Feather name="mail" size={20} color="#94a3b8" />
            <TextInput 
              placeholder="Digite seu e-mail"
              placeholderTextColor="#64748b"
              className="flex-1 ml-3 text-white text-base"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
            />
          </View>

          <View className="bg-slate-800 rounded-xl px-4 py-3 flex-row items-center border border-slate-700 mb-8">
            <Feather name="lock" size={20} color="#94a3b8" />
            <TextInput 
              placeholder="Sua senha"
              placeholderTextColor="#64748b"
              className="flex-1 ml-3 text-white text-base"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
            />
          </View>
        </View>

        <TouchableOpacity 
          className="w-full bg-orange-600 rounded-xl py-4 flex-row justify-center items-center active:scale-95"
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