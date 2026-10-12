import React, { useState, useContext, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';

import { AppStackParamList } from '../../routes/app.routes';
import { AuthContext } from '../../contexts/AuthContext';
import { ThemeContext } from '../../contexts/ThemeContext';
import RemoteImage from '../../components/RemoteImage';
import KeyboardAwareScreen, { useKeyboardVisible } from '../../components/KeyboardAwareScreen';
import { userService } from '../../services/userService';
import { getErrorMessage } from '../../utils/errors';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Profile() {
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();

  const { user, signOut, updateUser } = useContext(AuthContext);
  const { activeTheme } = useContext(ThemeContext);
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();

  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Mantém o formulário em sincronia com o usuário logado (ex.: dados atualizados pelo servidor)
  useEffect(() => {
    if (!isEditing) resetForm();
  }, [user, isEditing]);

  function resetForm() {
    setName(user?.name ?? '');
    setEmail(user?.email ?? '');
    setPhone(user?.phone ?? '');
  }

  function handleToggleEdit() {
    if (isEditing) resetForm(); // "Cancelar" descarta as alterações
    setIsEditing(!isEditing);
  }

  async function handleUpdateProfile() {
    if (!user) return;
    if (!name.trim() || !email.trim()) {
      Alert.alert('Atenção', 'Nome e E-mail são obrigatórios.');
      return;
    }
    if (!EMAIL_REGEX.test(email.trim())) {
      Alert.alert('E-mail inválido', 'Confira o e-mail digitado.');
      return;
    }
    const digits = phone.replace(/\D/g, '');
    if (digits && digits.length < 10) {
      Alert.alert('Telefone inválido', 'Informe o celular com DDD (ex.: 21999999999) ou deixe em branco para remover.');
      return;
    }

    const currentPhone = (user.phone ?? '').replace(/\D/g, '');
    const phoneChanged = digits !== currentPhone;
    if (
      !phoneChanged
      && name.trim() === (user.name ?? '').trim()
      && email.trim().toLowerCase() === (user.email ?? '').trim().toLowerCase()
    ) {
      setIsEditing(false);
      Alert.alert('Nada para salvar', 'Você não alterou nenhum dado.');
      return;
    }

    setIsSubmitting(true);
    try {
      const updated = await userService.update(user.id, {
        name,
        email,
        // Só envia o telefone se mudou; vazio ('') apaga o número cadastrado
        ...(phoneChanged ? { phone: digits } : {}),
      });

      // Atualiza o usuário logado (saudação da Home, cabeçalho e dados salvos no aparelho).
      // O backend devolve phone null quando o número foi apagado.
      await updateUser({
        name: updated?.name ?? name.trim(),
        email: updated?.email ?? email.trim(),
        phone: updated && 'phone' in updated ? updated.phone ?? null : (digits || null),
        avatar: updated?.avatar ?? user.avatar,
      });

      Alert.alert('Sucesso!', 'Seus dados foram atualizados.');
      setIsEditing(false);
    } catch (error) {
      Alert.alert('Ops', getErrorMessage(error, 'Ocorreu um erro ao atualizar os dados.'));
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleSignOut() {
    Alert.alert('Sair da conta', 'Tem certeza que deseja desconectar?', [
      { text: 'Cancelar', style: 'cancel' },
      // Ao encerrar a sessão as telas da conta saem da pilha e o app volta para a loja
      { text: 'Sair', style: 'destructive', onPress: () => { signOut(); } }
    ]);
  }

  const inputClass = (editable: boolean) => `border rounded-xl px-4 py-3 text-base ${editable
    ? 'bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700 text-slate-900 dark:text-white shadow-sm dark:shadow-none'
    : 'bg-gray-100 dark:bg-slate-900/50 border-transparent text-slate-500 dark:text-slate-400'}`;

  return (
    <KeyboardAwareScreen className="flex-1 bg-gray-50 dark:bg-slate-900">
      <View className="px-6 pb-4 bg-white dark:bg-slate-800 shadow-sm z-10 flex-row items-center justify-between" style={{ paddingTop: insets.top + 16 }}>
        <View className="flex-row items-center">
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            className="w-10 h-10 bg-gray-100 dark:bg-slate-900 rounded-full justify-center items-center"
            accessibilityRole="button"
            accessibilityLabel="Voltar"
          >
            <Feather name="arrow-left" size={24} color="#f97316" />
          </TouchableOpacity>
          <Text className="text-2xl font-bold text-slate-900 dark:text-white ml-4">Minha Conta</Text>
        </View>

        <TouchableOpacity onPress={handleToggleEdit} accessibilityRole="button">
          <Text className="text-orange-500 font-bold text-base">
            {isEditing ? 'Cancelar' : 'Editar'}
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 24, paddingBottom: isEditing ? 24 : Math.max(insets.bottom, 16) + 24 }}
      >

        <View className="items-center mb-8 mt-4">
          <View className="w-28 h-28 rounded-full border-4 border-white dark:border-slate-800 shadow-md bg-orange-600 overflow-hidden items-center justify-center">
            {user?.avatar ? (
              <RemoteImage path={user.avatar} className="w-full h-full" fallbackIcon="user" iconSize={40} />
            ) : (
              <Text className="text-white text-4xl font-bold">{(user?.name ?? '?').charAt(0).toUpperCase()}</Text>
            )}
          </View>
          <Text className="text-xl font-bold text-slate-900 dark:text-white mt-4">{user?.name}</Text>
          <Text className="text-slate-500 dark:text-slate-400">{user?.email}</Text>
        </View>

        <View className="mb-8">
          <View className="mb-4">
            <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">Nome Completo</Text>
            <TextInput
              className={inputClass(isEditing)}
              value={name}
              onChangeText={setName}
              editable={isEditing}
              maxLength={50}
            />
          </View>

          <View className="mb-4">
            <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">E-mail</Text>
            <TextInput
              className={inputClass(isEditing)}
              value={email}
              onChangeText={setEmail}
              editable={isEditing}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <View>
            <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">Telefone</Text>
            {/* Fora da edição, telefone vazio aparece como "Não informado" (o exemplo só serve para digitar) */}
            <TextInput
              className={inputClass(isEditing)}
              value={isEditing ? phone : (phone || 'Não informado')}
              onChangeText={setPhone}
              editable={isEditing}
              keyboardType="phone-pad"
              maxLength={15}
              placeholder={isEditing ? 'Ex: 21999999999' : undefined}
              placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
            />
          </View>
        </View>

        {!isEditing && (
          <View>
            <TouchableOpacity
              className="w-full bg-orange-50 border border-orange-200 dark:bg-orange-600/10 dark:border-orange-600/30 rounded-xl py-4 px-4 flex-row justify-between items-center active:scale-95 mb-4"
              onPress={() => navigation.navigate('MyOrders')}
            >
              <View className="flex-row items-center">
                <Feather name="shopping-bag" size={20} color="#f97316" />
                <Text className="text-orange-600 dark:text-orange-500 font-bold text-lg ml-3">Meus Pedidos</Text>
              </View>
              <Feather name="chevron-right" size={20} color="#f97316" />
            </TouchableOpacity>

            <TouchableOpacity
              className="w-full bg-red-50 border border-red-200 dark:bg-red-900/10 dark:border-red-900/30 rounded-xl py-4 px-4 flex-row items-center active:scale-95"
              onPress={handleSignOut}
            >
              <Feather name="log-out" size={20} color="#ef4444" />
              <Text className="text-red-500 font-bold text-lg ml-3">Sair da Conta</Text>
            </TouchableOpacity>
          </View>
        )}

      </ScrollView>

      {/* Editando: o botão de salvar fica num rodapé no fluxo, visível acima do teclado */}
      {isEditing && (
        <View
          className="bg-white dark:bg-slate-800 border-t border-gray-200 dark:border-slate-700 px-6 pt-4"
          style={{ paddingBottom: keyboardVisible ? 12 : Math.max(insets.bottom, 8) + 16 }}
        >
          <TouchableOpacity
            className="w-full bg-green-600 rounded-xl py-4 flex-row justify-center items-center active:scale-95"
            onPress={handleUpdateProfile}
            disabled={isSubmitting}
            accessibilityRole="button"
          >
            {isSubmitting ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text className="text-white font-bold text-lg">Salvar Alterações</Text>
            )}
          </TouchableOpacity>
        </View>
      )}
    </KeyboardAwareScreen>
  );
}
