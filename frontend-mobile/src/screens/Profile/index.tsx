import React, { useState, useContext, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Image, ActivityIndicator, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Feather from '@expo/vector-icons/Feather';

import { AppStackParamList } from '../../routes/app.routes';
import { AuthContext } from '../../contexts/AuthContext';
import { ThemeContext } from '../../contexts/ThemeContext';
import api from '../../services/api';

export default function Profile() {
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  
  // Pegamos o user como 'any' localmente para o TypeScript aceitar avatar e phone
  const { user, signOut } = useContext(AuthContext) as any;
  const { activeTheme } = useContext(ThemeContext);

  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [phone, setPhone] = useState(user?.phone || '');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // --- FUNÇÃO INTELIGENTE DE IMAGEM ---
  const getImageUrl = (imagePath: string | null | undefined) => {
    if (!imagePath) return 'https://ui-avatars.com/api/?name=' + (user?.name || 'User') + '&background=f97316&color=fff';
    let cleanPath = imagePath.replace(/^\//, ''); 
    if (!cleanPath.startsWith('uploads/')) {
      cleanPath = `uploads/${cleanPath}`;
    }
    const base = api.defaults.baseURL?.replace(/\/$/, '') || '';
    return `${base}/${cleanPath}`;
  };

  async function handleUpdateProfile() {
    if (!name || !email) {
      Alert.alert('Atenção', 'Nome e E-mail são obrigatórios.');
      return;
    }

    setIsSubmitting(true);
    try {
      await api.patch(`/users/${user?.id}`, {
        name,
        email,
        phone: phone || undefined,
      });

      Alert.alert('Sucesso!', 'Seus dados foram atualizados.');
      setIsEditing(false);
    } catch (error) {
      console.error('Erro ao atualizar perfil:', error);
      Alert.alert('Ops', 'Ocorreu um erro ao atualizar os dados.');
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleSignOut() {
    Alert.alert('Sair da conta', 'Tem certeza que deseja desconectar?', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Sair', style: 'destructive', onPress: () => {
          signOut();
          navigation.reset({ index: 0, routes: [{ name: 'Home' }] });
        } 
      }
    ]);
  }

  return (
    <KeyboardAvoidingView 
      className="flex-1 bg-gray-50 dark:bg-slate-900"
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View className="pt-16 px-6 pb-4 bg-white dark:bg-slate-800 shadow-sm z-10 flex-row items-center justify-between">
        <View className="flex-row items-center">
          <TouchableOpacity 
            onPress={() => navigation.goBack()}
            className="w-10 h-10 bg-gray-100 dark:bg-slate-900 rounded-full justify-center items-center"
          >
            <Feather name="arrow-left" size={24} color="#f97316" />
          </TouchableOpacity>
          <Text className="text-2xl font-bold text-slate-900 dark:text-white ml-4">Minha Conta</Text>
        </View>

        <TouchableOpacity onPress={() => setIsEditing(!isEditing)}>
          <Text className="text-orange-500 font-bold text-base">
            {isEditing ? 'Cancelar' : 'Editar'}
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 24, paddingBottom: 100 }}>
        
        <View className="items-center mb-8 mt-4">
          <View className="relative">
            <Image 
              source={{ uri: getImageUrl(user?.avatar) }}
              className="w-28 h-28 rounded-full border-4 border-white dark:border-slate-800 shadow-md bg-gray-200 dark:bg-slate-700"
            />
            {isEditing && (
              <TouchableOpacity className="absolute bottom-0 right-0 w-10 h-10 bg-orange-600 rounded-full items-center justify-center border-2 border-white dark:border-slate-800">
                <Feather name="camera" size={16} color="#fff" />
              </TouchableOpacity>
            )}
          </View>
          <Text className="text-xl font-bold text-slate-900 dark:text-white mt-4">{user?.name}</Text>
          <Text className="text-slate-500 dark:text-slate-400">{user?.email}</Text>
        </View>

        <View className="space-y-4 mb-8">
          <View>
            <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">Nome Completo</Text>
            <TextInput 
              className={`border rounded-xl px-4 py-3 text-base ${isEditing ? 'bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700 text-slate-900 dark:text-white shadow-sm dark:shadow-none' : 'bg-gray-100 dark:bg-slate-900/50 border-transparent text-slate-500 dark:text-slate-400'}`}
              value={name}
              onChangeText={setName}
              editable={isEditing}
              maxLength={50}
            />
          </View>

          <View>
            <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">E-mail</Text>
            <TextInput 
              className={`border rounded-xl px-4 py-3 text-base ${isEditing ? 'bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700 text-slate-900 dark:text-white shadow-sm dark:shadow-none' : 'bg-gray-100 dark:bg-slate-900/50 border-transparent text-slate-500 dark:text-slate-400'}`}
              value={email}
              onChangeText={setEmail}
              editable={isEditing}
              keyboardType="email-address"
              autoCapitalize="none"
            />
          </View>

          <View>
            <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">Telefone</Text>
            <TextInput 
              className={`border rounded-xl px-4 py-3 text-base ${isEditing ? 'bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700 text-slate-900 dark:text-white shadow-sm dark:shadow-none' : 'bg-gray-100 dark:bg-slate-900/50 border-transparent text-slate-500 dark:text-slate-400'}`}
              value={phone}
              onChangeText={setPhone}
              editable={isEditing}
              keyboardType="phone-pad"
              placeholder="Ex: 21999999999"
              placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
            />
          </View>
        </View>

        {isEditing ? (
          <TouchableOpacity 
            className="w-full bg-green-600 rounded-xl py-4 flex-row justify-center items-center active:scale-95 mb-6"
            onPress={handleUpdateProfile}
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text className="text-white font-bold text-lg">Salvar Alterações</Text>
            )}
          </TouchableOpacity>
        ) : (
          <View>
            <TouchableOpacity 
              className="w-full bg-orange-50 border border-orange-200 dark:bg-orange-600/10 dark:border-orange-600/30 rounded-xl py-4 px-4 flex-row justify-between items-center active:scale-95 mb-4"
              onPress={() => Alert.alert('Em breve!', 'Tela de pedidos em construção...')} 
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
    </KeyboardAvoidingView>
  );
}