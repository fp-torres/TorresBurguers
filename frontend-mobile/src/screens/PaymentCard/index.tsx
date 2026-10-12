import React, { useState, useContext, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, ScrollView, TextInput, ActivityIndicator, Alert } from 'react-native';
import { useNavigation, useRoute, usePreventRemove, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';
import axios from 'axios'; // chamada direta ao Mercado Pago (tokenização do cartão e meio pelo BIN)

import { AppStackParamList } from '../../routes/app.routes';
import { resetToMyOrders } from '../../routes/navigation';
import { ThemeContext } from '../../contexts/ThemeContext';
import { CartContext } from '../../contexts/CartContext';
import KeyboardAwareScreen, { useKeyboardVisible } from '../../components/KeyboardAwareScreen';
import api, { LONG_TIMEOUT_MS } from '../../services/api';
import { BRAND } from '../../config/brand';
import { formatPrice } from '../../utils/format';
import {
  IS_TEST_KEY,
  MP_PUBLIC_KEY,
  attemptKey,
  cardRejectionMessage,
  checkoutErrorMessage,
  confirmAlert,
  fetchQuote,
  isUncertainFailure,
  pollPaymentStatus,
  showCreatedOrder,
  toQuotePayload,
  type CardPaymentResponse,
  type PaymentAttempt,
  type PaymentCardParams,
} from '../Checkout/checkoutApi';

type PaymentCardRouteProp = RouteProp<{ PaymentCard: PaymentCardParams }, 'PaymentCard'>;

// --- Máscaras ---
const formatCardNumber = (text: string) =>
  text.replace(/\D/g, '').slice(0, 19).replace(/(\d{4})(?=\d)/g, '$1 ');

const formatExpiry = (text: string) =>
  text.replace(/\D/g, '').replace(/(\d{2})(\d{1,2})/, '$1/$2').substring(0, 5);

const formatCpf = (text: string) =>
  text
    .replace(/\D/g, '')
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d{1,2})$/, '$1-$2')
    .substring(0, 14);

// --- Bandeira (mesma regra do web) ---
const UNKNOWN_BRAND = 'credit_card';

// Faixas de BIN (6 primeiros dígitos) da Elo. Algumas começam com 4 ou 5: são conferidas antes de Visa/Mastercard.
const ELO_BIN_RANGES: [number, number][] = [
  [401178, 401179], [431274, 431274], [438935, 438935], [451416, 451416], [457393, 457393],
  [457631, 457632], [504175, 504175], [506699, 506778], [509000, 509999], [627780, 627780],
  [636297, 636297], [636368, 636368], [650031, 650033], [650035, 650051], [650405, 650439],
  [650485, 650538], [650541, 650598], [650700, 650718], [650720, 650727], [650901, 650978],
  [651652, 651679], [655000, 655019], [655021, 655058],
];

function isEloBin(digits: string): boolean {
  if (digits.length < 6) return false;
  const bin = Number(digits.slice(0, 6));
  return ELO_BIN_RANGES.some(([start, end]) => bin >= start && bin <= end);
}

function detectCardBrand(number: string): string {
  const clean = number.replace(/\D/g, '');
  if (clean.startsWith('5031')) return 'master'; // cartão de teste do Mercado Pago
  if (isEloBin(clean)) return 'elo';
  if (/^(606282|3841[046]0)/.test(clean)) return 'hipercard';
  if (/^4/.test(clean)) return 'visa';
  if (/^5[1-5]/.test(clean) || /^2(22[1-9]|2[3-9][0-9]|[3-6][0-9]{2}|7[01][0-9]|720)/.test(clean)) return 'master';
  if (/^3[47]/.test(clean)) return 'amex';
  return UNKNOWN_BRAND;
}

// Bandeiras com débito no Mercado Pago (Brasil)
const DEBIT_METHODS: Record<string, string> = { visa: 'debvisa', master: 'debmaster', elo: 'debelo' };

