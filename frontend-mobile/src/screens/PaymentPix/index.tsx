import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Image, Alert, ActivityIndicator, ScrollView } from 'react-native';
import { useRoute, useNavigation, usePreventRemove, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import Feather from '@expo/vector-icons/Feather';
import axios from 'axios';

import { AppStackParamList } from '../../routes/app.routes';
import { resetToMyOrders } from '../../routes/navigation';
import { CartContext } from '../../contexts/CartContext';
import { AuthContext } from '../../contexts/AuthContext';
import { formatPrice, formatTime } from '../../utils/format';
import {
  PIX_WATCH_GRACE_MS,
  cancelPayment,
  checkoutErrorMessage,
  pollPaymentStatus,
  showCreatedOrder,
  storeActivePix,
  type PaymentPixParams,
  type PollOutcome,
} from '../Checkout/checkoutApi';

type PixRouteProp = RouteProp<{ PaymentPix: PaymentPixParams }, 'PaymentPix'>;

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Pagamento por PIX. O pedido é criado pelo SERVIDOR quando o PIX é pago: sair desta tela (ou fechar
 * o app) é seguro — o pedido aparece em Meus Pedidos e o checkout reabre este mesmo código enquanto valer.
 */
export default function PaymentPix() {
  const route = useRoute<PixRouteProp>();
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  const insets = useSafeAreaInsets();
  const { clearCart } = useContext(CartContext);
  const { user } = useContext(AuthContext);
  const { payment_id, qr_code, qr_code_base64, total, expires_at, simulation } = route.params;

  const [now, setNow] = useState(() => Date.now());
  const [cancelling, setCancelling] = useState(false);
  const [watchNonce, setWatchNonce] = useState(0);

  const pollRef = useRef<AbortController | null>(null);
  const leavingRef = useRef(false); // saída intencional: não pergunta de novo
  const clientId = user?.id ?? null;

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  /** O PIX deixou de estar pendente (pago, cancelado ou vencido): esquece o código guardado. */
  const forgetPix = useCallback(async () => {
    if (clientId !== null) await storeActivePix(clientId, null);
  }, [clientId]);

  const leave = useCallback(() => {
    leavingRef.current = true;
    pollRef.current?.abort();
    navigation.goBack();
  }, [navigation]);

  const handleOutcome = useCallback(async (outcome: PollOutcome) => {
    if (outcome.result === 'aborted') return;

    if (outcome.result === 'approved' || outcome.result === 'approved_pending') {
      await forgetPix();
      clearCart();
      leavingRef.current = true;
      if (typeof outcome.orderId === 'number') {
        showCreatedOrder(navigation, outcome.orderId);
        Alert.alert('Pagamento aprovado! 🎉', 'Seu PIX foi confirmado e o pedido já foi enviado para a cozinha.');
      } else {
        resetToMyOrders(navigation);
        Alert.alert(
          'Pagamento aprovado!',
          `O PIX nº ${payment_id} foi confirmado. O pedido aparece em Meus Pedidos em instantes — não pague de novo. Se não aparecer em alguns minutos, fale com a loja informando este número.`,
        );
      }
      return;
    }

    await forgetPix();
    const messages: Record<'timeout' | 'failed' | 'not_found', [string, string]> = {
      timeout: [
        'PIX vencido',
        'O código PIX expirou. Se você pagou agora há pouco, o pedido aparece em Meus Pedidos; senão, gere um novo PIX.',
      ],
      failed: ['PIX não concluído', 'O pagamento foi cancelado ou venceu. Nenhum pedido foi criado.'],
      not_found: ['Pagamento não encontrado', 'Não conseguimos consultar este PIX. Gere um novo para pagar.'],
    };
    const [title, message] = messages[outcome.result];
    Alert.alert(title, message, [{ text: 'Voltar', onPress: leave }], { cancelable: false });
  }, [clearCart, forgetPix, leave, navigation, payment_id]);

  // Sempre a versão mais recente do tratador, sem reiniciar o acompanhamento a cada render
  const handleOutcomeRef = useRef(handleOutcome);
  useEffect(() => {
    handleOutcomeRef.current = handleOutcome;
  }, [handleOutcome]);

  // Consulta o status até o pedido existir, o PIX falhar ou vencer (o servidor cria o pedido sozinho)
  useEffect(() => {
    const controller = new AbortController();
    pollRef.current = controller;
    pollPaymentStatus(payment_id, {
      intervalMs: 4000,
      timeoutMs: Math.max(0, expires_at + PIX_WATCH_GRACE_MS - Date.now()),
      signal: controller.signal,
      immediate: true,
    }).then((outcome) => handleOutcomeRef.current(outcome));
    return () => controller.abort();
  }, [payment_id, expires_at, watchNonce]);

  /** Cancela no servidor: o código deixa de valer e nunca vira pedido. */
  const cancelPix = useCallback(async () => {
    if (cancelling) return;
    setCancelling(true);
    pollRef.current?.abort();
    try {
      await cancelPayment(payment_id);
      await forgetPix();
      Alert.alert('PIX cancelado', 'Nenhum pedido foi criado. Seu carrinho continua salvo.');
      leave();
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        Alert.alert('Este PIX já foi pago', 'Estamos registrando seu pedido...');
      } else {
        Alert.alert('Não foi possível cancelar', checkoutErrorMessage(error, 'Tente novamente em instantes.'));
      }
      // Continua acompanhando: pago → pedido; ainda pendente → segue aguardando
      setWatchNonce((value) => value + 1);
    } finally {
      setCancelling(false);
    }
  }, [cancelling, payment_id, forgetPix, leave]);

  const confirmCancel = useCallback(() => {
    Alert.alert(
      'Cancelar o PIX?',
      'O código deixa de valer e nenhum pedido será criado. Se você já pagou, não cancele: aguarde a confirmação.',
      [
        { text: 'Continuar pagando', style: 'cancel' },
        { text: 'Sim, cancelar', style: 'destructive', onPress: cancelPix },
      ],
    );
  }, [cancelPix]);

  // Voltar (botão da tela ou do Android) pergunta: sair é seguro, o PIX continua valendo
  usePreventRemove(true, ({ data }) => {
    if (leavingRef.current) {
      navigation.dispatch(data.action);
      return;
    }
    if (cancelling) return;
    Alert.alert(
      'Sair do pagamento?',
      `O PIX continua valendo até ${formatTime(new Date(expires_at))}. Pode sair com segurança: se você pagar, o pedido aparece em Meus Pedidos automaticamente.`,
      [
        { text: 'Ficar', style: 'cancel' },
        { text: 'Cancelar PIX', style: 'destructive', onPress: cancelPix },
        {
          text: 'Sair',
          onPress: () => {
            leavingRef.current = true;
            pollRef.current?.abort();
            navigation.dispatch(data.action);
          },
        },
      ],
    );
  });

  async function copyToClipboard() {
    if (!qr_code) {
      Alert.alert('Código indisponível', 'Volte e gere um novo PIX.');
      return;
    }
    try {
      await Clipboard.setStringAsync(qr_code);
      Alert.alert('Copiado!', 'Código PIX copiado para a área de transferência.');
    } catch {
      Alert.alert('Não foi possível copiar', 'Toque e segure o código abaixo do QR Code para copiá-lo manualmente.');
    }
  }

  const expired = expires_at <= now;

  return (
    <View className="flex-1 bg-slate-900" style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}>

      <View className="flex-row items-center px-6 pt-4 pb-4">
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          disabled={cancelling}
          accessibilityRole="button"
          accessibilityLabel="Voltar"
          className="w-10 h-10 bg-slate-800 rounded-full justify-center items-center"
        >
          <Feather name="arrow-left" size={24} color="#fff" />
        </TouchableOpacity>
        <Text className="text-xl font-bold text-white ml-4">Finalizar Pagamento</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24, paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
      >
        <View className="bg-white w-full rounded-3xl p-8 items-center">

          <View className="w-16 h-16 bg-teal-100 rounded-full items-center justify-center mb-4">
            <Text className="text-teal-700 font-extrabold text-lg">PIX</Text>
          </View>

          <Text className="text-2xl font-bold text-slate-900 mb-2">Pague com PIX</Text>
          <Text className="text-slate-500 text-center mb-6">
            Abra o app do seu banco, escolha PIX e aponte a câmera, ou cole o código abaixo.
          </Text>

          <Text className="text-3xl font-bold text-teal-600 mb-6">{formatPrice(total)}</Text>

          {/* QR Code */}
          <View className="p-2 border-2 border-dashed border-gray-300 rounded-2xl mb-4 bg-white">
            {qr_code_base64 ? (
              <Image source={{ uri: `data:image/png;base64,${qr_code_base64}` }} className="w-48 h-48" resizeMode="contain" />
            ) : (
              <View className="w-48 h-48 items-center justify-center bg-gray-50 rounded-xl px-4">
                <Feather name="grid" size={48} color="#94a3b8" />
                <Text className="text-slate-500 text-xs text-center mt-3">
                  QR Code de teste. Use o código "copia e cola" abaixo.
                </Text>
              </View>
            )}
          </View>

          <Text selectable numberOfLines={2} className="text-slate-400 text-xs font-mono text-center mb-4">
            {qr_code}
          </Text>

          {simulation && (
            <Text className="text-blue-600 text-xs text-center mb-4">
              Ambiente de testes: este PIX é aprovado automaticamente em alguns segundos.
            </Text>
          )}

          <TouchableOpacity
            className="bg-slate-100 flex-row items-center justify-center py-4 px-6 rounded-xl w-full mb-6"
            onPress={copyToClipboard}
          >
            <Feather name="copy" size={20} color="#0f766e" />
            <Text className="text-teal-700 font-bold text-lg ml-2">Copiar Código PIX</Text>
          </TouchableOpacity>

          <View className="flex-row items-center justify-center mb-4">
            <ActivityIndicator size="small" color="#0f766e" />
            <Text className="text-slate-500 font-medium ml-2">
              {expired ? 'Código vencido. Conferindo o pagamento...' : 'Aguardando pagamento...'}
            </Text>
          </View>

          {!expired && (
            <View className="bg-orange-50 px-4 py-2 rounded-full mb-4 flex-row items-center">
              <Feather name="clock" size={16} color="#ea580c" />
              <Text className="text-orange-600 font-bold ml-2">Expira em: {formatRemaining(expires_at - now)}</Text>
            </View>
          )}

          <View className="w-full bg-teal-50 border border-teal-200 rounded-xl p-3 mb-6 flex-row items-start">
            <Feather name="info" size={16} color="#0f766e" />
            <Text className="text-teal-800 text-xs ml-2 flex-1">
              Pode sair desta tela com segurança: assim que o pagamento for confirmado, o pedido é registrado e aparece em
              Meus Pedidos. Não pague o mesmo código duas vezes.
            </Text>
          </View>

          <TouchableOpacity
            className="flex-row items-center justify-center py-3 px-4 rounded-lg"
            onPress={confirmCancel}
            disabled={cancelling}
            accessibilityRole="button"
          >
            {cancelling ? (
              <ActivityIndicator size="small" color="#ef4444" />
            ) : (
              <Feather name="x-circle" size={18} color="#ef4444" />
            )}
            <Text className="text-red-500 font-bold text-base ml-2">Cancelar pagamento</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}
