import React, { useState, useContext, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, Alert, ScrollView } from 'react-native';
import { RouteProp, useRoute, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';

import { AuthContext, ROLE_CHANGED_MESSAGE } from '../../contexts/AuthContext';
import { ThemeContext } from '../../contexts/ThemeContext';
import KeyboardAwareScreen from '../../components/KeyboardAwareScreen';
import { AppStackParamList } from '../../routes/app.routes';
import { getErrorMessage, getErrorStatus } from '../../utils/errors';

export default function SignIn() {
  const { signIn } = useContext(AuthContext);
  const { activeTheme } = useContext(ThemeContext);
  const route = useRoute<RouteProp<AppStackParamList, 'SignIn'>>();
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  const insets = useSafeAreaInsets();

  const loginType = route.params?.type ?? 'cliente';
  const notice = route.params?.notice;

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const passwordRef = useRef<TextInput>(null);

  function handleGoBack() {
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.navigate('Welcome');
    }
  }

  async function handleLogin() {
    if (email.trim() === '' || password === '') {
      Alert.alert('Atenção', 'Preencha todos os campos!');
      return;
    }

    setLoading(true);
    try {
      // O perfil decide o destino: ao salvar a sessão, as rotas trocam sozinhas
      // (equipe → painel; cliente → volta para a loja/carrinho de onde veio).
      await signIn(email, password);
    } catch (error) {
      setLoading(false);
      const status = getErrorStatus(error);
      const message = status === 401
        ? 'E-mail ou senha incorretos. Verifique seus dados e tente novamente.'
        : getErrorMessage(error, 'Não foi possível entrar agora. Tente novamente.');
      Alert.alert('Erro no Login', message);
    }
  }

  return (
    <KeyboardAwareScreen className="flex-1 bg-gray-50 dark:bg-slate-900">
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          paddingHorizontal: 24,
          // Espaço para o botão voltar (fixo no topo) e para as barras do sistema
          paddingTop: insets.top + 64,
          paddingBottom: insets.bottom + 48,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >

        <View className="mb-10">
          <Text className="text-4xl font-bold text-slate-900 dark:text-white mb-2">
            {loginType === 'cliente' ? 'Bem-vindo(a)!' : 'Acesso Restrito'}
          </Text>
          <Text className="text-slate-500 dark:text-slate-400 text-base">
            {loginType === 'cliente'
              ? 'Faça login para fazer seu pedido.'
              : 'Faça login com sua conta da equipe.'}
          </Text>
        </View>

        {notice && (
          <View
            className="flex-row items-center bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-xl p-3 mb-6"
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
          >
            <Feather name={notice === 'roleChanged' ? 'user-check' : 'clock'} size={18} color="#ea580c" />
            <Text className="text-orange-700 dark:text-orange-300 ml-2 flex-1">
              {notice === 'roleChanged' ? ROLE_CHANGED_MESSAGE : 'Sua sessão expirou. Entre novamente para continuar.'}
            </Text>
          </View>
        )}

        <View>
          <View className="bg-white dark:bg-slate-800 rounded-xl px-4 flex-row items-center border border-gray-200 dark:border-slate-700 mb-4 shadow-sm dark:shadow-none">
            <Feather name="mail" size={20} color={activeTheme === 'dark' ? '#9ca3af' : '#64748b'} />
            <TextInput
              placeholder="Digite seu e-mail"
              placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
              className="flex-1 ml-3 py-4 text-slate-900 dark:text-white text-base"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
              returnKeyType="next"
              onSubmitEditing={() => passwordRef.current?.focus()}
            />
          </View>

          <View className="mb-8">
            <View className="bg-white dark:bg-slate-800 rounded-xl px-4 flex-row items-center border border-gray-200 dark:border-slate-700 shadow-sm dark:shadow-none">
              <Feather name="lock" size={20} color={activeTheme === 'dark' ? '#9ca3af' : '#64748b'} />
              <TextInput
                ref={passwordRef}
                placeholder="Sua senha"
                placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
                className="flex-1 ml-3 py-4 text-slate-900 dark:text-white text-base"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                autoComplete="password"
                textContentType="password"
                returnKeyType="go"
                onSubmitEditing={handleLogin}
              />
            </View>

            <TouchableOpacity
              className="mt-3 self-end"
              onPress={() => navigation.navigate('ForgotPassword')}
            >
              <Text className="text-orange-600 dark:text-orange-500 font-bold">Esqueceu sua senha?</Text>
            </TouchableOpacity>
          </View>
        </View>

        <TouchableOpacity
          className="w-full bg-orange-600 rounded-xl py-4 flex-row justify-center items-center active:scale-95 shadow-md shadow-orange-600/30 mb-6"
          onPress={handleLogin}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text className="text-white font-bold text-lg">Entrar</Text>
          )}
        </TouchableOpacity>

        {loginType === 'cliente' && (
          <View className="flex-row justify-center items-center mt-4">
            <Text className="text-slate-500 dark:text-slate-400 text-base">Ainda não tem conta? </Text>
            <TouchableOpacity onPress={() => navigation.navigate('SignUp')}>
              <Text className="text-orange-600 dark:text-orange-500 font-bold text-base">Cadastre-se</Text>
            </TouchableOpacity>
          </View>
        )}

      </ScrollView>

      {/* Depois do ScrollView para ficar por cima do conteúdo */}
      <TouchableOpacity
        className="absolute left-6 w-10 h-10 bg-white dark:bg-slate-800 rounded-full justify-center items-center z-10 shadow-sm dark:shadow-none border border-gray-200 dark:border-transparent"
        style={{ top: insets.top + 12 }}
        onPress={handleGoBack}
        accessibilityRole="button"
        accessibilityLabel="Voltar"
      >
        <Feather name="arrow-left" size={24} color="#f97316" />
      </TouchableOpacity>
    </KeyboardAwareScreen>
  );
}
