import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import {
  Trash2, ArrowRight, MapPin, Store, Plus, Minus, AlertCircle, Clock, Navigation,
  ShieldAlert, Banknote, Loader2, Lock, CheckCircle2, RotateCw,
} from 'lucide-react';
import toast from 'react-hot-toast';

import { useCart, type Addon } from '../../../contexts/CartContext';
import { useAuth } from '../../../contexts/AuthContext';
import { useStoreStatus } from '../../../contexts/StoreStatusContext';
import api, { assetUrl } from '../../../services/api';
import { BRAND } from '../../../config/brand';
import AddressModal from '../../../components/AddressModal';
import ConfirmModal from '../../../components/ConfirmModal';
import { maskMoney, currencyToNumber } from '../../../utils/masks';
import { effectivePrice } from '../../../utils/catalog';

import PaymentForm from './components/PaymentForm';
import PixCheckout from './components/PixCheckout';
import {
  MAX_ITEM_QUANTITY,
  PAYMENT_TIMEOUT_MS,
  PIX_WATCH_GRACE_MS,
  attemptKey,
  buildOrderItems,
  cancelPayment,
  clearLegacyPendingPayment,
  errorMessage,
  formatBRL,
  isUncertainFailure,
  pixExpiresAt,
  pollPaymentStatus,
  readActivePix,
  saveActivePix,
  type ActivePix,
  type OfflineMethod,
  type OnlineMethod,
  type OrderPayload,
  type OrderType,
  type PaymentAttempt,
  type PixPaymentResponse,
  type Quote,
} from './checkout';

