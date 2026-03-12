import React, { useState, useContext } from 'react';
import { View, Text, TouchableOpacity, ScrollView, TextInput, ActivityIndicator, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Feather from '@expo/vector-icons/Feather';
import axios from 'axios'; // Importação padrão do axios para chamadas externas

import { AppStackParamList } from '../../routes/app.routes';
import { ThemeContext } from '../../contexts/ThemeContext';
import { CartContext } from '../../contexts/CartContext';
import api from '../../services/api';

type PaymentCardRouteProp = {
  key: string;
  name: "PaymentCard";
  params: { payload_order: any; total: number; email: string };
};

export default function PaymentCard() {
  const route = useRoute<PaymentCardRouteProp>();
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  
  const { activeTheme } = useContext(ThemeContext);
  const { clearCart } = useContext(CartContext);
  const { payload_order, total, email } = route.params;

  // CHAVE PÚBLICA EXATAMENTE IGUAL AO SEU WEB
  const MP_PUBLIC_KEY = 'TEST-6aeab6dc-85c6-4d63-b0e6-8f605114628d';

  const [cardNumber, setCardNumber] = useState('');
  const [cardName, setCardName] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [cvv, setCvv] = useState('');
  const [cpf, setCpf] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // --- MÁSCARAS ---
  const formatCardNumber = (text: string) => {
    return text.replace(/\D/g, '').replace(/(\d{4})/g, '$1 ').trim().substring(0, 19);
  };

  const formatExpiry = (text: string) => {
    return text.replace(/\D/g, '').replace(/(\d{2})(\d{1,2})/, '$1/$2').substring(0, 5);
  };

  const formatCpf = (text: string) => {
    return text.replace(/\D/g, '')
               .replace(/(\d{3})(\d)/, '$1.$2')
               .replace(/(\d{3})(\d)/, '$1.$2')
               .replace(/(\d{3})(\d{1,2})$/, '$1-$2')
               .substring(0, 14);
  };

  const formatPrice = (price: number) => {
    return Number(price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };

  // --- DETECTAR BANDEIRA (Igual no Web) ---
  const detectCardBrand = (number: string) => {
    const clean = number.replace(/\D/g, '');
    if (clean.startsWith('5031')) return 'master';
    if (clean.match(/^4/)) return 'visa';
    if (clean.match(/^5[1-5]/) || clean.match(/^2(22[1-9]|2[3-9][0-9]|[3-6][0-9]{2}|7[01][0-9]|720)/)) return 'master';
    if (clean.match(/^3[47]/)) return 'amex';
    if (clean.match(/^(4011(78|79)|431274|438935|451416|457393|457631|457632|504175|627780|636297|636368|65003[1-3]|6500(3[5-9]|4[0-9]|5[0-1])|65040[5-9]|6504[1-3][0-9]|65048[5-9]|65049[0-9]|6505[0-2][0-9]|65053[0-8]|65054[1-9]|6505[5-8][0-9]|65059[0-8]|65070[0-9]|65071[0-8]|65072[0-7]|65090[1-9]|65091[0-9]|650920|65165[2-9]|6516[6-7][0-9]|65500[0-9]|65501[0-9]|65502[1-9]|6550[3-4][0-9]|65505[0-8])/)) return 'elo';
    if (clean.match(/^606282|^3841(?:[0|4|6]{1})0/)) return 'hipercard';
    return 'credit_card';
  };

  // --- PROCESSAMENTO REAL DE PAGAMENTO ---
  async function handlePayment() {
    if (cardNumber.length < 19 || !cardName || expiryDate.length < 5 || cvv.length < 3 || cpf.length < 14) {
      Alert.alert('Atenção', 'Por favor, preencha todos os dados do cartão corretamente.');
      return;
    }

    setIsSubmitting(true);

    try {
      const cleanNumber = cardNumber.replace(/\D/g, '');
      const detectedMethod = detectCardBrand(cardNumber);
      const cleanCpf = cpf.replace(/\D/g, '');
      
      const expMonth = parseInt(expiryDate.split('/')[0], 10);
      const expYear = parseInt('20' + expiryDate.split('/')[1], 10);

      // 1. GERAÇÃO DIRETA DO TOKEN NA API DO MERCADO PAGO
      const mpPayload = {
        card_number: cleanNumber,
        cardholder: {
          name: cardName,
          identification: {
            type: 'CPF',
            number: cleanCpf
          }
        },
        security_code: cvv,
        expiration_month: expMonth,
        expiration_year: expYear
      };

      const mpResponse = await axios.post(
        `https://api.mercadopago.com/v1/card_tokens?public_key=${MP_PUBLIC_KEY}`,
        mpPayload
      );

      const realTokenId = mpResponse.data.id;

      // 2. ENVIA O TOKEN REAL PARA O SEU BACKEND (Exatamente como o Web faz)
      const paymentData = {
        token: realTokenId,
        amount: total,
        email: email,
        paymentMethodId: detectedMethod,
        installments: 1,
        docType: 'CPF',
        docNumber: cleanCpf
      };

      const paymentResponse = await api.post('/payment/card', paymentData);

      // 3. FINALIZA O PEDIDO SE APROVADO
      if (paymentResponse.data.status === 'approved' || paymentResponse.data.status === 'in_process') {
        
        // CORREÇÃO: paymentId ao invés de payment_id
        const finalPayload = { ...payload_order, paymentId: paymentResponse.data.id };
        
        await api.post('/orders', finalPayload);
        clearCart();
        
        Alert.alert(
          'Pagamento Aprovado! 🎉', 
          'Seu pedido foi confirmado e já vai ser preparado.',
          [{ text: 'Ver Pedidos', onPress: () => navigation.reset({ index: 0, routes: [{ name: 'Home' }] }) }]
        );
      } else {
        Alert.alert('Pagamento Recusado', `Motivo: ${paymentResponse.data.status_detail || 'Não autorizado.'}`);
        setIsSubmitting(false);
      }

    } catch (error: any) {
      console.log('Erro no pagamento:', error.response?.data || error.message);
      Alert.alert('Ops!', 'Houve um erro ao processar seu cartão com o banco. Verifique os dados e tente novamente.');
      setIsSubmitting(false);
    }
  }

  const currentBrand = detectCardBrand(cardNumber);

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
        <Text className="text-2xl font-bold text-slate-900 dark:text-white ml-4">Cartão de Crédito</Text>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 24, paddingBottom: 120 }}>
        
        {/* CARTÃO VIRTUAL PREMIUM */}
        <View className="bg-orange-600 w-full h-52 rounded-2xl p-6 mb-8 justify-between shadow-lg shadow-orange-600/40 relative overflow-hidden">
          <View className="absolute -right-10 -top-10 w-40 h-40 bg-white/10 rounded-full" />
          <View className="absolute -left-10 -bottom-10 w-32 h-32 bg-black/10 rounded-full" />

          <View className="flex-row justify-between items-start">
            <View className="w-12 h-8 bg-yellow-400 rounded-md border border-yellow-500 justify-center items-center shadow-sm">
               <View className="w-full h-[1px] bg-yellow-500/50 absolute top-1/2" />
               <View className="w-[1px] h-full bg-yellow-500/50 absolute left-1/2" />
            </View>
            <Text className="text-white font-bold italic text-lg opacity-90 tracking-wider shadow-sm uppercase">
              {currentBrand === 'credit_card' ? 'TORRES' : currentBrand}
            </Text>
          </View>
          
          <Text className="text-white text-3xl font-mono tracking-widest mt-4 shadow-sm">
            {cardNumber || '•••• •••• •••• ••••'}
          </Text>

          <View className="flex-row justify-between mt-4">
            <View className="flex-1 mr-4">
              <Text className="text-orange-200 text-[10px] uppercase tracking-wider mb-1">Titular do Cartão</Text>
              <Text className="text-white font-bold uppercase text-sm tracking-widest shadow-sm" numberOfLines={1}>
                {cardName || 'NOME IMPRESSO'}
              </Text>
            </View>
            <View>
              <Text className="text-orange-200 text-[10px] uppercase tracking-wider mb-1 text-right">Validade</Text>
              <Text className="text-white font-bold text-sm tracking-widest text-right shadow-sm">{expiryDate || 'MM/AA'}</Text>
            </View>
          </View>
        </View>

        {/* FORMULÁRIO */}
        <View className="space-y-4 mb-8">
          <View>
            <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">Número do Cartão</Text>
            <TextInput 
              placeholder="0000 0000 0000 0000"
              placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
              className="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl px-4 py-3 text-slate-900 dark:text-white text-base font-mono"
              keyboardType="number-pad"
              value={cardNumber}
              onChangeText={(t) => setCardNumber(formatCardNumber(t))}
              maxLength={19}
            />
          </View>

          <View>
            <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">Nome Impresso no Cartão</Text>
            <TextInput 
              placeholder="Ex: FELIPE TORRES"
              placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
              className="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl px-4 py-3 text-slate-900 dark:text-white text-base uppercase"
              autoCapitalize="characters"
              value={cardName}
              onChangeText={setCardName}
            />
          </View>

          <View className="flex-row justify-between">
            <View className="w-[48%]">
              <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">Validade</Text>
              <TextInput 
                placeholder="MM/AA"
                placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
                className="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl px-4 py-3 text-slate-900 dark:text-white text-base text-center font-mono"
                keyboardType="number-pad"
                value={expiryDate}
                onChangeText={(t) => setExpiryDate(formatExpiry(t))}
                maxLength={5}
              />
            </View>

            <View className="w-[48%]">
              <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">CVV</Text>
              <TextInput 
                placeholder={currentBrand === 'amex' ? "1234" : "123"}
                placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
                className="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl px-4 py-3 text-slate-900 dark:text-white text-base text-center font-mono"
                keyboardType="number-pad"
                value={cvv}
                onChangeText={setCvv}
                maxLength={currentBrand === 'amex' ? 4 : 3}
                secureTextEntry
              />
            </View>
          </View>

          <View className="mt-2">
            <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">CPF do Titular</Text>
            <TextInput 
              placeholder="000.000.000-00"
              placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
              className="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl px-4 py-3 text-slate-900 dark:text-white text-base font-mono"
              keyboardType="number-pad"
              value={cpf}
              onChangeText={(t) => setCpf(formatCpf(t))}
              maxLength={14}
            />
          </View>
        </View>

      </ScrollView>

      {/* RODAPÉ E BOTÃO DE PAGAR */}
      <View className="absolute bottom-0 w-full bg-white dark:bg-slate-800 border-t border-gray-200 dark:border-slate-700 p-6 pb-8 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)]">
        <View className="flex-row justify-between mb-4">
          <Text className="text-slate-500 dark:text-slate-400 text-lg">Total a Pagar:</Text>
          <Text className="text-orange-600 dark:text-orange-500 font-bold text-2xl">{formatPrice(total)}</Text>
        </View>

        <TouchableOpacity 
          className="w-full bg-green-600 rounded-xl py-4 flex-row justify-center items-center active:scale-95 shadow-md shadow-green-600/30"
          onPress={handlePayment}
          disabled={isSubmitting}
        >
          {isSubmitting ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <Feather name="lock" size={18} color="#fff" className="mr-2" />
              <Text className="text-white font-bold text-lg">Pagar e Confirmar</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}