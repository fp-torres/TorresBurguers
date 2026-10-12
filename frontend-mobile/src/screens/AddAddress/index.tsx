import React, { useState, useContext, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';

import { AppStackParamList } from '../../routes/app.routes';
import { ThemeContext } from '../../contexts/ThemeContext';
import KeyboardAwareScreen, { useKeyboardVisible } from '../../components/KeyboardAwareScreen';
import api from '../../services/api';
import { getErrorMessage, getErrorStatus } from '../../utils/errors';

/** Resposta de GET /addresses/cep/:cep (formato ViaCEP; aceita também nomes em inglês). */
interface CepResponse {
  logradouro?: string;
  bairro?: string;
  localidade?: string;
  uf?: string;
  street?: string;
  neighborhood?: string;
  city?: string;
  state?: string;
}

/** Campos preenchidos pela busca do CEP (o que o cliente digitou não entra aqui). */
interface CepFields {
  street: string;
  neighborhood: string;
  city: string;
  state: string;
}

export default function AddAddress() {
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  const { activeTheme } = useContext(ThemeContext);
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();

  const [zipCode, setZipCode] = useState('');
  const [street, setStreet] = useState('');
  const [number, setNumber] = useState('');
  const [complement, setComplement] = useState('');
  const [neighborhood, setNeighborhood] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [nickname, setNickname] = useState('');

  const [loadingCep, setLoadingCep] = useState(false);
  const [cepHint, setCepHint] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const lastCepSearched = useRef('');
  // Só a resposta da busca mais recente vale (o cliente pode trocar o CEP antes de ela voltar)
  const cepRequest = useRef(0);
  // Valores que a última busca preencheu: saem quando o CEP muda ou não é encontrado
  const autoFilled = useRef<CepFields | null>(null);

  /** Apaga o que a busca anterior preencheu, mantendo o que o cliente digitou ou corrigiu. */
  function clearAutoFilled() {
    const filled = autoFilled.current;
    if (!filled) return;
    autoFilled.current = null;
    setStreet((current) => (current === filled.street ? '' : current));
    setNeighborhood((current) => (current === filled.neighborhood ? '' : current));
    setCity((current) => (current === filled.city ? '' : current));
    setState((current) => (current === filled.state ? '' : current));
  }

  // Busca o CEP pelo backend (que consulta ViaCEP/BrasilAPI) e preenche o que encontrar
  async function handleSearchCep(cleanCep: string) {
    if (cleanCep === lastCepSearched.current) return;
    lastCepSearched.current = cleanCep;
    const requestId = ++cepRequest.current;
    setLoadingCep(true);
    setCepHint(null);
    try {
      const { data } = await api.get<CepResponse | null>(`/addresses/cep/${cleanCep}`);
      if (requestId !== cepRequest.current) return;
      if (!data) throw new Error('CEP vazio');
      const found: CepFields = {
        street: (data.logradouro || data.street || '').trim(),
        neighborhood: (data.bairro || data.neighborhood || '').trim(),
        city: (data.localidade || data.city || '').trim(),
        state: (data.uf || data.state || '').trim().toUpperCase(),
      };
      // Troca os dados do CEP anterior pelos do novo; campo que o CEP não informa (ex.: CEP geral
      // da cidade, sem rua) fica com o que o cliente digitou
      clearAutoFilled();
      if (found.street) setStreet(found.street);
      if (found.neighborhood) setNeighborhood(found.neighborhood);
      if (found.city) setCity(found.city);
      if (found.state) setState(found.state);
      autoFilled.current = found;
    } catch (error) {
      if (requestId !== cepRequest.current) return;
      clearAutoFilled();
      const status = getErrorStatus(error);
      setCepHint(status === 404 || status === 400
        ? 'CEP não encontrado. Preencha o endereço manualmente.'
        : 'Não foi possível consultar o CEP agora. Preencha o endereço manualmente.');
    } finally {
      if (requestId === cepRequest.current) setLoadingCep(false);
    }
  }

  // Máscara simples de CEP visual (ex: 12345-678)
  const formatCep = (text: string) => {
    const digits = text.replace(/\D/g, '').slice(0, 8);
    setZipCode(digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits);
    if (digits.length === 8) {
      handleSearchCep(digits);
      return;
    }
    // CEP alterado: os dados preenchidos para o CEP anterior não valem mais
    if (lastCepSearched.current) {
      lastCepSearched.current = '';
      cepRequest.current += 1; // descarta a busca em andamento
      setLoadingCep(false);
      setCepHint(null);
      clearAutoFilled();
    }
  };

  async function handleSaveAddress() {
    const cleanZip = zipCode.replace(/\D/g, '');
    if (!cleanZip || !street.trim() || !number.trim() || !neighborhood.trim() || !city.trim() || !state.trim()) {
      Alert.alert('Atenção', 'Preencha todos os campos obrigatórios (marcados com *).');
      return;
    }
    if (cleanZip.length !== 8) {
      Alert.alert('CEP inválido', 'O CEP deve ter 8 números.');
      return;
    }
    if (!/^[A-Za-z]{2}$/.test(state.trim())) {
      Alert.alert('UF inválida', 'Informe a sigla do estado com 2 letras (ex.: RJ).');
      return;
    }

    setIsSubmitting(true);
    try {
      // Payload idêntico ao CreateAddressDto do backend
      const { data: created } = await api.post<{ id?: number } | null>('/addresses', {
        nickname: nickname.trim() || undefined,
        zipCode: cleanZip,
        street: street.trim(),
        number: number.trim(),
        complement: complement.trim() || undefined,
        neighborhood: neighborhood.trim(),
        city: city.trim(),
        state: state.trim().toUpperCase(),
      });

      Alert.alert('Sucesso!', 'Endereço salvo com sucesso.');

      // Volta para o Checkout já indicando o endereço novo (params.selectedAddressId)
      const checkoutInStack = navigation.getState()?.routes.some((route) => route.name === 'Checkout');
      if (checkoutInStack && created?.id) {
        navigation.popTo('Checkout', { selectedAddressId: created.id }, { merge: true });
      } else {
        navigation.goBack();
      }
    } catch (error) {
      Alert.alert('Erro', getErrorMessage(error, 'Não foi possível salvar o endereço.'));
    } finally {
      setIsSubmitting(false);
    }
  }

  const inputClass = 'bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl px-4 py-3 text-slate-900 dark:text-white text-base shadow-sm dark:shadow-none';
  const placeholderColor = activeTheme === 'dark' ? '#64748b' : '#9ca3af';

  return (
    <KeyboardAwareScreen className="flex-1 bg-gray-50 dark:bg-slate-900">
      <View className="px-6 pb-4 bg-white dark:bg-slate-800 shadow-sm z-10 flex-row items-center" style={{ paddingTop: insets.top + 16 }}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Voltar"
          className="w-10 h-10 bg-gray-100 dark:bg-slate-900 rounded-full justify-center items-center"
        >
          <Feather name="arrow-left" size={24} color="#f97316" />
        </TouchableOpacity>
        <Text className="text-2xl font-bold text-slate-900 dark:text-white ml-4">Novo Endereço</Text>
      </View>

      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 24 }}
      >

        <View>
          <View className="mb-4">
            <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">CEP *</Text>
            <View className="flex-row items-center bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl px-4 shadow-sm dark:shadow-none">
              <TextInput
                placeholder="00000-000"
                placeholderTextColor={placeholderColor}
                className="flex-1 py-3 text-slate-900 dark:text-white text-base"
                value={zipCode}
                onChangeText={formatCep}
                keyboardType="numeric"
                maxLength={9}
              />
              {loadingCep && <ActivityIndicator size="small" color="#f97316" />}
            </View>
            {cepHint && <Text className="text-xs text-orange-600 dark:text-orange-400 mt-1 ml-1">{cepHint}</Text>}
          </View>

          <View className="flex-row justify-between mb-4">
            <View className="w-[70%]">
              <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">Rua *</Text>
              <TextInput
                className={inputClass}
                value={street}
                onChangeText={setStreet}
                placeholder="Ex: Av. Atlântica"
                placeholderTextColor={placeholderColor}
              />
            </View>
            <View className="w-[26%]">
              <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">Nº *</Text>
              <TextInput
                className={inputClass}
                value={number}
                onChangeText={setNumber}
                placeholder="123"
                placeholderTextColor={placeholderColor}
              />
            </View>
          </View>

          <View className="mb-4">
            <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">Complemento</Text>
            <TextInput
              className={inputClass}
              value={complement}
              onChangeText={setComplement}
              placeholder="Ex: Apto 202, Bloco B"
              placeholderTextColor={placeholderColor}
            />
          </View>

          <View className="mb-4">
            <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">Bairro *</Text>
            <TextInput
              className={inputClass}
              value={neighborhood}
              onChangeText={setNeighborhood}
              placeholderTextColor={placeholderColor}
            />
          </View>

          <View className="flex-row justify-between mb-4">
            <View className="w-[65%]">
              <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">Cidade *</Text>
              <TextInput
                className={inputClass}
                value={city}
                onChangeText={setCity}
                placeholderTextColor={placeholderColor}
              />
            </View>
            <View className="w-[30%]">
              <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">UF *</Text>
              <TextInput
                className={`${inputClass} text-center`}
                value={state}
                onChangeText={(text) => setState(text.replace(/[^A-Za-z]/g, '').toUpperCase())}
                maxLength={2}
                autoCapitalize="characters"
                placeholder="RJ"
                placeholderTextColor={placeholderColor}
              />
            </View>
          </View>

          <View>
            <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">Apelido do Endereço (Opcional)</Text>
            <TextInput
              className={inputClass}
              value={nickname}
              onChangeText={setNickname}
              placeholder="Ex: Casa, Trabalho"
              placeholderTextColor={placeholderColor}
            />
          </View>
        </View>

      </ScrollView>

      {/* Rodapé no fluxo: sobe junto com o teclado */}
      <View
        className={`bg-white dark:bg-slate-800 border-t border-gray-200 dark:border-slate-700 px-6 shadow-lg ${keyboardVisible ? 'pt-3' : 'pt-6'}`}
        style={{ paddingBottom: keyboardVisible ? 12 : Math.max(insets.bottom, 16) + 16 }}
      >
        <TouchableOpacity
          className="w-full bg-orange-600 rounded-xl py-4 flex-row justify-center items-center active:scale-95"
          onPress={handleSaveAddress}
          disabled={isSubmitting || loadingCep}
        >
          {isSubmitting ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <Text className="text-white font-bold text-lg mr-2">Salvar Endereço</Text>
              <Feather name="save" size={20} color="#fff" />
            </>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAwareScreen>
  );
}
