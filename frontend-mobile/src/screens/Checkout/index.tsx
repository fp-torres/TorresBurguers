import React, { useState, useContext, useCallback, useEffect, useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, ScrollView, TextInput, ActivityIndicator, Alert } from 'react-native';
import { useNavigation, useFocusEffect, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';
import axios from 'axios';

import { AppStackParamList } from '../../routes/app.routes';
import { resetToMyOrders } from '../../routes/navigation';
import { CartContext } from '../../contexts/CartContext';
import { ThemeContext } from '../../contexts/ThemeContext';
import { AuthContext } from '../../contexts/AuthContext';
import { StoreContext } from '../../contexts/StoreContext';
import RemoteImage from '../../components/RemoteImage';
import KeyboardAwareScreen, { useKeyboardVisible } from '../../components/KeyboardAwareScreen';
import api, { LONG_TIMEOUT_MS } from '../../services/api';
import { formatPrice, formatTime, parseMoney } from '../../utils/format';
import {
  attemptKey,
  buildOrderItems,
  cancelPayment,
  checkoutErrorMessage,
  fetchPaymentStatus,
  isFailedPaymentStatus,
  isUncertainFailure,
  loadActivePix,
  pixExpiresAt,
  showCreatedOrder,
  storeActivePix,
  type PaymentAttempt,
  type PaymentCardParams,
  type PaymentPixParams,
  type PixPaymentResponse,
  type Quote,
  type QuotePayload,
  type StoredPix,
} from './checkoutApi';

interface Address {
  id: number;
  street: string;
  number: string;
  neighborhood: string;
  city: string;
  nickname?: string;
}

type PayMode = 'ONLINE' | 'OFFLINE';
type OnlineMethod = 'PIX' | 'CREDIT_CARD' | 'DEBIT_CARD';
type OfflineMethod = 'MONEY' | 'CREDIT_CARD' | 'DEBIT_CARD';
type FeatherName = React.ComponentProps<typeof Feather>['name'];

const ONLINE_OPTIONS: { value: OnlineMethod; label: string; icon: FeatherName }[] = [
  { value: 'PIX', label: 'PIX', icon: 'zap' },
  { value: 'CREDIT_CARD', label: 'Crédito', icon: 'credit-card' },
  { value: 'DEBIT_CARD', label: 'Débito', icon: 'credit-card' },
];

const OFFLINE_OPTIONS: { value: OfflineMethod; label: string; icon: FeatherName }[] = [
  { value: 'MONEY', label: 'Dinheiro', icon: 'dollar-sign' },
  { value: 'CREDIT_CARD', label: 'Crédito (maquininha)', icon: 'credit-card' },
  { value: 'DEBIT_CARD', label: 'Débito (maquininha)', icon: 'credit-card' },
];

export default function Checkout() {
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  const route = useRoute<RouteProp<AppStackParamList, 'Checkout'>>();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();

  const { cart, totalCartValue, clearCart } = useContext(CartContext);
  const { activeTheme } = useContext(ThemeContext);
  const { user } = useContext(AuthContext);
  const { isOpen: storeIsOpen, closedMessage, refresh: refreshStore } = useContext(StoreContext);

  const [orderType, setOrderType] = useState<'DELIVERY' | 'TAKEOUT'>('DELIVERY');
  const [payMode, setPayMode] = useState<PayMode>('ONLINE');
  const [onlineMethod, setOnlineMethod] = useState<OnlineMethod>('PIX');
  const [offlineMethod, setOfflineMethod] = useState<OfflineMethod>('MONEY');
  const [changeFor, setChangeFor] = useState('');

  const [addresses, setAddresses] = useState<Address[]>([]);
  const [selectedAddress, setSelectedAddress] = useState<number | null>(null);
  const [loadingAddresses, setLoadingAddresses] = useState(true);
  const [showAllAddresses, setShowAllAddresses] = useState(false);

  const [quote, setQuote] = useState<{ key: string; data: Quote } | null>(null);
  const [quoteError, setQuoteError] = useState<{ key: string; message: string } | null>(null);
  const [quoteNonce, setQuoteNonce] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // PIX gerado antes e ainda não pago (o app pode ter sido fechado): reabre o mesmo código
  const [storedPix, setStoredPix] = useState<StoredPix | null>(null);
  const submittingRef = useRef(false);
  // Chave da tentativa de PIX: repetida se a resposta não chegar (nunca gera dois PIX)
  const pixAttemptRef = useRef<PaymentAttempt | null>(null);

  const placeholderColor = activeTheme === 'dark' ? '#64748b' : '#9ca3af';
  const mutedIconColor = activeTheme === 'dark' ? '#9ca3af' : '#64748b';
  const clientId = user?.role === 'CLIENT' ? user.id : null;

  // Endereço recém-cadastrado (AddAddress volta com params.selectedAddressId)
  const newAddressId = route.params?.selectedAddressId;
  useEffect(() => {
    if (newAddressId === undefined || newAddressId === null) return;
    const id = Number(newAddressId);
    if (Number.isInteger(id) && id > 0) {
      setSelectedAddress(id);
      setOrderType('DELIVERY');
    }
  }, [newAddressId]);

  // Endereços e status da loja: recarrega ao voltar para a tela (ex.: depois de cadastrar um endereço)
  useFocusEffect(
    useCallback(() => {
      let active = true;
      refreshStore();
      api.get<Address[]>('/addresses')
        .then(({ data }) => {
          if (!active) return;
          setAddresses(data);
          setSelectedAddress((current) => {
            if (current !== null && data.some((address) => address.id === current)) return current;
            return data.length ? data[data.length - 1].id : null; // o mais recente
          });
        })
        .catch(() => undefined)
        .finally(() => {
          if (active) setLoadingAddresses(false);
        });
      return () => {
        active = false;
      };
    }, [refreshStore]),
  );

  // PIX pendente guardado: se já foi pago (ou cancelado) enquanto o app estava fechado, resolve aqui
  useFocusEffect(
    useCallback(() => {
      let active = true;
      if (clientId === null) return undefined;
      (async () => {
        const saved = await loadActivePix(clientId);
        if (!saved) {
          if (active) setStoredPix(null);
          return;
        }
        const status = await fetchPaymentStatus(saved.params.payment_id);
        if (!active) return;
        if (status?.status === 'approved' && typeof status.orderId === 'number') {
          await storeActivePix(clientId, null);
          clearCart();
          showCreatedOrder(navigation, status.orderId);
          Alert.alert('Pagamento aprovado! 🎉', 'Seu PIX foi confirmado e o pedido já foi registrado.');
          return;
        }
        if (status && isFailedPaymentStatus(status.status)) {
          await storeActivePix(clientId, null);
          setStoredPix(null);
          return;
        }
        setStoredPix(saved);
      })();
      return () => {
        active = false;
      };
    }, [clientId, clearCart, navigation]),
  );

  // --- Orçamento do servidor ---
  const items = useMemo(() => buildOrderItems(cart), [cart]);
  const deliveryAddressId = orderType === 'DELIVERY' ? selectedAddress : null;
  const deliveryReady = orderType === 'TAKEOUT' || deliveryAddressId !== null;
  // Entrega ainda sem endereço: orça como retirada só para já mostrar os valores dos itens
  const quoteBody = useMemo<QuotePayload>(
    () => (deliveryAddressId !== null ? { items, type: 'DELIVERY', addressId: deliveryAddressId } : { items, type: 'TAKEOUT' }),
    [items, deliveryAddressId],
  );
  const quoteKey = useMemo(() => JSON.stringify(quoteBody), [quoteBody]);
  const canQuote = user?.role === 'CLIENT' && items.length > 0;

  // Novo orçamento quando o pedido muda, quando a loja abre/fecha ou em "Tentar novamente"
  useEffect(() => {
    if (!canQuote) return;
    const controller = new AbortController();
    // Espera o cliente parar de mexer no pedido antes de pedir um novo orçamento
    const timer = setTimeout(async () => {
      try {
        const { data } = await api.post<Quote>('/orders/quote', JSON.parse(quoteKey) as QuotePayload, {
          signal: controller.signal,
          timeout: LONG_TIMEOUT_MS,
        });
        setQuote({ key: quoteKey, data });
        setQuoteError(null);
      } catch (error) {
        if (controller.signal.aborted || axios.isCancel(error)) return;
        setQuoteError({ key: quoteKey, message: checkoutErrorMessage(error, 'Não foi possível calcular o total do pedido.') });
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [canQuote, quoteKey, storeIsOpen, quoteNonce]);

  const quoteData = canQuote && quote?.key === quoteKey ? quote.data : null;
  const quoteErrorMessage = canQuote && quoteError?.key === quoteKey ? quoteError.message : null;
  const payableTotal = quoteData && deliveryReady ? quoteData.total : null;
  const orderPayload = deliveryReady ? quoteBody : null;
  // Loja: status compartilhado do app + o informado no último orçamento
  const storeOpen = storeIsOpen && (quoteData ? quoteData.store_open : true);

  function retryQuote() {
    setQuoteError(null);
    setQuoteNonce((value) => value + 1);
  }

  function openStoredPix(saved: StoredPix) {
    navigation.navigate('PaymentPix', { ...saved.params });
  }

  async function generatePix(payload: QuotePayload) {
    if (clientId === null) return;
    const payloadKey = JSON.stringify(payload);

    // Já existe um PIX pendente para este mesmo pedido: reabre o código em vez de gerar outro
    if (storedPix && storedPix.payloadKey === payloadKey) {
      openStoredPix(storedPix);
      return;
    }
    // O carrinho mudou: o PIX anterior é cancelado antes (nunca ficam dois códigos valendo)
    if (storedPix) {
      const previousId = storedPix.params.payment_id;
      try {
        await cancelPayment(previousId);
      } catch (error) {
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        if (status === 409) {
          // O PIX anterior já foi pago: o pedido dele existe (ou vai existir em instantes)
          const paid = await fetchPaymentStatus(previousId);
          await storeActivePix(clientId, null);
          setStoredPix(null);
          clearCart();
          if (typeof paid?.orderId === 'number') showCreatedOrder(navigation, paid.orderId);
          else resetToMyOrders(navigation);
          Alert.alert('PIX anterior já foi pago', 'O pedido daquele PIX foi registrado. Confira em Meus Pedidos antes de pedir de novo.');
          return;
        }
        if (status !== 404 && status !== 403) {
          throw new Error('Não foi possível cancelar o PIX anterior agora. Tente de novo em instantes.');
        }
      }
      await storeActivePix(clientId, null);
      setStoredPix(null);
    }

    // Mesma tentativa (mesmo pedido) = mesma chave: repetir depois de uma falha de rede não gera outro PIX
    const attempt = attemptKey(pixAttemptRef.current, payloadKey);
    pixAttemptRef.current = attempt;
    let data: PixPaymentResponse;
    try {
      ({ data } = await api.post<PixPaymentResponse>(
        '/payment/pix',
        { order: payload, idempotencyKey: attempt.key },
        { timeout: LONG_TIMEOUT_MS },
      ));
    } catch (error) {
      if (!isUncertainFailure(error)) pixAttemptRef.current = null;
      throw error;
    }
    pixAttemptRef.current = null;

    const params: PaymentPixParams = {
      payment_id: data.id,
      qr_code: data.qr_code,
      qr_code_base64: data.qr_code_base64 ?? '',
      total: data.amount,
      expires_at: pixExpiresAt(data),
      simulation: !!data.simulation,
    };
    const saved: StoredPix = { payloadKey, params };
    await storeActivePix(clientId, saved);
    setStoredPix(saved);
    navigation.navigate('PaymentPix', { ...params });
  }

  async function handleFinishOrder() {
    if (submittingRef.current) return;

    if (!user || user.role !== 'CLIENT') {
      Alert.alert('Atenção', 'Entre com uma conta de cliente para finalizar o pedido.');
      return;
    }
    if (!cart.length) {
      Alert.alert('Carrinho vazio', 'Adicione itens antes de finalizar.');
      return;
    }
    if (!storeOpen) {
      Alert.alert('Loja fechada', closedMessage);
      return;
    }
    if (orderType === 'DELIVERY' && selectedAddress === null) {
      Alert.alert('Atenção', 'Selecione um endereço para entrega.');
      return;
    }
    if (quoteErrorMessage) {
      Alert.alert('Não foi possível continuar', quoteErrorMessage);
      return;
    }
    if (!orderPayload || payableTotal === null) {
      Alert.alert('Aguarde', 'Estamos calculando o total do pedido.');
      return;
    }

    let change: string | undefined;
    if (payMode === 'OFFLINE' && offlineMethod === 'MONEY' && changeFor.trim()) {
      const value = parseMoney(changeFor);
      if (value > 0) {
        if (value < payableTotal) {
          Alert.alert('Troco', `O troco deve ser para um valor maior ou igual ao total (${formatPrice(payableTotal)}).`);
          return;
        }
        change = changeFor.trim();
      }
    }

    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      if (payMode === 'ONLINE' && onlineMethod === 'PIX') {
        // Gera o PIX (valor calculado no servidor); quando for pago, o servidor cria o pedido
        await generatePix(orderPayload);
      } else if (payMode === 'ONLINE') {
        const params: PaymentCardParams = {
          payload_order: { ...orderPayload, paymentMethod: onlineMethod },
          total: payableTotal,
          email: user.email,
        };
        navigation.navigate('PaymentCard', { ...params });
      } else {
        const { data } = await api.post<{ id: number }>(
          '/orders',
          { ...orderPayload, paymentMethod: offlineMethod, ...(change ? { changeFor: change } : {}) },
          { timeout: LONG_TIMEOUT_MS },
        );
        clearCart();
        showCreatedOrder(navigation, data.id);
        Alert.alert('Pedido confirmado! 🎉', 'Seu pedido foi recebido e já vai começar a ser preparado.');
      }
    } catch (error) {
      if (isUncertainFailure(error) && axios.isAxiosError(error) && !error.response) {
        Alert.alert(
          'Sem confirmação',
          'Não recebemos a resposta a tempo. Confira em Meus Pedidos antes de tentar de novo (repetir um PIX é seguro: o mesmo código é reaproveitado).',
        );
      } else {
        Alert.alert('Ops!', checkoutErrorMessage(error, 'Houve um erro ao processar seu pedido. Tente novamente.'));
      }
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  // Lista de endereços (o mais novo no topo)
  const reversedAddresses = [...addresses].reverse();
  const displayedAddresses = showAllAddresses ? reversedAddresses : reversedAddresses.slice(0, 3);

  const quoteLines = quoteData && quoteData.items.length === cart.length ? quoteData.items : null;
  const subtotal = quoteData ? quoteData.subtotal : totalCartValue;
  let deliveryLabel: string;
  if (orderType === 'TAKEOUT') deliveryLabel = 'Grátis (retirada)';
  else if (!deliveryReady) deliveryLabel = 'Selecione o endereço';
  else if (quoteData) deliveryLabel = quoteData.delivery_fee > 0 ? formatPrice(quoteData.delivery_fee) : 'Grátis';
  else deliveryLabel = '--';

  const confirmLabel =
    payMode === 'OFFLINE' ? 'Confirmar Pedido' : onlineMethod === 'PIX' ? 'Gerar PIX' : 'Pagar com Cartão';
  const confirmDisabled = isSubmitting || !storeOpen || cart.length === 0;
  const methodOptions = payMode === 'ONLINE' ? ONLINE_OPTIONS : OFFLINE_OPTIONS;
  const activeMethod = payMode === 'ONLINE' ? onlineMethod : offlineMethod;
  // Com o teclado aberto o rodapé encosta nele e mostra só o total e o botão (sobra espaço para o campo)
  const footerPadding = keyboardVisible ? 12 : Math.max(insets.bottom, 8) + 16;

  return (
    <KeyboardAwareScreen className="flex-1 bg-gray-50 dark:bg-slate-900">
      <View className="px-6 pb-4 bg-white dark:bg-slate-800 shadow-sm z-10" style={{ paddingTop: insets.top + 16 }}>
        <View className="flex-row items-center">
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            disabled={isSubmitting}
            accessibilityRole="button"
            accessibilityLabel="Voltar"
            className="w-10 h-10 bg-gray-100 dark:bg-slate-900 rounded-full justify-center items-center"
          >
            <Feather name="arrow-left" size={24} color="#f97316" />
          </TouchableOpacity>
          <Text className="text-2xl font-bold text-slate-900 dark:text-white ml-4">Checkout</Text>
        </View>
      </View>

      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: 24 }}
        keyboardShouldPersistTaps="handled"
      >

        {!storeOpen && (
          <View className="bg-amber-50 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700 rounded-xl p-4 mb-6 flex-row items-start">
            <Feather name="lock" size={20} color="#d97706" />
            <View className="flex-1 ml-3">
              <Text className="font-bold text-amber-800 dark:text-amber-300">Loja fechada</Text>
              <Text className="text-amber-700 dark:text-amber-200 text-sm mt-1">{closedMessage}</Text>
            </View>
          </View>
        )}

        {storedPix && (
          <TouchableOpacity
            onPress={() => openStoredPix(storedPix)}
            accessibilityRole="button"
            accessibilityLabel="Abrir o PIX que aguarda pagamento"
            className="bg-teal-50 dark:bg-teal-900/30 border border-teal-300 dark:border-teal-700 rounded-xl p-4 mb-6 flex-row items-center"
          >
            <Feather name="clock" size={20} color="#0f766e" />
            <View className="flex-1 ml-3">
              <Text className="font-bold text-teal-800 dark:text-teal-300">PIX aguardando pagamento</Text>
              <Text className="text-teal-700 dark:text-teal-200 text-sm mt-1">
                {formatPrice(storedPix.params.total)} · vence às {formatTime(new Date(storedPix.params.expires_at))}. Se você pagar, o pedido aparece em Meus Pedidos.
              </Text>
            </View>
            <Text className="text-teal-700 dark:text-teal-300 font-bold ml-2">Abrir</Text>
          </TouchableOpacity>
        )}

        <Text className="text-lg font-bold text-slate-900 dark:text-white mb-4">Como você deseja receber?</Text>
        <View className="flex-row justify-between mb-8">
          <TouchableOpacity
            className={`flex-1 flex-row items-center justify-center py-4 rounded-xl border ${orderType === 'DELIVERY' ? 'bg-orange-50 border-orange-500 dark:bg-orange-600/20' : 'bg-white border-gray-200 dark:bg-slate-800 dark:border-slate-700'} mr-2`}
            onPress={() => setOrderType('DELIVERY')}
            disabled={isSubmitting}
          >
            <Feather name="truck" size={20} color={orderType === 'DELIVERY' ? '#f97316' : mutedIconColor} />
            <Text className={`ml-2 font-bold ${orderType === 'DELIVERY' ? 'text-orange-600 dark:text-orange-500' : 'text-slate-500 dark:text-slate-400'}`}>Entrega</Text>
          </TouchableOpacity>

          <TouchableOpacity
            className={`flex-1 flex-row items-center justify-center py-4 rounded-xl border ${orderType === 'TAKEOUT' ? 'bg-orange-50 border-orange-500 dark:bg-orange-600/20' : 'bg-white border-gray-200 dark:bg-slate-800 dark:border-slate-700'} ml-2`}
            onPress={() => setOrderType('TAKEOUT')}
            disabled={isSubmitting}
          >
            <Feather name="shopping-bag" size={20} color={orderType === 'TAKEOUT' ? '#f97316' : mutedIconColor} />
            <Text className={`ml-2 font-bold ${orderType === 'TAKEOUT' ? 'text-orange-600 dark:text-orange-500' : 'text-slate-500 dark:text-slate-400'}`}>Retirada</Text>
          </TouchableOpacity>
        </View>

        {orderType === 'DELIVERY' && (
          <View className="mb-8">
            <View className="flex-row justify-between items-end mb-4">
              <Text className="text-lg font-bold text-slate-900 dark:text-white">Endereço de Entrega</Text>
              <TouchableOpacity onPress={() => navigation.navigate('AddAddress')} disabled={isSubmitting}>
                <Text className="text-orange-500 font-bold">+ Novo</Text>
              </TouchableOpacity>
            </View>

            {loadingAddresses ? (
              <ActivityIndicator size="small" color="#f97316" />
            ) : addresses.length === 0 ? (
              <View className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-dashed border-gray-300 dark:border-slate-600 items-center">
                <Feather name="map-pin" size={32} color={activeTheme === 'dark' ? '#475569' : '#9ca3af'} />
                <Text className="text-slate-500 dark:text-slate-400 text-center mt-2">
                  Você ainda não tem endereços.{'\n'}Toque em + Novo para adicionar.
                </Text>
              </View>
            ) : (
              <View>
                {displayedAddresses.map((addr) => (
                  <TouchableOpacity
                    key={addr.id}
                    onPress={() => setSelectedAddress(addr.id)}
                    disabled={isSubmitting}
                    className={`p-4 rounded-xl mb-3 flex-row items-center border ${selectedAddress === addr.id ? 'border-orange-500 bg-orange-50 dark:bg-orange-600/10' : 'border-gray-200 bg-white dark:border-slate-700 dark:bg-slate-800'}`}
                  >
                    <View className={`w-5 h-5 rounded-full border-2 items-center justify-center mr-3 ${selectedAddress === addr.id ? 'border-orange-500' : 'border-gray-300 dark:border-slate-600'}`}>
                      {selectedAddress === addr.id && <View className="w-2.5 h-2.5 rounded-full bg-orange-500" />}
                    </View>
                    <View className="flex-1">
                      <Text className="font-bold text-slate-900 dark:text-white text-base" numberOfLines={1}>
                        {addr.nickname ? `${addr.nickname} - ` : ''}{addr.street}, {addr.number}
                      </Text>
                      <Text className="text-slate-500 dark:text-slate-400 text-sm" numberOfLines={1}>
                        {addr.neighborhood} - {addr.city}
                      </Text>
                    </View>
                  </TouchableOpacity>
                ))}

                {addresses.length > 3 && (
                  <TouchableOpacity onPress={() => setShowAllAddresses(!showAllAddresses)} className="py-2 items-center">
                    <Text className="text-slate-500 dark:text-slate-400 font-medium text-sm">
                      {showAllAddresses ? 'Ocultar endereços' : `Ver todos os ${addresses.length} endereços`}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
          </View>
        )}

        <Text className="text-lg font-bold text-slate-900 dark:text-white mb-4">Resumo do Pedido</Text>
        <View className="bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 p-4 mb-8">
          {cart.map((item, index) => {
            const lineTotal = quoteLines?.[index]?.lineTotal ?? item.total;
            return (
              <View key={item.id} className="flex-row items-center mb-3">
                <RemoteImage path={item.product.image} className="w-12 h-12 rounded-lg" iconSize={18} />
                <View className="flex-1 ml-3">
                  <Text className="text-slate-900 dark:text-white font-medium" numberOfLines={1}>
                    {item.quantity}x {item.product.name}
                  </Text>
                  {item.meatPoint ? (
                    <Text className="text-orange-600 dark:text-orange-400 text-xs font-bold">🔥 {item.meatPoint}</Text>
                  ) : null}
                  {item.addons.length > 0 && (
                    <Text className="text-slate-500 dark:text-slate-400 text-xs" numberOfLines={1}>
                      + {item.addons.map(({ addon, quantity }) => `${quantity}x ${addon.name}`).join(', ')}
                    </Text>
                  )}
                  {item.observation ? (
                    <Text className="text-slate-500 dark:text-slate-400 text-xs italic" numberOfLines={2}>
                      Obs: {item.observation}
                    </Text>
                  ) : null}
                </View>
                <Text className="text-slate-900 dark:text-white font-bold ml-2">{formatPrice(lineTotal)}</Text>
              </View>
            );
          })}
          {quoteErrorMessage && (
            <View className="mt-1">
              <View className="flex-row items-start">
                <Feather name="alert-circle" size={16} color="#ef4444" />
                <Text className="text-red-500 text-sm ml-2 flex-1">{quoteErrorMessage}</Text>
              </View>
              <TouchableOpacity
                onPress={retryQuote}
                accessibilityRole="button"
                className="flex-row items-center self-start mt-2 py-1"
              >
                <Feather name="rotate-cw" size={14} color="#f97316" />
                <Text className="text-orange-500 font-bold text-sm ml-1">Tentar novamente</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        <Text className="text-lg font-bold text-slate-900 dark:text-white mb-4">Forma de Pagamento</Text>
        <View className="flex-row bg-gray-100 dark:bg-slate-800 rounded-xl p-1 mb-4">
          {(['ONLINE', 'OFFLINE'] as PayMode[]).map((mode) => (
            <TouchableOpacity
              key={mode}
              onPress={() => setPayMode(mode)}
              disabled={isSubmitting}
              className={`flex-1 py-2.5 rounded-lg items-center ${payMode === mode ? 'bg-white dark:bg-slate-700' : ''}`}
            >
              <Text className={`font-bold text-sm ${payMode === mode ? 'text-orange-600 dark:text-orange-500' : 'text-slate-500 dark:text-slate-400'}`}>
                {mode === 'ONLINE' ? 'Pagar pelo app' : orderType === 'TAKEOUT' ? 'Pagar na retirada' : 'Pagar na entrega'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <View className="flex-row flex-wrap justify-between mb-4">
          {methodOptions.map((option) => (
            <TouchableOpacity
              key={option.value}
              onPress={() => (payMode === 'ONLINE' ? setOnlineMethod(option.value as OnlineMethod) : setOfflineMethod(option.value as OfflineMethod))}
              disabled={isSubmitting}
              className={`w-[48%] py-3 px-2 rounded-xl border mb-3 flex-row items-center justify-center ${activeMethod === option.value ? 'border-orange-500 bg-orange-50 dark:bg-orange-600/10' : 'border-gray-200 bg-white dark:border-slate-700 dark:bg-slate-800'}`}
            >
              <Feather name={option.icon} size={16} color={activeMethod === option.value ? '#f97316' : mutedIconColor} />
              <Text className={`font-bold text-center text-sm ml-2 ${activeMethod === option.value ? 'text-orange-600 dark:text-orange-500' : 'text-slate-600 dark:text-slate-300'}`}>
                {option.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {payMode === 'OFFLINE' && offlineMethod === 'MONEY' && (
          <View className="mb-8">
            <Text className="text-slate-700 dark:text-slate-300 font-bold mb-2">Troco para quanto?</Text>
            <TextInput
              placeholder="Ex: 50 ou 100 (deixe vazio se não precisar)"
              placeholderTextColor={placeholderColor}
              keyboardType="decimal-pad"
              className="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl px-4 py-3 text-slate-900 dark:text-white text-base"
              value={changeFor}
              onChangeText={setChangeFor}
              editable={!isSubmitting}
              maxLength={12}
            />
          </View>
        )}
      </ScrollView>

      {/* Rodapé no fluxo: sobe junto com o teclado */}
      <View
        className="bg-white dark:bg-slate-800 border-t border-gray-200 dark:border-slate-700 px-6 pt-4"
        style={{ paddingBottom: footerPadding }}
      >
        {!keyboardVisible && (
          <>
            <View className="flex-row justify-between mb-1">
              <Text className="text-slate-500 dark:text-slate-400">{quoteData ? 'Subtotal' : 'Subtotal (estimado)'}</Text>
              <Text className="text-slate-700 dark:text-slate-300">{formatPrice(subtotal)}</Text>
            </View>
            <View className="flex-row justify-between mb-1">
              <Text className="text-slate-500 dark:text-slate-400">Taxa de entrega</Text>
              <Text className="text-slate-700 dark:text-slate-300">{deliveryLabel}</Text>
            </View>
            {quoteData && deliveryReady && (
              <View className="flex-row justify-between mb-1">
                <Text className="text-slate-500 dark:text-slate-400">Tempo estimado</Text>
                <Text className="text-slate-700 dark:text-slate-300">{quoteData.estimated_delivery_time}</Text>
              </View>
            )}
          </>
        )}
        <View className={`flex-row justify-between items-center mb-4 ${keyboardVisible ? '' : 'mt-2'}`}>
          <Text className="text-slate-900 dark:text-white text-lg font-bold">Total a Pagar:</Text>
          {payableTotal !== null ? (
            <Text className="text-slate-900 dark:text-white font-bold text-2xl">{formatPrice(payableTotal)}</Text>
          ) : canQuote && deliveryReady && !quoteErrorMessage ? (
            <ActivityIndicator size="small" color="#f97316" />
          ) : (
            <Text className="text-slate-400 font-bold text-2xl">--</Text>
          )}
        </View>

        <TouchableOpacity
          className={`w-full rounded-xl py-4 flex-row justify-center items-center ${confirmDisabled ? 'bg-green-600/50' : 'bg-green-600'}`}
          onPress={handleFinishOrder}
          disabled={confirmDisabled}
        >
          {isSubmitting ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <Text className="text-white font-bold text-lg">{storeOpen ? confirmLabel : 'Loja fechada'}</Text>
              <Feather name={storeOpen ? 'check-circle' : 'lock'} size={22} color="#fff" style={{ marginLeft: 8 }} />
            </>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAwareScreen>
  );
}
