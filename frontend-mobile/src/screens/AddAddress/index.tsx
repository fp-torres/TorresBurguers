import React, { useState, useContext } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Feather from '@expo/vector-icons/Feather';
import axios from 'axios';

import { AppStackParamList } from '../../routes/app.routes';
import { ThemeContext } from '../../contexts/ThemeContext';
import api from '../../services/api';

export default function AddAddress() {
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  const { activeTheme } = useContext(ThemeContext);

  const [zipCode, setZipCode] = useState('');
  const [street, setStreet] = useState('');
  const [number, setNumber] = useState('');
  const [complement, setComplement] = useState('');
  const [neighborhood, setNeighborhood] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [nickname, setNickname] = useState('');

  const [loadingCep, setLoadingCep] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Função para buscar o CEP automaticamente
  async function handleSearchCep(cep: string) {
    const cleanCep = cep.replace(/\D/g, '');
    setZipCode(cep); // Mantém o valor digitado no input

    if (cleanCep.length === 8) {
      setLoadingCep(true);
      try {
        const response = await axios.get(`https://viacep.com.br/ws/${cleanCep}/json/`);
        
        if (response.data.erro) {
          Alert.alert('Ops!', 'CEP não encontrado.');
          return;
        }

        setStreet(response.data.logradouro);
        setNeighborhood(response.data.bairro);
        setCity(response.data.localidade);
        setState(response.data.uf);
      } catch (error) {
        Alert.alert('Erro', 'Falha ao buscar o CEP.');
      } finally {
        setLoadingCep(false);
      }
    }
  }

  // Máscara simples de CEP visual (ex: 12345-678)
  const formatCep = (text: string) => {
    let value = text.replace(/\D/g, '');
    if (value.length > 5) {
      value = value.replace(/^(\d{5})(\d)/, '$1-$2');
    }
    handleSearchCep(value);
  };

  async function handleSaveAddress() {
    if (!zipCode || !street || !number || !neighborhood || !city || !state) {
      Alert.alert('Atenção', 'Preencha todos os campos obrigatórios (marcados com *).');
      return;
    }

    setIsSubmitting(true);
    try {
      // O Payload idêntico ao CreateAddressDto do backend
      await api.post('/addresses', {
        nickname: nickname || undefined,
        zipCode: zipCode.replace(/\D/g, ''), // Envia só os números (ou com traço, seu regex aceita ambos)
        street,
        number,
        complement: complement || undefined,
        neighborhood,
        city,
        state,
      });

      Alert.alert('Sucesso!', 'Endereço salvo com sucesso.');
      navigation.goBack(); // Volta para o Checkout!
    } catch (error) {
      console.error(error);
      Alert.alert('Erro', 'Não foi possível salvar o endereço.');
    } finally {
      setIsSubmitting(false);
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
        <Text className="text-2xl font-bold text-slate-900 dark:text-white ml-4">Novo Endereço</Text>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 24, paddingBottom: 100 }}>
        
        <View className="space-y-4">
          <View>
            <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">CEP *</Text>
            <View className="flex-row items-center bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl px-4 py-3 shadow-sm dark:shadow-none">
              <TextInput 
                placeholder="00000-000"
                placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
                className="flex-1 text-slate-900 dark:text-white text-base"
                value={zipCode}
                onChangeText={formatCep}
                keyboardType="numeric"
                maxLength={9}
              />
              {loadingCep && <ActivityIndicator size="small" color="#f97316" />}
            </View>
          </View>

          <View className="flex-row justify-between">
            <View className="w-[70%]">
              <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">Rua *</Text>
              <TextInput 
                className="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl px-4 py-3 text-slate-900 dark:text-white text-base shadow-sm dark:shadow-none"
                value={street}
                onChangeText={setStreet}
                placeholder="Ex: Av. Atlântica"
                placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
              />
            </View>
            <View className="w-[26%]">
              <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">Nº *</Text>
              <TextInput 
                className="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl px-4 py-3 text-slate-900 dark:text-white text-base shadow-sm dark:shadow-none"
                value={number}
                onChangeText={setNumber}
                keyboardType="numeric"
                placeholder="123"
                placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
              />
            </View>
          </View>

          <View>
            <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">Complemento</Text>
            <TextInput 
              className="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl px-4 py-3 text-slate-900 dark:text-white text-base shadow-sm dark:shadow-none"
              value={complement}
              onChangeText={setComplement}
              placeholder="Ex: Apto 202, Bloco B"
              placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
            />
          </View>

          <View>
            <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">Bairro *</Text>
            <TextInput 
              className="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl px-4 py-3 text-slate-900 dark:text-white text-base shadow-sm dark:shadow-none"
              value={neighborhood}
              onChangeText={setNeighborhood}
              placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
            />
          </View>

          <View className="flex-row justify-between">
            <View className="w-[65%]">
              <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">Cidade *</Text>
              <TextInput 
                className="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl px-4 py-3 text-slate-900 dark:text-white text-base shadow-sm dark:shadow-none"
                value={city}
                onChangeText={setCity}
                placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
              />
            </View>
            <View className="w-[30%]">
              <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">UF *</Text>
              <TextInput 
                className="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl px-4 py-3 text-slate-900 dark:text-white text-base shadow-sm dark:shadow-none text-center"
                value={state}
                onChangeText={(text) => setState(text.toUpperCase())}
                maxLength={2}
                placeholder="RJ"
                placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
              />
            </View>
          </View>

          <View>
            <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">Apelido do Endereço (Opcional)</Text>
            <TextInput 
              className="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl px-4 py-3 text-slate-900 dark:text-white text-base shadow-sm dark:shadow-none"
              value={nickname}
              onChangeText={setNickname}
              placeholder="Ex: Casa, Trabalho, Namorada"
              placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
            />
          </View>
        </View>

      </ScrollView>

      <View className="absolute bottom-0 w-full bg-white dark:bg-slate-800 border-t border-gray-200 dark:border-slate-700 p-6 pb-8 shadow-lg">
        <TouchableOpacity 
          className="w-full bg-orange-600 rounded-xl py-4 flex-row justify-center items-center active:scale-95"
          onPress={handleSaveAddress}
          disabled={isSubmitting || loadingCep}
        >
          {isSubmitting ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <Text className="text-white font-bold text-lg">Salvar Endereço</Text>
              <Feather name="save" size={20} color="#fff" className="ml-2" />
            </>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}