const STORE_ADDRESS = {
  street: 'Av. Rio Branco',
  number: '156',
  complement: 'Loja B',
  neighborhood: 'Centro',
  city: 'Rio de Janeiro',
  state: 'RJ',
  zipCode: '20040-003',
};
const STORE_MAP_URL = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
  `${STORE_ADDRESS.street}, ${STORE_ADDRESS.number} - ${STORE_ADDRESS.neighborhood}, ${STORE_ADDRESS.city} - ${STORE_ADDRESS.state}`,
)}`;

const OFFLINE_OPTIONS: { value: OfflineMethod; label: string }[] = [
  { value: 'MONEY', label: 'Dinheiro' },
  { value: 'CREDIT_CARD', label: 'Cartão de crédito (maquininha)' },
  { value: 'DEBIT_CARD', label: 'Cartão de débito (maquininha)' },
];

/** Nova tentativa automática do orçamento depois de uma falha passageira (rede ou 5xx). */
const QUOTE_RETRY_MS = 3000;

interface AddressData {
  id: number;
  street: string;
  number: string;
  neighborhood: string;
  city: string;
  nickname?: string | null;
}

function groupAddons(addons: Addon[]) {
  const groups: Record<string, number> = {};
  addons.forEach((addon) => { groups[addon.name] = (groups[addon.name] || 0) + 1; });
  return Object.entries(groups);
}

export default function ClientCart() {
  const { cartItems, removeFromCart, updateQuantity, clearCart, cartTotal } = useCart();
  const { isAuthenticated, user } = useAuth();
  const { status: storeStatus, refresh: refreshStoreStatus } = useStoreStatus();
  const navigate = useNavigate();

  const isClient = user?.role === 'CLIENT';
  const isStaff = !!user && !isClient;
  const clientId = isClient ? user.id : null;

  // PIX gerado antes de recarregar a página ou de sair do carrinho: continua de onde parou
  const [resumedPix] = useState<ActivePix | null>(() => (clientId !== null ? readActivePix(clientId) : null));

  const [orderType, setOrderType] = useState<OrderType>('TAKEOUT');
  const [paymentType, setPaymentType] = useState<'ONLINE' | 'OFFLINE'>('ONLINE');
  // Online e na entrega têm estados separados: trocar de aba nunca leva a forma errada para o pedido
  const [onlineMethod, setOnlineMethod] = useState<OnlineMethod>(resumedPix ? 'PIX' : 'CREDIT_CARD');
  const [offlineMethod, setOfflineMethod] = useState<OfflineMethod>('MONEY');
  const [changeFor, setChangeFor] = useState('');

  const [addresses, setAddresses] = useState<AddressData[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState<number | null>(null);
  const [isAddressModalOpen, setIsAddressModalOpen] = useState(false);
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);

  const [quote, setQuote] = useState<{ key: string; data: Quote } | null>(null);
  const [quoteError, setQuoteError] = useState<{ key: string; message: string } | null>(null);
  const [quoteNonce, setQuoteNonce] = useState(0);
  const [totalChange, setTotalChange] = useState<{ from: number; to: number } | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [cardProcessing, setCardProcessing] = useState(false);
  const [pixLoading, setPixLoading] = useState(false);
  const [pix, setPix] = useState<ActivePix | null>(resumedPix);
  const [cancellingPix, setCancellingPix] = useState(false);
  // Pagamento aprovado cujo pedido o servidor ainda está registrando (ele registra sozinho)
  const [approvedPaymentId, setApprovedPaymentId] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  // Acompanhamentos de PIX em andamento (cancelados ao sair da página)
  const pollersRef = useRef(new Set<AbortController>());
  const pixControllerRef = useRef<AbortController | null>(null);
  // Chave da tentativa de PIX: repetida se a resposta não chegar (nunca gera dois PIX)
  const pixAttemptRef = useRef<PaymentAttempt | null>(null);
  const totalChangeResolverRef = useRef<((accepted: boolean) => void) | null>(null);
  const autoRetriedQuoteRef = useRef<string | null>(null);
  const quoteRetryTimerRef = useRef<number | undefined>(undefined);

  // --- Orçamento do servidor (subtotal, taxa, total e tempo) ---
  const items = useMemo(() => buildOrderItems(cartItems), [cartItems]);
  const deliveryAddressId = orderType === 'DELIVERY' ? selectedAddressId : null;
  const deliveryReady = orderType === 'TAKEOUT' || deliveryAddressId !== null;
  // Delivery ainda sem endereço: orça como retirada só para já mostrar os valores dos itens
  const quoteBody = useMemo<OrderPayload>(
    () => (deliveryAddressId !== null ? { items, type: 'DELIVERY', addressId: deliveryAddressId } : { items, type: 'TAKEOUT' }),
    [items, deliveryAddressId],
  );
  const quoteKey = useMemo(() => JSON.stringify(quoteBody), [quoteBody]);
  const canQuote = isAuthenticated && isClient && items.length > 0;
  // Status compartilhado da loja (atualizado a cada 30 s e ao voltar para a aba)
  const storeIsOpen = storeStatus ? storeStatus.is_open : null;

  // Novo orçamento quando o pedido muda, quando a loja abre/fecha ou em "Tentar novamente"
  useEffect(() => {
    if (!canQuote) return;
    const controller = new AbortController();
    // Espera o cliente parar de clicar (+/-) antes de pedir um novo orçamento
    const timer = window.setTimeout(async () => {
      try {
        const { data } = await api.post<Quote>('/orders/quote', JSON.parse(quoteKey) as OrderPayload, {
          signal: controller.signal,
          timeout: PAYMENT_TIMEOUT_MS,
        });
        setQuote({ key: quoteKey, data });
        setQuoteError(null);
      } catch (error) {
        if (controller.signal.aborted || axios.isCancel(error)) return;
        setQuoteError({ key: quoteKey, message: errorMessage(error, 'Não foi possível calcular o total do pedido.') });
        // Falha passageira: tenta sozinho uma vez; depois, o botão "Tentar novamente"
        if (isUncertainFailure(error) && autoRetriedQuoteRef.current !== quoteKey) {
          autoRetriedQuoteRef.current = quoteKey;
          quoteRetryTimerRef.current = window.setTimeout(() => setQuoteNonce((value) => value + 1), QUOTE_RETRY_MS);
        }
      }
    }, 350);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(quoteRetryTimerRef.current);
      controller.abort();
    };
  }, [canQuote, quoteKey, storeIsOpen, quoteNonce]);

  const quoteData = canQuote && quote?.key === quoteKey ? quote.data : null;
  const currentQuoteError = canQuote && quoteError?.key === quoteKey ? quoteError.message : null;
  const quoteLoading = canQuote && !quoteData && !currentQuoteError;
  const payableTotal = quoteData && deliveryReady ? quoteData.total : null;
  const orderPayload = deliveryReady ? quoteBody : null;

  // Loja: status compartilhado + o informado no último orçamento (o mais restritivo vale até o novo orçamento)
  const storeOpen = storeIsOpen !== false && (quoteData ? quoteData.store_open : true);

  // Ao abrir o carrinho, confere o status da loja na hora
  useEffect(() => {
    void refreshStoreStatus();
  }, [refreshStoreStatus]);

  // O aviso antigo de "pagamento aprovado sem pedido" não existe mais (o servidor cria o pedido)
  useEffect(() => {
    clearLegacyPendingPayment();
  }, []);

  // --- Endereços ---
  const loadAddresses = useCallback(async (): Promise<AddressData[]> => {
    try {
      const { data } = await api.get<AddressData[]>('/addresses');
      setAddresses(data);
      return data;
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated || !isClient) return;
    let active = true;
    loadAddresses().then((list) => {
      if (!active || !list.length) return;
      setSelectedAddressId((current) => (current !== null && list.some((address) => address.id === current) ? current : list[0].id));
    });
    return () => { active = false; };
  }, [isAuthenticated, isClient, loadAddresses]);

  // Encerra acompanhamentos de PIX ao sair da página (o PIX continua válido: o servidor cria o pedido)
  useEffect(() => {
    const pollers = pollersRef.current;
    return () => {
      pollers.forEach((controller) => controller.abort());
      pollers.clear();
    };
  }, []);

  async function handleAddressSaved(created?: { id?: number }) {
    const previousIds = new Set(addresses.map((address) => address.id));
    const list = await loadAddresses();
    // Seleciona o endereço recém-cadastrado
    const newId = created?.id ?? list.find((address) => !previousIds.has(address.id))?.id;
    if (newId) setSelectedAddressId(newId);
    setOrderType('DELIVERY');
  }

  function openAddressModal() {
    if (!isAuthenticated) {
      setIsLoginModalOpen(true);
      return;
    }
    setIsAddressModalOpen(true);
  }

  function retryQuote() {
    setQuoteError(null);
    setQuoteNonce((value) => value + 1);
  }

  // --- Regras antes de cobrar ou criar o pedido ---
  function getBlockedReason(): string | null {
    if (!isAuthenticated) return null; // visitante: o clique abre o login
    if (isStaff) return 'Contas da equipe não fazem pedidos pela loja.';
    if (!storeOpen) return 'A loja está fechada no momento.';
    if (orderType === 'DELIVERY' && selectedAddressId === null) return 'Selecione um endereço para entrega.';
    if (currentQuoteError) return currentQuoteError;
    if (!quoteData) return 'Calculando o total do pedido...';
    return null;
  }
  const blockedReason = getBlockedReason();

  function ensureCanCheckout(): boolean {
    setErrorMsg('');
    if (!isAuthenticated) {
      setIsLoginModalOpen(true);
      return false;
    }
    if (blockedReason) {
      setErrorMsg(blockedReason);
      toast.error(blockedReason);
      return false;
    }
    return true;
  }

  function showError(message: string) {
    setErrorMsg(message);
    toast.error(message);
  }

  /** Pergunta ao cliente se aceita o novo total (true = continuar). */
  function askTotalChange(from: number, to: number): Promise<boolean> {
    return new Promise((resolve) => {
      totalChangeResolverRef.current = resolve;
      setTotalChange({ from, to });
    });
  }

  function answerTotalChange(accepted: boolean) {
    totalChangeResolverRef.current?.(accepted);
    totalChangeResolverRef.current = null;
    setTotalChange(null);
  }

  /**
   * Recalcula o total no servidor logo antes de pagar ou registrar o pedido. Se mudou (promoção que
   * acabou, taxa nova...), o cliente confirma o novo valor. null = não continuar.
   */
  async function confirmCurrentTotal(): Promise<number | null> {
    if (!orderPayload) return null;
    const shownTotal = payableTotal;
    try {
      const { data } = await api.post<Quote>('/orders/quote', orderPayload, { timeout: PAYMENT_TIMEOUT_MS });
      setQuote({ key: quoteKey, data });
      setQuoteError(null);
      if (!data.store_open) {
        showError('A loja está fechada no momento.');
        return null;
      }
      if (shownTotal !== null && Math.abs(data.total - shownTotal) >= 0.005) {
        const accepted = await askTotalChange(shownTotal, data.total);
        if (!accepted) return null;
      }
      return data.total;
    } catch (error) {
      showError(errorMessage(error, 'Não foi possível conferir o total do pedido. Tente novamente.'));
      return null;
    }
  }

  function finishSuccess(orderId?: number) {
    if (clientId !== null) saveActivePix(clientId, null);
    clearCart();
    toast.success('Pedido realizado com sucesso!');
    navigate('/order-success', { replace: true, state: { orderId } });
  }

  /** Pago, mas o pedido ainda não apareceu: o servidor registra com o que foi pago (não cobrar de novo). */
  function markApprovedPending(paymentId: number) {
    if (clientId !== null) saveActivePix(clientId, null);
    clearCart();
    setApprovedPaymentId(paymentId);
    toast.success('Pagamento aprovado!');
  }

  // --- Pagar na entrega / retirada ---
  function changeForError(total: number): string | null {
    if (offlineMethod !== 'MONEY' || !changeFor) return null;
    const value = currencyToNumber(changeFor);
    if (value > 0 && value < total) return `O troco deve ser para um valor maior ou igual ao total (${formatBRL(total)}).`;
    return null;
  }

  async function handleFinishOffline() {
    if (submitting || !ensureCanCheckout() || !orderPayload || payableTotal === null) return;

    const earlyError = changeForError(payableTotal);
    if (earlyError) {
      showError(earlyError);
      return;
    }

    setSubmitting(true);
    try {
      const total = await confirmCurrentTotal();
      if (total === null) return;
      const changeError = changeForError(total);
      if (changeError) {
        showError(changeError);
        return;
      }
      const change = offlineMethod === 'MONEY' && currencyToNumber(changeFor) > 0 ? changeFor : undefined;

      const { data } = await api.post<{ id: number }>(
        '/orders',
        { ...orderPayload, paymentMethod: offlineMethod, ...(change ? { changeFor: change } : {}) },
        { timeout: PAYMENT_TIMEOUT_MS },
      );
      finishSuccess(data?.id);
    } catch (error) {
      showError(
        isUncertainFailure(error) && axios.isAxiosError(error) && !error.response
          ? 'Não recebemos a confirmação a tempo. Confira em Meus Pedidos se o pedido foi registrado antes de tentar de novo.'
          : errorMessage(error, 'Não foi possível finalizar o pedido.'),
      );
    } finally {
      setSubmitting(false);
    }
  }

  // --- PIX: gera o QR e acompanha; quando for pago, o servidor cria o pedido e devolve o número ---

  async function watchPix(session: ActivePix) {
    pixControllerRef.current?.abort();
    const controller = new AbortController();
    pixControllerRef.current = controller;
    pollersRef.current.add(controller);

    const outcome = await pollPaymentStatus(session.id, {
      intervalMs: 3000,
      timeoutMs: Math.max(0, session.expiresAt + PIX_WATCH_GRACE_MS - Date.now()),
      signal: controller.signal,
      immediate: true,
    });
    pollersRef.current.delete(controller);
    if (outcome.result === 'aborted') return; // cancelamento em andamento ou saiu da página
    if (pixControllerRef.current === controller) pixControllerRef.current = null;

    if (outcome.result === 'approved') {
      finishSuccess(outcome.orderId);
      return;
    }
    if (outcome.result === 'approved_pending') {
      setPix(null);
      markApprovedPending(session.id);
      return;
    }

    if (clientId !== null) saveActivePix(clientId, null);
    setPix(null);
    showError(
      outcome.result === 'timeout'
        ? 'O código PIX expirou. Se você pagou agora há pouco, o pedido aparece em Meus Pedidos; senão, gere um novo código.'
        : outcome.result === 'not_found'
          ? 'Não encontramos este pagamento. Gere um novo PIX.'
          : 'O PIX não foi concluído (cancelado ou vencido) e nenhum pedido foi criado. Gere um novo código para pagar.',
    );
  }

  // Sempre a versão mais recente (o acompanhamento retomado não reinicia a cada render)
  const watchPixRef = useRef(watchPix);
  useEffect(() => {
    watchPixRef.current = watchPix;
  });

  useEffect(() => {
    if (resumedPix) void watchPixRef.current(resumedPix);
  }, [resumedPix]);

  async function handleStartPix() {
    if (pixLoading || pix || !ensureCanCheckout() || !orderPayload || clientId === null) return;
    const payload = orderPayload;

    setPixLoading(true);
    let session: ActivePix | null = null;
    try {
      const total = await confirmCurrentTotal();
      if (total === null) return;

      // Mesma tentativa (mesmo pedido) = mesma chave: repetir depois de uma falha de rede não gera outro PIX
      const attempt = attemptKey(pixAttemptRef.current, JSON.stringify(payload));
      pixAttemptRef.current = attempt;
      let data: PixPaymentResponse;
      try {
        ({ data } = await api.post<PixPaymentResponse>(
          '/payment/pix',
          { order: payload, idempotencyKey: attempt.key },
          { timeout: PAYMENT_TIMEOUT_MS },
        ));
      } catch (error) {
        if (!isUncertainFailure(error)) pixAttemptRef.current = null;
        throw error;
      }
      pixAttemptRef.current = null;

      session = {
        id: data.id,
        copyPaste: data.qr_code,
        amount: data.amount,
        simulation: !!data.simulation,
        expiresAt: pixExpiresAt(data),
      };
      saveActivePix(clientId, session);
      setPix(session);
    } catch (error) {
      showError(errorMessage(error, 'Não foi possível gerar o PIX. Tente novamente.'));
    } finally {
      setPixLoading(false);
    }
    if (session) await watchPix(session);
  }

  async function handleCancelPix() {
    if (!pix || cancellingPix) return;
    const session = pix;
    setCancellingPix(true);
    pixControllerRef.current?.abort();
    try {
      await cancelPayment(session.id);
      if (clientId !== null) saveActivePix(clientId, null);
      setPix(null);
      toast('Pagamento PIX cancelado. Nenhum pedido foi criado.');
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        toast.success('Este PIX já foi pago! Registrando seu pedido...');
      } else {
        toast.error(errorMessage(error, 'Não foi possível cancelar o PIX agora. Tente novamente.'));
      }
      // Continua acompanhando: pago → pedido; ainda pendente → segue aguardando
      void watchPix(session);
    } finally {
      setCancellingPix(false);
    }
  }

  const locked = submitting || cardProcessing || pixLoading || !!pix || cancellingPix;
  const toggleDisabled = locked || isStaff;

  const approvedBox = approvedPaymentId !== null && (
    <div role="status" className="bg-green-50 dark:bg-green-900/20 border border-green-300 dark:border-green-700 rounded-2xl p-5 space-y-3">
      <div className="flex items-start gap-3">
        <CheckCircle2 size={22} className="text-green-600 dark:text-green-400 shrink-0 mt-0.5" />
        <div className="text-sm text-gray-700 dark:text-gray-200 space-y-1">
          <p className="font-bold text-gray-900 dark:text-white">Pagamento aprovado! Estamos registrando seu pedido</p>
          <p>
            Pagamento nº <b>{approvedPaymentId}</b>. O pedido aparece em Meus Pedidos em instantes — não pague de novo.
            Se ele não aparecer em alguns minutos, fale com a loja informando este número.
          </p>
        </div>
      </div>
      <Link
        to="/my-orders"
        className="inline-flex items-center gap-2 bg-green-600 text-white px-5 py-2.5 rounded-xl font-bold hover:bg-green-700 transition-colors"
      >
        Ver Meus Pedidos <ArrowRight size={16} />
      </Link>
    </div>
  );

  const pixCheckout = pix && (
    <PixCheckout
      copyPaste={pix.copyPaste}
      amount={pix.amount}
      expiresAt={pix.expiresAt}
      simulation={pix.simulation}
      cancelling={cancellingPix}
      onCancel={handleCancelPix}
    />
  );

  const modals = (
    <>
      <AddressModal isOpen={isAddressModalOpen} onClose={() => setIsAddressModalOpen(false)} onSuccess={handleAddressSaved} />
      <ConfirmModal
        isOpen={isLoginModalOpen}
        onClose={() => setIsLoginModalOpen(false)}
        onConfirm={() => navigate('/signin')}
        title="Faça login"
        message="Para finalizar seu pedido, entre na sua conta (ou crie uma em poucos segundos)."
        confirmLabel="Entrar"
      />
      <ConfirmModal
        isOpen={totalChange !== null}
        onClose={() => answerTotalChange(false)}
        onConfirm={() => answerTotalChange(true)}
        title="O total do pedido mudou"
        message={
          totalChange
            ? `O total passou de ${formatBRL(totalChange.from)} para ${formatBRL(totalChange.to)} (preços ou taxa de entrega atualizados). Deseja continuar com o novo total?`
            : ''
        }
        confirmLabel="Continuar"
      />
    </>
  );

  if (cartItems.length === 0) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        {approvedBox}
        {pixCheckout ? (
          <div className="bg-white dark:bg-slate-900 p-5 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800">
            {pixCheckout}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-20 text-center space-y-4 animate-in fade-in">
            <div className="bg-gray-100 dark:bg-slate-800 p-6 rounded-full text-gray-400 dark:text-gray-500"><Store size={48} /></div>
            <h2 className="text-xl font-bold text-gray-800 dark:text-white">Seu carrinho está vazio</h2>
            <Link to="/" className="bg-orange-600 text-white px-6 py-2 rounded-xl font-bold hover:bg-orange-700 transition-colors">Ver Cardápio</Link>
          </div>
        )}
        {modals}
      </div>
    );
  }

  const quoteLines = quoteData && quoteData.items.length === cartItems.length ? quoteData.items : null;
  const subtotal = quoteData ? quoteData.subtotal : cartTotal;
  const estimatedTime = quoteData && deliveryReady ? quoteData.estimated_delivery_time : orderType === 'DELIVERY' ? '--' : '15-20 min';
  const closingMessage = storeStatus?.closing_message?.trim() || 'No momento não estamos aceitando pedidos. Volte mais tarde!';
  const showBottomBar = paymentType === 'OFFLINE' || (paymentType === 'ONLINE' && onlineMethod === 'PIX' && !pix);

  let deliveryFeeLabel: string;
  if (orderType === 'TAKEOUT') deliveryFeeLabel = 'Grátis (retirada)';
  else if (!deliveryReady) deliveryFeeLabel = 'Selecione o endereço';
  else if (quoteData) deliveryFeeLabel = quoteData.delivery_fee > 0 ? formatBRL(quoteData.delivery_fee) : 'Grátis';
  else deliveryFeeLabel = '--';

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-40">

      {isStaff && (
        <div className="bg-red-100 dark:bg-red-900/30 border-l-4 border-red-500 text-red-700 dark:text-red-400 p-4 rounded shadow-sm flex items-start gap-3">
          <ShieldAlert size={24} className="shrink-0" />
          <div>
            <p className="font-bold">Modo Administrativo</p>
            <p className="text-sm">Você está logado como membro da equipe. A realização de pedidos está bloqueada.</p>
          </div>
        </div>
      )}

      {!storeOpen && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border-l-4 border-amber-500 text-amber-800 dark:text-amber-300 p-4 rounded shadow-sm flex items-start gap-3">
          <Lock size={22} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-bold">Loja fechada</p>
            <p className="text-sm">{closingMessage}</p>
          </div>
        </div>
      )}

      {approvedBox}

      <h1 className="text-2xl font-bold text-gray-800 dark:text-white">Carrinho</h1>

      <div className="space-y-4">
        {cartItems.map((item, index) => {
          const addonsSum = item.addons.reduce((sum, addon) => sum + Number(addon.price), 0);
          // Sem orçamento (visitante ou carregando): preço cobrado, com a promoção quando houver
          const localLineTotal = (effectivePrice(item) + addonsSum) * item.quantity;
          const lineTotal = quoteLines?.[index]?.lineTotal ?? localLineTotal;
          const groupedAddonsList = groupAddons(item.addons);
          const imageUrl = assetUrl(item.image);

          return (
            <div key={item.cartId} className="bg-white dark:bg-slate-900 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 flex gap-4 transition-colors">
              <div className="w-20 h-20 bg-gray-100 dark:bg-slate-800 rounded-xl overflow-hidden shrink-0">
                {imageUrl && <img src={imageUrl} alt={item.name} className="w-full h-full object-cover" />}
              </div>
              <div className="flex-1 flex flex-col justify-between">
                <div>
                  <div className="flex justify-between items-start">
                    <h3 className="font-bold text-gray-800 dark:text-white">{item.name}</h3>
                    <button
                      type="button"
                      onClick={() => removeFromCart(item.cartId)}
                      disabled={locked}
                      aria-label={`Remover ${item.name}`}
                      className="text-gray-400 hover:text-red-500 transition-colors disabled:opacity-40"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 space-y-0.5">
                    {item.meatPoint && <p className="text-orange-600 dark:text-orange-400 font-medium">🔥 {item.meatPoint}</p>}
                    {groupedAddonsList.length > 0 && (
                      <p className="text-green-600 dark:text-green-400 font-medium">
                        ✨ + {groupedAddonsList.map(([name, qtd]) => `${qtd}x ${name}`).join(', ')}
                      </p>
                    )}
                    {item.removedIngredients?.length > 0 && (
                      <p className="text-red-500 dark:text-red-400">Sem: {item.removedIngredients.join(', ')}</p>
                    )}
                    {item.observation && <p className="italic">Obs: {item.observation}</p>}
                  </div>
                </div>
                <div className="flex justify-between items-center mt-3">
                  <span className="font-bold text-gray-800 dark:text-white">{formatBRL(lineTotal)}</span>
                  <div className="flex items-center gap-3 bg-gray-50 dark:bg-slate-800 rounded-lg p-1 border border-gray-200 dark:border-slate-700">
                    <button
                      type="button"
                      onClick={() => updateQuantity(item.cartId, -1)}
                      disabled={locked || item.quantity <= 1}
                      aria-label="Diminuir quantidade"
                      className="p-1 hover:bg-white dark:hover:bg-slate-700 rounded shadow-sm text-gray-600 dark:text-gray-300 disabled:opacity-40"
                    >
                      <Minus size={14} />
                    </button>
                    <span className="text-sm font-bold w-5 text-center dark:text-white">{item.quantity}</span>
                    <button
                      type="button"
                      onClick={() => updateQuantity(item.cartId, 1)}
                      disabled={locked || item.quantity >= MAX_ITEM_QUANTITY}
                      aria-label="Aumentar quantidade"
                      className="p-1 hover:bg-white dark:hover:bg-slate-700 rounded shadow-sm text-green-600 dark:text-green-400 disabled:opacity-40"
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="bg-white dark:bg-slate-900 p-5 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 space-y-4 transition-colors">
        <div className="flex justify-between items-center">
          <h3 className="font-bold text-gray-800 dark:text-white flex items-center gap-2">
            {orderType === 'DELIVERY' ? <MapPin size={18} className="text-orange-600" /> : <Store size={18} className="text-orange-600" />}
            {orderType === 'DELIVERY' ? 'Entrega' : 'Retirada na Loja'}
          </h3>
          <span className="text-xs font-bold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 px-2 py-1 rounded-lg flex items-center gap-1">
            <Clock size={14} /> {estimatedTime}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <button type="button" onClick={() => setOrderType('TAKEOUT')} disabled={locked} className={`p-3 rounded-xl border-2 text-sm font-bold transition-all disabled:opacity-60 ${orderType === 'TAKEOUT' ? 'border-orange-500 bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400' : 'border-gray-100 dark:border-slate-700 text-gray-500 dark:text-gray-400'}`}>Retirada</button>
          <button type="button" onClick={() => setOrderType('DELIVERY')} disabled={locked} className={`p-3 rounded-xl border-2 text-sm font-bold transition-all disabled:opacity-60 ${orderType === 'DELIVERY' ? 'border-orange-500 bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400' : 'border-gray-100 dark:border-slate-700 text-gray-500 dark:text-gray-400'}`}>Delivery</button>
        </div>

        <div className="mt-4">
          {orderType === 'TAKEOUT' ? (
            <div className="bg-orange-50 dark:bg-slate-800 border border-orange-100 dark:border-slate-700 rounded-xl p-4 flex items-start gap-3">
              <div className="bg-white dark:bg-slate-700 p-2 rounded-full text-orange-600 shadow-sm"><Store size={20} /></div>
              <div>
                <p className="text-sm font-bold text-gray-800 dark:text-white">{BRAND.name}</p>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                  {STORE_ADDRESS.street}, {STORE_ADDRESS.number} - {STORE_ADDRESS.complement} · {STORE_ADDRESS.neighborhood}, {STORE_ADDRESS.city}/{STORE_ADDRESS.state}
                </p>
                <a href={STORE_MAP_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-bold text-orange-600 dark:text-orange-400 mt-2 hover:underline">
                  <Navigation size={12} /> Ver no Mapa
                </a>
              </div>
            </div>
          ) : addresses.length > 0 ? (
            <div className="space-y-3">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Selecione o Endereço:</p>
              {addresses.map((addr) => (
                <label key={addr.id} className={`flex items-start gap-3 p-3 rounded-xl border-2 cursor-pointer transition-all ${selectedAddressId === addr.id ? 'border-orange-500 bg-orange-50 dark:bg-orange-900/10' : 'border-gray-100 dark:border-slate-700 hover:border-gray-200 dark:hover:border-slate-600'} ${locked ? 'opacity-60 pointer-events-none' : ''}`}>
                  <input type="radio" name="address" checked={selectedAddressId === addr.id} onChange={() => setSelectedAddressId(addr.id)} disabled={locked} className="mt-1 text-orange-600 focus:ring-orange-500" />
                  <div className="text-sm flex-1">
                    <p className="font-bold text-gray-800 dark:text-white">{addr.nickname ? `${addr.nickname} - ` : ''}{addr.street}, {addr.number}</p>
                    <p className="text-gray-500 dark:text-gray-400">{addr.neighborhood} - {addr.city}</p>
                  </div>
                </label>
              ))}
              <button type="button" onClick={openAddressModal} disabled={locked} className="w-full py-2 text-sm text-orange-600 dark:text-orange-400 font-bold hover:bg-orange-50 dark:hover:bg-slate-800 rounded-lg border border-dashed border-orange-300 dark:border-slate-600 disabled:opacity-60">+ Novo Endereço</button>
            </div>
          ) : (
            <div className="text-center p-4 bg-gray-50 dark:bg-slate-800 rounded-xl border border-dashed border-gray-300 dark:border-slate-700 space-y-2">
              {!isAuthenticated && <p className="text-sm text-gray-500 dark:text-gray-400">Entre na sua conta para cadastrar o endereço de entrega.</p>}
              <button type="button" onClick={openAddressModal} disabled={locked || isStaff} className="bg-gray-800 dark:bg-slate-700 text-white px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 mx-auto hover:bg-gray-900 transition-colors disabled:opacity-60"><Plus size={16} /> Cadastrar Endereço</button>
            </div>
          )}
        </div>
      </div>

      <div className="bg-white dark:bg-slate-900 p-5 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 space-y-3 transition-colors">
        <h3 className="font-bold text-gray-800 dark:text-white flex items-center gap-2">
          Resumo {quoteLoading && <Loader2 size={16} className="animate-spin text-gray-400" aria-label="Calculando" />}
        </h3>
        <div className="flex justify-between text-sm text-gray-600 dark:text-gray-400">
          <span>{quoteData ? 'Subtotal' : 'Subtotal (estimado)'}</span>
          <span>{formatBRL(subtotal)}</span>
        </div>
        <div className="flex justify-between text-sm text-gray-600 dark:text-gray-400">
          <span>Taxa de entrega</span>
          <span>{deliveryFeeLabel}</span>
        </div>
        <div className="flex justify-between font-bold text-gray-800 dark:text-white pt-3 border-t border-gray-100 dark:border-slate-800">
          <span>Total</span>
          <span>{payableTotal !== null ? formatBRL(payableTotal) : '--'}</span>
        </div>
        {!isAuthenticated && (
          <p className="text-xs text-gray-500 dark:text-gray-400">Entre na sua conta para calcular a entrega e finalizar o pedido.</p>
        )}
        {currentQuoteError && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-red-600 dark:text-red-400 flex items-start gap-2"><AlertCircle size={16} className="shrink-0 mt-0.5" /> {currentQuoteError}</p>
            <button
              type="button"
              onClick={retryQuote}
              className="text-sm font-bold text-orange-600 dark:text-orange-400 flex items-center gap-1 hover:underline"
            >
              <RotateCw size={14} /> Tentar novamente
            </button>
          </div>
        )}
      </div>

      {approvedPaymentId === null && (
        <div className="bg-white dark:bg-slate-900 p-5 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 space-y-4 transition-colors">
          <h3 className="font-bold text-gray-800 dark:text-white">Pagamento</h3>

          <div className={`flex p-1 bg-gray-100 dark:bg-slate-800 rounded-xl mb-4 ${toggleDisabled ? 'opacity-50 pointer-events-none' : ''}`}>
            <button type="button" onClick={() => setPaymentType('ONLINE')} disabled={toggleDisabled} className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${paymentType === 'ONLINE' ? 'bg-white dark:bg-slate-700 shadow-sm text-orange-600 dark:text-orange-400' : 'text-gray-500 dark:text-gray-400'}`}>Pagar Agora (Online)</button>
            <button type="button" onClick={() => setPaymentType('OFFLINE')} disabled={toggleDisabled} className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${paymentType === 'OFFLINE' ? 'bg-white dark:bg-slate-700 shadow-sm text-orange-600 dark:text-orange-400' : 'text-gray-500 dark:text-gray-400'}`}>{orderType === 'TAKEOUT' ? 'Pagar na Retirada' : 'Pagar na Entrega'}</button>
          </div>

          {paymentType === 'ONLINE' ? (
            <div className="animate-in fade-in space-y-6">
              <div className="flex gap-4 border-b border-gray-100 dark:border-slate-800 pb-2">
                <button
                  type="button"
                  onClick={() => setOnlineMethod('CREDIT_CARD')}
                  disabled={toggleDisabled}
                  className={`pb-2 text-sm font-bold transition-all border-b-2 ${onlineMethod === 'CREDIT_CARD' ? 'border-orange-500 text-orange-600 dark:text-orange-400' : 'border-transparent text-gray-400 dark:text-gray-500'}`}
                >
                  Cartão de Crédito
                </button>
                <button
                  type="button"
                  onClick={() => setOnlineMethod('PIX')}
                  disabled={toggleDisabled}
                  className={`pb-2 text-sm font-bold transition-all border-b-2 ${onlineMethod === 'PIX' ? 'border-orange-500 text-orange-600 dark:text-orange-400' : 'border-transparent text-gray-400 dark:text-gray-500'}`}
                >
                  PIX
                </button>
              </div>

              {onlineMethod === 'CREDIT_CARD' ? (
                <PaymentForm
                  total={payableTotal}
                  payload={orderPayload}
                  blockedReason={isStaff ? 'Contas da equipe não fazem pedidos pela loja.' : blockedReason}
                  busy={submitting}
                  onBeforePay={ensureCanCheckout}
                  onConfirmTotal={confirmCurrentTotal}
                  onProcessingChange={setCardProcessing}
                  onOrderCreated={finishSuccess}
                  onApprovedPending={markApprovedPending}
                />
              ) : pixCheckout ? (
                pixCheckout
              ) : (
                <div className="text-center py-6">
                  <p className="text-gray-500 dark:text-gray-400 mb-4">Gere um código PIX para pagar com segurança. O pedido é registrado assim que o pagamento for confirmado.</p>
                  <button
                    type="button"
                    onClick={handleStartPix}
                    disabled={pixLoading || isStaff || (!!blockedReason && isAuthenticated)}
                    className="bg-green-600 text-white font-bold px-6 py-3 rounded-xl hover:bg-green-700 transition-all flex items-center gap-2 mx-auto disabled:opacity-50"
                  >
                    {pixLoading ? <><Loader2 size={18} className="animate-spin" /> Gerando...</> : payableTotal !== null ? `Gerar PIX de ${formatBRL(payableTotal)}` : 'Gerar QR Code PIX'}
                  </button>
                  {blockedReason && isAuthenticated && <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">{blockedReason}</p>}
                </div>
              )}
            </div>
          ) : (
            <div className="animate-in fade-in space-y-4">
              <div>
                <label htmlFor="offline-method" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Forma de Pagamento</label>
                <select
                  id="offline-method"
                  value={offlineMethod}
                  onChange={(event) => setOfflineMethod(event.target.value as OfflineMethod)}
                  disabled={toggleDisabled}
                  className="w-full p-3 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl outline-none focus:border-orange-500 dark:text-white disabled:opacity-50"
                >
                  {OFFLINE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>

              {offlineMethod === 'MONEY' && (
                <div className="bg-orange-50 dark:bg-slate-800 p-4 rounded-xl border border-orange-100 dark:border-slate-700 animate-in slide-in-from-top-2">
                  <label htmlFor="change-for" className="text-sm font-bold text-gray-700 dark:text-white mb-2 flex items-center gap-2">
                    <Banknote size={18} className="text-green-600 dark:text-green-400" />
                    Troco para quanto?
                  </label>
                  <input
                    id="change-for"
                    type="text"
                    inputMode="numeric"
                    value={changeFor}
                    onChange={(event) => setChangeFor(maskMoney(event.target.value))}
                    disabled={toggleDisabled}
                    placeholder="R$ 0,00"
                    className="w-full p-3 bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-600 rounded-lg font-bold text-lg text-gray-800 dark:text-white focus:ring-2 focus:ring-orange-500 outline-none"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                    {payableTotal !== null ? <>O total do pedido é <b>{formatBRL(payableTotal)}</b>. </> : null}
                    Deixe em branco se não precisar de troco.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {showBottomBar && (
        <div className="fixed bottom-0 left-0 right-0 bg-white dark:bg-slate-900 border-t border-gray-100 dark:border-slate-800 p-4 lg:p-6 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] dark:shadow-none z-40 transition-colors">
          <div className="max-w-2xl mx-auto space-y-3">
            {errorMsg && <div role="alert" className="bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 p-3 rounded-lg text-sm flex items-center gap-2"><AlertCircle size={18} className="shrink-0" />{errorMsg}</div>}

            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400 font-medium uppercase">Total a pagar</p>
                <p className="text-2xl font-bold text-gray-800 dark:text-white">{payableTotal !== null ? formatBRL(payableTotal) : '--'}</p>
              </div>

              {paymentType === 'OFFLINE' && (
                <button
                  type="button"
                  onClick={handleFinishOffline}
                  disabled={submitting || isStaff || (!!blockedReason && isAuthenticated)}
                  className={`px-8 py-3 rounded-xl font-bold transition-colors flex items-center gap-2 ${isStaff ? 'bg-gray-300 dark:bg-slate-700 text-gray-500 dark:text-gray-400 cursor-not-allowed' : 'bg-green-600 text-white hover:bg-green-700 disabled:opacity-50'}`}
                >
                  {isStaff ? 'Bloqueado (Staff)' : submitting ? <><Loader2 size={18} className="animate-spin" /> Enviando...</> : <>Finalizar Pedido <ArrowRight size={20} /></>}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {!showBottomBar && errorMsg && (
        <div role="alert" className="bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 p-3 rounded-lg text-sm flex items-center gap-2">
          <AlertCircle size={18} className="shrink-0" />{errorMsg}
        </div>
      )}

      {modals}
    </div>
  );
}