/** Dígito verificador (Luhn). */
function isValidCardNumber(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

function isValidCpf(value: string): boolean {
  const cpf = value.replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const check = (length: number) => {
    let sum = 0;
    for (let i = 0; i < length; i++) sum += Number(cpf[i]) * (length + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return check(9) === Number(cpf[9]) && check(10) === Number(cpf[10]);
}

function isValidExpiry(expiry: string): boolean {
  const match = /^(\d{2})\/(\d{2})$/.exec(expiry);
  if (!match) return false;
  const month = Number(match[1]);
  const year = 2000 + Number(match[2]);
  if (month < 1 || month > 12) return false;
  const now = new Date();
  return year > now.getFullYear() || (year === now.getFullYear() && month >= now.getMonth() + 1);
}

/** Meio de pagamento que o Mercado Pago informa para o BIN no tipo escolhido (null = nenhum ou sem resposta). */
async function lookupPaymentMethod(digits: string, debit: boolean): Promise<string | null> {
  try {
    const { data } = await axios.get<{ results?: { id: string; payment_type_id?: string }[] }>(
      'https://api.mercadopago.com/v1/payment_methods/search',
      { params: { public_key: MP_PUBLIC_KEY, bins: digits.slice(0, 8), marketplace: 'NONE' }, timeout: 5000 },
    );
    const wanted = debit ? 'debit_card' : 'credit_card';
    return data.results?.find((method) => method.payment_type_id === wanted)?.id ?? null;
  } catch {
    // Sem consulta: quem chama decide pela bandeira detectada no aparelho
    return null;
  }
}

export default function PaymentCard() {
  const route = useRoute<PaymentCardRouteProp>();
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();

  const { activeTheme } = useContext(ThemeContext);
  const { clearCart } = useContext(CartContext);
  const { payload_order, total, email } = route.params;

  const isDebit = payload_order.paymentMethod === 'DEBIT_CARD';
  const cardTypeLabel = isDebit ? 'Débito' : 'Crédito';

  const [cardNumber, setCardNumber] = useState('');
  const [cardName, setCardName] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [cvv, setCvv] = useState('');
  const [cpf, setCpf] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusText, setStatusText] = useState('');
  // Total exibido: o do checkout, atualizado se o servidor recalcular antes de cobrar
  const [displayTotal, setDisplayTotal] = useState(total);
  // Pagamento aprovado cujo pedido o servidor está registrando
  const [approvedPaymentId, setApprovedPaymentId] = useState<number | null>(null);

  const submittingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // Chave da tentativa: repetida se a resposta não chegar (nunca cobra duas vezes)
  const attemptRef = useRef<PaymentAttempt | null>(null);
  // Saída intencional (pedido registrado ou o cliente escolheu sair): não pergunta de novo
  const leavingRef = useRef(false);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Voltar (botão do Android, botão da tela) é bloqueado durante a cobrança; com o pagamento aprovado, confirma
  usePreventRemove(isSubmitting || approvedPaymentId !== null, ({ data }) => {
    if (leavingRef.current) {
      navigation.dispatch(data.action);
      return;
    }
    if (approvedPaymentId !== null) {
      Alert.alert(
        'Pagamento aprovado',
        `O pagamento nº ${approvedPaymentId} foi aprovado e o pedido está sendo registrado. Se sair agora, ele aparece em Meus Pedidos em instantes. Não pague de novo.`,
        [
          { text: 'Aguardar', style: 'cancel' },
          {
            text: 'Ir para Meus Pedidos',
            onPress: () => {
              leavingRef.current = true;
              abortRef.current?.abort();
              clearCart();
              resetToMyOrders(navigation);
            },
          },
        ],
      );
      return;
    }
    Alert.alert('Aguarde', 'Estamos processando o pagamento. Não saia desta tela até a confirmação.');
  });

  const currentBrand = detectCardBrand(cardNumber);
  const cvvLength = currentBrand === 'amex' ? 4 : 3;
  const placeholderColor = activeTheme === 'dark' ? '#64748b' : '#9ca3af';

  /**
   * Confere o cartão. O meio de pagamento vem do Mercado Pago pelo BIN; sem resposta, vale a bandeira
   * detectada no aparelho. Só recusa a bandeira quando nenhum dos dois reconhece o cartão (Elo e afins).
   */
  async function validateCard(): Promise<{ error: string | null; methodId: string | null }> {
    const digits = cardNumber.replace(/\D/g, '');
    if (!isValidCardNumber(digits)) return { error: 'Número do cartão inválido.', methodId: null };

    const fromMercadoPago = await lookupPaymentMethod(digits, isDebit);
    const fromDevice = isDebit
      ? DEBIT_METHODS[currentBrand] ?? null
      : currentBrand === UNKNOWN_BRAND
        ? null
        : currentBrand;
    const methodId = fromMercadoPago ?? fromDevice;
    if (!methodId) {
      return {
        error:
          currentBrand === UNKNOWN_BRAND
            ? 'Bandeira não aceita. Use Visa, Mastercard, Elo, Amex ou Hipercard.'
            : 'No débito aceitamos Visa, Mastercard e Elo.',
        methodId: null,
      };
    }

    const expectedCvv = methodId === 'amex' ? 4 : cvvLength;
    if (cardName.trim().length < 2) return { error: 'Informe o nome impresso no cartão.', methodId };
    if (!isValidExpiry(expiryDate)) return { error: 'Validade inválida ou cartão vencido.', methodId };
    if (cvv.length !== expectedCvv) return { error: `O CVV deve ter ${expectedCvv} dígitos.`, methodId };
    if (!isValidCpf(cpf)) return { error: 'CPF do titular inválido.', methodId };
    return { error: null, methodId };
  }

  /** O total pode ter mudado desde o checkout (promoção, taxa): o cliente confirma antes de cobrar. */
  async function confirmTotal(): Promise<number | null> {
    try {
      const quote = await fetchQuote(toQuotePayload(payload_order));
      if (!quote.store_open) {
        Alert.alert('Loja fechada', 'A loja acabou de fechar. Nenhum valor foi cobrado.');
        return null;
      }
      if (Math.abs(quote.total - displayTotal) >= 0.005) {
        const accepted = await confirmAlert(
          'O total do pedido mudou',
          `O total passou de ${formatPrice(displayTotal)} para ${formatPrice(quote.total)} (preços ou taxa de entrega atualizados). Deseja continuar?`,
          'Continuar',
        );
        setDisplayTotal(quote.total);
        if (!accepted) return null;
      }
      return quote.total;
    } catch (error) {
      Alert.alert('Ops!', checkoutErrorMessage(error, 'Não foi possível conferir o total do pedido. Tente novamente.'));
      return null;
    }
  }

  /** Resultado da cobrança: o servidor cria o pedido quando o pagamento é aprovado (orderId). */
  async function handleCardResult(data: CardPaymentResponse) {
    let status = data.status;
    let orderId = typeof data.orderId === 'number' ? data.orderId : null;
    let detail = data.status_detail;
    if (status === 'approved') setApprovedPaymentId(data.id);

    // Em análise, ou aprovado com o pedido ainda sendo registrado: acompanha pelo status
    if ((status === 'approved' && orderId === null) || status === 'in_process' || status === 'pending') {
      setStatusText(status === 'approved' ? 'Registrando seu pedido...' : 'Pagamento em análise pelo banco...');
      const controller = new AbortController();
      abortRef.current = controller;
      const outcome = await pollPaymentStatus(data.id, {
        intervalMs: 3000,
        timeoutMs: 60_000,
        signal: controller.signal,
        immediate: status === 'approved',
      });
      abortRef.current = null;
      if (outcome.result === 'aborted') return;
      if (outcome.result === 'approved' || outcome.result === 'approved_pending') {
        status = 'approved';
        orderId = outcome.orderId ?? null;
        setApprovedPaymentId(data.id);
      } else if (outcome.result === 'failed') {
        status = outcome.status ?? 'rejected';
        detail = outcome.statusDetail ?? detail;
      }
    }

    if (status === 'approved') {
      leavingRef.current = true;
      setCardNumber('');
      setCvv('');
      clearCart();
      const simulation = data.simulation ? ' (simulação de testes)' : '';
      if (orderId !== null) {
        showCreatedOrder(navigation, orderId);
        Alert.alert(`Pagamento aprovado${simulation}! 🎉`, 'Seu pedido foi confirmado e já vai ser preparado.');
      } else {
        resetToMyOrders(navigation);
        Alert.alert(
          `Pagamento aprovado${simulation}!`,
          `O pagamento nº ${data.id} foi aprovado. O pedido aparece em Meus Pedidos em instantes — não pague de novo. Se não aparecer em alguns minutos, fale com a loja informando este número.`,
        );
      }
      return;
    }

    if (status === 'rejected' || status === 'cancelled') {
      Alert.alert('Pagamento recusado', cardRejectionMessage(detail));
      return;
    }

    Alert.alert(
      'Pagamento em análise',
      `O pagamento nº ${data.id} ainda está em análise pelo banco. Não pague de novo: se ele for aprovado, o pedido aparece em Meus Pedidos automaticamente.`,
      [
        { text: 'Ficar aqui', style: 'cancel' },
        {
          text: 'Ver Meus Pedidos',
          onPress: () => {
            leavingRef.current = true;
            resetToMyOrders(navigation);
          },
        },
      ],
    );
  }

  async function handlePayment() {
    if (submittingRef.current || approvedPaymentId !== null) return;

    submittingRef.current = true;
    setIsSubmitting(true);
    setStatusText('Conferindo o cartão...');
    try {
      const { error: invalid, methodId } = await validateCard();
      if (invalid || !methodId) {
        Alert.alert('Atenção', invalid ?? 'Confira os dados do cartão.');
        return;
      }

      setStatusText('Conferindo o total...');
      const confirmedTotal = await confirmTotal();
      if (confirmedTotal === null) return;

      setStatusText('Processando pagamento...');
      const digits = cardNumber.replace(/\D/g, '');
      const cleanCpf = cpf.replace(/\D/g, '');
      const [month, year] = expiryDate.split('/');

      // 1. Tokenização direto no Mercado Pago: os dados do cartão nunca passam pelo nosso servidor
      let token: string | undefined;
      try {
        const { data } = await axios.post<{ id?: string }>(
          `https://api.mercadopago.com/v1/card_tokens?public_key=${MP_PUBLIC_KEY}`,
          {
            card_number: digits,
            cardholder: { name: cardName.trim(), identification: { type: 'CPF', number: cleanCpf } },
            security_code: cvv,
            expiration_month: Number(month),
            expiration_year: 2000 + Number(year),
          },
          { timeout: 15000 },
        );
        token = data.id;
      } catch (error) {
        throw new Error(
          axios.isAxiosError(error) && !error.response
            ? 'Sem conexão com o Mercado Pago. Verifique sua internet e tente novamente.'
            : 'Não foi possível validar o cartão. Confira número, validade, CVV e CPF.',
        );
      }
      if (!token) throw new Error('Não foi possível validar o cartão. Confira os dados.');

      // 2. Cobrança: o valor é calculado pelo servidor (nunca enviado pelo app). A mesma tentativa
      //    usa a mesma chave: repetir depois de uma falha de rede não cobra de novo.
      const order = toQuotePayload(payload_order);
      const attempt = attemptKey(attemptRef.current, JSON.stringify(order));
      attemptRef.current = attempt;
      let data: CardPaymentResponse;
      try {
        ({ data } = await api.post<CardPaymentResponse>(
          '/payment/card',
          {
            order,
            token,
            paymentMethodId: methodId,
            installments: 1,
            docType: 'CPF',
            docNumber: cleanCpf,
            idempotencyKey: attempt.key,
          },
          { timeout: LONG_TIMEOUT_MS },
        ));
      } catch (error) {
        if (isUncertainFailure(error)) {
          Alert.alert(
            'Sem confirmação do pagamento',
            'Não recebemos a resposta a tempo. Confira em Meus Pedidos se o pedido foi registrado. Tentar de novo é seguro: você não será cobrado duas vezes.',
            [
              { text: 'Tentar de novo', style: 'cancel' },
              {
                text: 'Ver Meus Pedidos',
                onPress: () => {
                  leavingRef.current = true;
                  resetToMyOrders(navigation);
                },
              },
            ],
          );
          return;
        }
        attemptRef.current = null; // recusa definitiva: a próxima tentativa é outra
        throw error;
      }
      attemptRef.current = null;

      // 3. Aprovado → o servidor já criou o pedido (orderId)
      await handleCardResult(data);
    } catch (error) {
      Alert.alert('Ops!', checkoutErrorMessage(error, 'Houve um erro ao processar seu cartão. Tente novamente.'));
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
      setStatusText('');
    }
  }

  const inputClass = 'bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl px-4 py-3 text-slate-900 dark:text-white text-base';
  const formLocked = isSubmitting || approvedPaymentId !== null;
  // Com o teclado aberto o rodapé encosta nele (a barra de navegação fica por baixo do teclado)
  const footerPadding = keyboardVisible ? 12 : Math.max(insets.bottom, 8) + 16;

  return (
    <KeyboardAwareScreen className="flex-1 bg-gray-50 dark:bg-slate-900">
      <View
        className="px-6 pb-4 bg-white dark:bg-slate-800 shadow-sm z-10 flex-row items-center"
        style={{ paddingTop: insets.top + 16 }}
      >
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          disabled={isSubmitting}
          accessibilityRole="button"
          accessibilityLabel="Voltar"
          className="w-10 h-10 bg-gray-100 dark:bg-slate-900 rounded-full justify-center items-center"
        >
          <Feather name="arrow-left" size={24} color="#f97316" />
        </TouchableOpacity>
        <Text className="text-2xl font-bold text-slate-900 dark:text-white ml-4">Cartão de {cardTypeLabel}</Text>
      </View>

      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: 24 }}
        keyboardShouldPersistTaps="handled"
      >

        {/* Cartão virtual */}
        <View className="bg-orange-600 w-full h-52 rounded-2xl p-6 mb-8 justify-between shadow-lg shadow-orange-600/40 relative overflow-hidden">
          <View className="absolute -right-10 -top-10 w-40 h-40 bg-white/10 rounded-full" />
          <View className="absolute -left-10 -bottom-10 w-32 h-32 bg-black/10 rounded-full" />

          <View className="flex-row justify-between items-start">
            <View className="w-12 h-8 bg-yellow-400 rounded-md border border-yellow-500 justify-center items-center shadow-sm">
              <View className="w-full h-[1px] bg-yellow-500/50 absolute top-1/2" />
              <View className="w-[1px] h-full bg-yellow-500/50 absolute left-1/2" />
            </View>
            <View className="items-end">
              <Text className="text-white font-bold italic text-lg opacity-90 tracking-wider uppercase">
                {currentBrand === UNKNOWN_BRAND ? BRAND.name.toUpperCase() : currentBrand}
              </Text>
              <Text className="text-orange-100 text-[10px] font-bold uppercase tracking-widest">{cardTypeLabel}</Text>
            </View>
          </View>

          <Text className="text-white text-2xl font-mono tracking-widest mt-4" numberOfLines={1} adjustsFontSizeToFit>
            {cardNumber || '•••• •••• •••• ••••'}
          </Text>

          <View className="flex-row justify-between mt-4">
            <View className="flex-1 mr-4">
              <Text className="text-orange-200 text-[10px] uppercase tracking-wider mb-1">Titular do Cartão</Text>
              <Text className="text-white font-bold uppercase text-sm tracking-widest" numberOfLines={1}>
                {cardName || 'NOME IMPRESSO'}
              </Text>
            </View>
            <View>
              <Text className="text-orange-200 text-[10px] uppercase tracking-wider mb-1 text-right">Validade</Text>
              <Text className="text-white font-bold text-sm tracking-widest text-right">{expiryDate || 'MM/AA'}</Text>
            </View>
          </View>
        </View>

        {approvedPaymentId !== null && (
          <View className="bg-green-50 dark:bg-green-900/30 border border-green-300 dark:border-green-700 rounded-xl p-4 mb-6">
            <Text className="font-bold text-green-800 dark:text-green-300">Pagamento nº {approvedPaymentId} aprovado</Text>
            <Text className="text-green-700 dark:text-green-200 text-sm mt-1">
              Estamos registrando seu pedido. Não pague de novo: ele aparece em Meus Pedidos em instantes.
            </Text>
          </View>
        )}

        {/* Formulário */}
        <View className="mb-8">
          <View className="mb-4">
            <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">Número do Cartão</Text>
            <TextInput
              placeholder="0000 0000 0000 0000"
              placeholderTextColor={placeholderColor}
              className={`${inputClass} font-mono`}
              keyboardType="number-pad"
              value={cardNumber}
              onChangeText={(text) => setCardNumber(formatCardNumber(text))}
              maxLength={23}
              editable={!formLocked}
              autoComplete="cc-number"
            />
          </View>

          <View className="mb-4">
            <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">Nome Impresso no Cartão</Text>
            <TextInput
              placeholder="Ex: MARIA SILVA"
              placeholderTextColor={placeholderColor}
              className={`${inputClass} uppercase`}
              autoCapitalize="characters"
              value={cardName}
              onChangeText={(text) => setCardName(text.toUpperCase())}
              maxLength={60}
              editable={!formLocked}
            />
          </View>

          <View className="flex-row justify-between mb-4">
            <View className="w-[48%]">
              <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">Validade</Text>
              <TextInput
                placeholder="MM/AA"
                placeholderTextColor={placeholderColor}
                className={`${inputClass} text-center font-mono`}
                keyboardType="number-pad"
                value={expiryDate}
                onChangeText={(text) => setExpiryDate(formatExpiry(text))}
                maxLength={5}
                editable={!formLocked}
              />
            </View>

            <View className="w-[48%]">
              <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">CVV</Text>
              <TextInput
                placeholder={cvvLength === 4 ? '1234' : '123'}
                placeholderTextColor={placeholderColor}
                className={`${inputClass} text-center font-mono`}
                keyboardType="number-pad"
                value={cvv}
                onChangeText={(text) => setCvv(text.replace(/\D/g, '').slice(0, 4))}
                maxLength={currentBrand === UNKNOWN_BRAND ? 4 : cvvLength}
                secureTextEntry
                editable={!formLocked}
              />
            </View>
          </View>

          <View>
            <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">CPF do Titular</Text>
            <TextInput
              placeholder="000.000.000-00"
              placeholderTextColor={placeholderColor}
              className={`${inputClass} font-mono`}
              keyboardType="number-pad"
              value={cpf}
              onChangeText={(text) => setCpf(formatCpf(text))}
              maxLength={14}
              editable={!formLocked}
            />
          </View>

          {IS_TEST_KEY && (
            <Text className="text-slate-500 dark:text-slate-400 text-xs mt-4">
              Ambiente de testes: cartão 5031 4332 1540 6351, validade 11/30, CVV 123, CPF 123.456.789-09. Nenhum valor real é cobrado.
            </Text>
          )}
          {!!email && (
            <Text className="text-slate-400 dark:text-slate-500 text-xs mt-2">O comprovante será enviado para {email}.</Text>
          )}
        </View>
      </ScrollView>

      {/* Rodapé e botão de pagar (no fluxo: sobe junto com o teclado) */}
      <View
        className="bg-white dark:bg-slate-800 border-t border-gray-200 dark:border-slate-700 px-6 pt-4"
        style={{ paddingBottom: footerPadding }}
      >
        <View className="flex-row justify-between mb-4">
          <Text className="text-slate-500 dark:text-slate-400 text-lg">Total a Pagar:</Text>
          <Text className="text-orange-600 dark:text-orange-500 font-bold text-2xl">{formatPrice(displayTotal)}</Text>
        </View>

        <TouchableOpacity
          className={`w-full rounded-xl py-4 flex-row justify-center items-center ${formLocked ? 'bg-green-600/60' : 'bg-green-600'}`}
          onPress={handlePayment}
          disabled={formLocked}
        >
          {isSubmitting ? (
            <>
              <ActivityIndicator size="small" color="#fff" />
              {!!statusText && <Text className="text-white font-bold ml-2">{statusText}</Text>}
            </>
          ) : (
            <>
              <Feather name="lock" size={18} color="#fff" style={{ marginRight: 8 }} />
              <Text className="text-white font-bold text-lg">Pagar no {cardTypeLabel.toLowerCase()}</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAwareScreen>
  );
}
