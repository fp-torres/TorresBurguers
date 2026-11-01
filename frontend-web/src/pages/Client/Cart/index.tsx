import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, Link, useLocation } from 'react-router-dom';
import axios from 'axios';
import {
  Trash2, ArrowRight, MapPin, Store, Plus, Minus, AlertCircle, Clock, Navigation,
  ShieldAlert, Banknote, Loader2, Lock, CheckCircle2, RotateCw, Ban, Info, Utensils,
} from 'lucide-react';
import toast from 'react-hot-toast';

import { useCart, type CartAddon } from '../../../contexts/CartContext';
import { useAuth } from '../../../contexts/AuthContext';
import { useStorefront } from '../../../contexts/StorefrontContext';
import api, { assetUrl } from '../../../services/api';
import { cepNeighborhoodNote, type CustomerAddress } from '../../../services/addressService';
import { resolveMercadoPagoPublicKey } from '../../../services/mercadoPago';
import { formatStorePhone, storeAddressLines, storeMapUrl } from '../../../services/storefrontDisplay';
import AddressModal from '../../../components/AddressModal';
import ConfirmModal from '../../../components/ConfirmModal';
import { maskMoney, currencyToNumber } from '../../../utils/masks';
import { effectivePrice } from '../../../utils/catalog';
import { storePath } from '../../../utils/lastStore';
import { isPlatformAdmin } from '../../../utils/roles';

import PaymentForm from './components/PaymentForm';
import PixCheckout from './components/PixCheckout';
import {
  MAX_ITEM_QUANTITY, PIX_WATCH_GRACE_MS, DELIVERY_OUT_OF_AREA_CODE, adoptLegacyActivePix, apiErrorCode, attemptKey, buildOrderItems, cancelPayment, clearLegacyPendingPayment, errorMessage, isUncertainFailure, pixExpiresAt, pollPaymentStatus, readActivePix, saveActivePix, storeCheckoutApi, type ActivePix, type OfflineMethod, type OnlineMethod, type OrderPayload, type OrderType, type PaymentAttempt, type PixPaymentResponse, type Quote,
} from './checkout';
import { formatCurrency } from '../../../utils/format';

const OFFLINE_OPTIONS: { value: OfflineMethod; label: string }[] = [
  { value: 'MONEY', label: 'Dinheiro' },
  { value: 'CREDIT_CARD', label: 'Cartão de crédito (maquininha)' },
  { value: 'DEBIT_CARD', label: 'Cartão de débito (maquininha)' },
];

/** Nova tentativa automática do orçamento depois de uma falha passageira (rede ou 5xx). */
const QUOTE_RETRY_MS = 3000;
/** Motivo do bloqueio das contas internas no carrinho (a API também recusa o pedido dessas contas). */
const STAFF_ACCOUNT_BLOCKED_MESSAGE = 'Contas da equipe não fazem pedidos pela loja.';
const PLATFORM_ACCOUNT_BLOCKED_MESSAGE = 'Contas da administração da plataforma não fazem pedidos. Use uma conta de cliente.';
/** Troco: o valor pago pode passar do total em até R$ 200,00 (mesmo teto da API). */
const MAX_CHANGE_ABOVE_TOTAL = 200;

/** Endereço do cliente (GET /addresses), com o bairro do CEP usado na taxa de entrega. */
type AddressData = CustomerAddress;

function groupAddons(addons: CartAddon[]) {
  const groups: Record<string, number> = {};
  addons.forEach((addon) => { groups[addon.name] = (groups[addon.name] || 0) + 1; });
  return Object.entries(groups);
}

const TOGGLE_ACTIVE = 'border-brand bg-brand/10 text-brand-ink dark:text-brand-ink-dark';
const TOGGLE_IDLE = 'border-gray-100 dark:border-slate-700 text-gray-500 dark:text-gray-400 hover:border-gray-200 dark:hover:border-slate-600';

/**
 * Carrinho e checkout da loja da rota (/loja/:slug/cart). Todas as chamadas da compra vão para
 * /stores/:slug/... (orçamento, pedido, PIX e cartão): o slug vem da rota e a API confere a loja.
 * Entrega/retirada, pagamento online e chave pública do Mercado Pago seguem o perfil da loja.
 */
export default function ClientCart() {
  const { cartItems, removeFromCart, updateQuantity, clearCart, cartTotal } = useCart();
  const { isAuthenticated, user } = useAuth();
  const { slug, store, status, orderingAvailable, unavailableMessage, refreshStatus, refreshStore } = useStorefront();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const checkoutApi = useMemo(() => storeCheckoutApi(slug), [slug]);
  // Contas internas (equipe da loja e administração da plataforma) não compram pela loja (a API também
  // recusa): o carrinho fica bloqueado, sem cotação, sem formulário de cartão e sem o SDK do Mercado Pago
  const isPlatformAccount = isPlatformAdmin(user);
  const isClient = user?.role === 'CLIENT' && !isPlatformAccount;
  const isStaff = !!user && !isClient;
  const clientId = isClient ? user.id : null;
  const storeId = store.id;

  // O que esta loja aceita pelo site
  const deliveryEnabled = store.delivery_enabled;
  const takeoutEnabled = store.takeout_enabled;
  const noFulfillment = !deliveryEnabled && !takeoutEnabled;
  const onlineEnabled = store.payments.online_enabled;
  // Chave pública da LOJA (em desenvolvimento, sem chave da loja, a de teste): sem ela, só PIX
  const publicKey = resolveMercadoPagoPublicKey(store.payments.mp_public_key);
  const cardEnabled = onlineEnabled && publicKey !== null && !isStaff;

  // PIX gerado antes de recarregar a página ou de sair do carrinho (desta loja): continua de onde parou
  const [resumedPix] = useState<ActivePix | null>(() => (clientId !== null ? readActivePix(storeId, clientId) : null));

  const [orderTypeChoice, setOrderType] = useState<OrderType>(takeoutEnabled ? 'TAKEOUT' : 'DELIVERY');
  const [paymentTypeChoice, setPaymentType] = useState<'ONLINE' | 'OFFLINE'>(resumedPix || onlineEnabled ? 'ONLINE' : 'OFFLINE');
  // Online e na entrega têm estados separados: trocar de aba nunca leva a forma errada para o pedido
  const [onlineMethodChoice, setOnlineMethod] = useState<OnlineMethod>(resumedPix || !cardEnabled ? 'PIX' : 'CREDIT_CARD');
  const [offlineMethod, setOfflineMethod] = useState<OfflineMethod>('MONEY');
  const [changeFor, setChangeFor] = useState('');

  const [addresses, setAddresses] = useState<AddressData[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState<number | null>(null);
  const [isAddressModalOpen, setIsAddressModalOpen] = useState(false);
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const [isCancelPixModalOpen, setIsCancelPixModalOpen] = useState(false);

  const [quote, setQuote] = useState<{ key: string; data: Quote } | null>(null);
  // code: o "code" do erro da API (ex.: DELIVERY_OUT_OF_AREA, endereço fora da área da loja)
  const [quoteError, setQuoteError] = useState<{ key: string; message: string; code: string | null } | null>(null);
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

  // A loja pode mudar as opções enquanto a página está aberta (perfil atualizado): vale o que ela aceita agora
  const orderType: OrderType = orderTypeChoice === 'DELIVERY' && !deliveryEnabled && takeoutEnabled
    ? 'TAKEOUT'
    : orderTypeChoice === 'TAKEOUT' && !takeoutEnabled && deliveryEnabled ? 'DELIVERY' : orderTypeChoice;
  const paymentType = onlineEnabled || pix ? paymentTypeChoice : 'OFFLINE';
  const onlineMethod: OnlineMethod = onlineMethodChoice === 'CREDIT_CARD' && !cardEnabled ? 'PIX' : onlineMethodChoice;

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
  const canQuote = isAuthenticated && isClient && items.length > 0 && orderingAvailable && !noFulfillment;
  // Status da loja (atualizado a cada 30 s e ao voltar para a aba)
  const storeIsOpen = status ? status.is_open : null;

  // Novo orçamento quando o pedido muda, quando a loja abre/fecha ou em "Tentar novamente"
  useEffect(() => {
    if (!canQuote) return;
    const controller = new AbortController();
    // Espera o cliente parar de clicar (+/-) antes de pedir um novo orçamento
    const timer = window.setTimeout(async () => {
      try {
        const data = await checkoutApi.quote(JSON.parse(quoteKey) as OrderPayload, { signal: controller.signal });
        setQuote({ key: quoteKey, data });
        setQuoteError(null);
      } catch (error) {
        if (controller.signal.aborted || axios.isCancel(error)) return;
        setQuoteError({ key: quoteKey, message: errorMessage(error, 'Não foi possível calcular o total do pedido.'), code: apiErrorCode(error) });
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
  }, [canQuote, quoteKey, storeIsOpen, quoteNonce, checkoutApi]);

  const quoteData = canQuote && quote?.key === quoteKey ? quote.data : null;
  const currentQuoteError = canQuote && quoteError?.key === quoteKey ? quoteError.message : null;
  // A loja recusa o endereço escolhido (fora das zonas de entrega): aviso junto do endereço, sem "Tentar novamente"
  const outOfArea = orderType === 'DELIVERY' && canQuote && quoteError?.key === quoteKey && quoteError.code === DELIVERY_OUT_OF_AREA_CODE;
  const quoteLoading = canQuote && !quoteData && !currentQuoteError;
  const payableTotal = quoteData && deliveryReady ? quoteData.total : null;
  const orderPayload = deliveryReady ? quoteBody : null;

  // Loja: status compartilhado + o informado no último orçamento (o mais restritivo vale até o novo orçamento)
  const storeOpen = storeIsOpen !== false && (quoteData ? quoteData.store_open : true);

  // Ao abrir o carrinho, confere o status e o perfil da loja na hora (pagamentos, entrega, disponibilidade)
  useEffect(() => {
    void refreshStatus();
    void refreshStore();
  }, [refreshStatus, refreshStore]);

  // O aviso antigo de "pagamento aprovado sem pedido" não existe mais (o servidor cria o pedido)
  useEffect(() => {
    clearLegacyPendingPayment();
  }, []);

  // --- Endereços (do cliente: valem em qualquer loja) ---
  const loadAddresses = useCallback(async (): Promise<AddressData[]> => {
    try {
      const { data } = await api.get<AddressData[]>('/addresses');
      const list = Array.isArray(data) ? data : [];
      setAddresses(list);
      return list;
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
    if (deliveryEnabled) setOrderType('DELIVERY');
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
    if (isStaff) return isPlatformAccount ? PLATFORM_ACCOUNT_BLOCKED_MESSAGE : STAFF_ACCOUNT_BLOCKED_MESSAGE;
    if (!orderingAvailable) return unavailableMessage;
    if (noFulfillment) return 'Esta loja não está aceitando pedidos para entrega nem para retirada pelo site.';
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
      const data = await checkoutApi.quote(orderPayload);
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
      const message = errorMessage(error, 'Não foi possível conferir o total do pedido. Tente novamente.');
      // A loja passou a recusar este endereço: o aviso fica junto do endereço até o cliente trocar
      if (apiErrorCode(error) === DELIVERY_OUT_OF_AREA_CODE) setQuoteError({ key: quoteKey, message, code: DELIVERY_OUT_OF_AREA_CODE });
      showError(message);
      return null;
    }
  }

  /**
   * orderNumber: número do pedido NA LOJA, quando a resposta já o trouxe (pago na entrega). Nos pagamentos
   * online a API devolve só o id do pedido: a confirmação busca o número.
   */
  function finishSuccess(orderId?: number, orderNumber?: number | null) {
    if (clientId !== null) saveActivePix(storeId, clientId, null);
    clearCart();
    toast.success(orderNumber ? `Pedido #${orderNumber} realizado com sucesso!` : 'Pedido realizado com sucesso!');
    navigate(storePath(slug, 'order-success'), { replace: true, state: { orderId, orderNumber: orderNumber ?? undefined } });
  }

  /** Pago, mas o pedido ainda não apareceu: o servidor registra com o que foi pago (não cobrar de novo). */
  function markApprovedPending(paymentId: number) {
    if (clientId !== null) saveActivePix(storeId, clientId, null);
    clearCart();
    setApprovedPaymentId(paymentId);
    toast.success('Pagamento aprovado!');
  }

  // --- Pagar na entrega / retirada ---
  function changeForError(total: number): string | null {
    if (offlineMethod !== 'MONEY' || !changeFor) return null;
    const value = currencyToNumber(changeFor);
    if (value > 0 && value < total) return `O troco deve ser para um valor maior ou igual ao total (${formatCurrency(total)}).`;
    // Mesma regra da API: no máximo R$ 200,00 (a maior cédula) acima do total
    const maxChange = Math.round((total + MAX_CHANGE_ABOVE_TOTAL) * 100) / 100;
    if (value > maxChange) return `O troco pode ser para no máximo ${formatCurrency(maxChange)} (até ${formatCurrency(MAX_CHANGE_ABOVE_TOTAL)} acima do total).`;
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

      const data = await checkoutApi.createOrder({ ...orderPayload, paymentMethod: offlineMethod, ...(change ? { changeFor: change } : {}) });
      finishSuccess(data?.id, data?.number);
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

    if (clientId !== null) saveActivePix(storeId, clientId, null);
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

  // PIX gerado pela versão de loja única nesta aba: retomado só na loja padrão (a dona dele)
  useEffect(() => {
    if (clientId === null || resumedPix) return;
    let active = true;
    adoptLegacyActivePix(storeId, clientId)
      .then((legacy) => {
        if (!active || !legacy || pixControllerRef.current) return;
        setPix(legacy);
        setPaymentType('ONLINE');
        setOnlineMethod('PIX');
        void watchPixRef.current(legacy);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [clientId, resumedPix, storeId]);

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
        data = await checkoutApi.createPix({ order: payload, idempotencyKey: attempt.key });
      } catch (error) {
        if (!isUncertainFailure(error)) pixAttemptRef.current = null;
        throw error;
      }
      pixAttemptRef.current = null;

      session = {
        id: data.id,
        storeId,
        copyPaste: data.qr_code,
        amount: data.amount,
        simulation: !!data.simulation,
        expiresAt: pixExpiresAt(data),
      };
      saveActivePix(storeId, clientId, session);
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
      if (clientId !== null) saveActivePix(storeId, clientId, null);
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
  const takeoutAddress = storeAddressLines(store.address);
  const takeoutMapUrl = storeMapUrl(store.address);
  const storePhone = formatStorePhone(store.phone);

  const approvedBox = approvedPaymentId !== null && (
    <div role="status" className="bg-green-50 dark:bg-green-900/20 border border-green-300 dark:border-green-700 rounded-2xl p-5 space-y-3">
      <div className="flex items-start gap-3">
        <CheckCircle2 size={22} className="text-green-600 dark:text-green-400 shrink-0 mt-0.5" aria-hidden="true" />
        <div className="text-sm text-gray-700 dark:text-gray-200 space-y-1">
          <p className="font-bold text-gray-900 dark:text-white">Pagamento aprovado! Estamos registrando seu pedido</p>
          <p>
            Pagamento nº <b>{approvedPaymentId}</b>. O pedido aparece em Meus Pedidos em instantes — não pague de novo.
            Se ele não aparecer em alguns minutos, fale com {store.name}{storePhone ? ` (${storePhone})` : ''} informando este número.
          </p>
        </div>
      </div>
      <Link
        to="/my-orders"
        className="inline-flex items-center gap-2 bg-green-600 text-white px-5 py-2.5 rounded-xl font-bold hover:bg-green-700 transition-colors"
      >
        Ver Meus Pedidos <ArrowRight size={16} aria-hidden="true" />
      </Link>
    </div>
  );

  const pixCheckout = pix && (
    <PixCheckout
      copyPaste={pix.copyPaste}
      amount={pix.amount}
      expiresAt={pix.expiresAt}
      storeName={store.name}
      simulation={pix.simulation}
      cancelling={cancellingPix}
      onCancel={() => setIsCancelPixModalOpen(true)}
    />
  );

  const modals = (
    <>
      <AddressModal isOpen={isAddressModalOpen} onClose={() => setIsAddressModalOpen(false)} onSuccess={handleAddressSaved} />
      <ConfirmModal
        isOpen={isLoginModalOpen}
        onClose={() => setIsLoginModalOpen(false)}
        onConfirm={() => navigate(`/signin?redirect=${encodeURIComponent(pathname)}`)}
        title="Faça login"
        message="Para finalizar seu pedido, entre na sua conta (ou crie uma em poucos segundos). Seu carrinho continua salvo."
        confirmLabel="Entrar"
      />
      <ConfirmModal
        isOpen={totalChange !== null}
        onClose={() => answerTotalChange(false)}
        onConfirm={() => answerTotalChange(true)}
        title="O total do pedido mudou"
        message={
          totalChange
            ? `O total passou de ${formatCurrency(totalChange.from)} para ${formatCurrency(totalChange.to)} (preços ou taxa de entrega atualizados). Deseja continuar com o novo total?`
            : ''
        }
        confirmLabel="Continuar"
      />
      <ConfirmModal
        isOpen={isCancelPixModalOpen}
        onClose={() => setIsCancelPixModalOpen(false)}
        onConfirm={() => void handleCancelPix()}
        title="Cancelar o PIX?"
        message="O código deixa de valer e nenhum pedido é criado. Se você já pagou, não cancele: o pedido aparece em Meus Pedidos assim que o pagamento for confirmado."
        confirmLabel="Cancelar PIX"
        isDestructive
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
            <div className="bg-gray-100 dark:bg-slate-800 p-6 rounded-full text-gray-400 dark:text-gray-500" aria-hidden="true"><Store size={48} /></div>
            <h1 className="text-xl font-bold text-gray-800 dark:text-white">Seu carrinho está vazio</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">Escolha seus itens no cardápio de {store.name}.</p>
            <Link to={storePath(slug)} className="bg-brand hover:bg-brand-hover text-brand-contrast px-6 py-2.5 rounded-xl font-bold transition-colors">Ver Cardápio</Link>
          </div>
        )}
        {modals}
      </div>
    );
  }

  const quoteLines = quoteData && quoteData.items.length === cartItems.length ? quoteData.items : null;
  const subtotal = quoteData ? quoteData.subtotal : cartTotal;
  const estimatedTime = quoteData && deliveryReady
    ? quoteData.estimated_delivery_time
    : orderType === 'TAKEOUT' ? store.takeout_estimate ?? '--' : '--';
  const closingMessage = status?.closing_message?.trim() || 'No momento não estamos aceitando pedidos. Volte mais tarde!';
  const showBottomBar = paymentType === 'OFFLINE' || (paymentType === 'ONLINE' && onlineMethod === 'PIX' && !pix);
  const offlineLabel = orderType === 'TAKEOUT' ? 'Pagar na Retirada' : 'Pagar na Entrega';

  let deliveryFeeLabel: string;
  if (orderType === 'TAKEOUT') deliveryFeeLabel = 'Grátis (retirada)';
  else if (!deliveryReady) deliveryFeeLabel = 'Selecione o endereço';
  else if (outOfArea) deliveryFeeLabel = 'Fora da área';
  else if (quoteData) deliveryFeeLabel = quoteData.delivery_fee > 0 ? formatCurrency(quoteData.delivery_fee) : 'Grátis';
  else deliveryFeeLabel = '--';

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-40">

      {isStaff && (
        <div className="bg-red-100 dark:bg-red-900/30 border-l-4 border-red-500 text-red-700 dark:text-red-400 p-4 rounded shadow-sm flex items-start gap-3">
          <ShieldAlert size={24} className="shrink-0" aria-hidden="true" />
          <div>
            <p className="font-bold">Modo Administrativo</p>
            <p className="text-sm">
              {isPlatformAccount
                ? 'Você está logado com uma conta da administração da plataforma. A realização de pedidos está bloqueada.'
                : 'Você está logado como membro da equipe. A realização de pedidos está bloqueada.'}
            </p>
          </div>
        </div>
      )}

      {!orderingAvailable ? (
        <div role="status" className="bg-amber-50 dark:bg-amber-900/20 border-l-4 border-amber-500 text-amber-900 dark:text-amber-200 p-4 rounded shadow-sm flex items-start gap-3">
          <Ban size={22} className="shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <p className="font-bold">Pedidos indisponíveis</p>
            <p className="text-sm">{unavailableMessage}</p>
          </div>
        </div>
      ) : !storeOpen && (
        <div role="status" className="bg-amber-50 dark:bg-amber-900/20 border-l-4 border-amber-500 text-amber-800 dark:text-amber-300 p-4 rounded shadow-sm flex items-start gap-3">
          <Lock size={22} className="shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <p className="font-bold">Loja fechada</p>
            <p className="text-sm">{closingMessage}</p>
          </div>
        </div>
      )}

      {approvedBox}

      <div>
        <h1 className="text-2xl font-bold text-gray-800 dark:text-white">Carrinho</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">Pedido em <span className="font-bold text-gray-700 dark:text-gray-200">{store.name}</span></p>
      </div>

      <div className="space-y-4">
        {cartItems.map((item, index) => {
          const addonsSum = item.addons.reduce((sum, addon) => sum + addon.price, 0);
          // Sem orçamento (visitante ou carregando): preço cobrado, com a promoção quando houver
          const localLineTotal = (effectivePrice(item) + addonsSum) * item.quantity;
          const lineTotal = quoteLines?.[index]?.lineTotal ?? localLineTotal;
          const groupedAddonsList = groupAddons(item.addons);
          const imageUrl = assetUrl(item.image);

          return (
            <div key={item.cartId} className="bg-white dark:bg-slate-900 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 flex gap-4 transition-colors">
              <div className="w-20 h-20 bg-gray-100 dark:bg-slate-800 rounded-xl overflow-hidden shrink-0">
                {imageUrl ? (
                  <img src={imageUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-gray-300 dark:text-slate-600" aria-hidden="true"><Utensils /></div>
                )}
              </div>
              <div className="flex-1 flex flex-col justify-between min-w-0">
                <div>
                  <div className="flex justify-between items-start gap-2">
                    <h3 className="font-bold text-gray-800 dark:text-white wrap-break-word">{item.name}</h3>
                    <button
                      type="button"
                      onClick={() => removeFromCart(item.cartId)}
                      disabled={locked}
                      aria-label={`Remover ${item.name}`}
                      className="text-gray-400 hover:text-red-500 transition-colors disabled:opacity-40 shrink-0"
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 space-y-0.5">
                    {item.meatPoint && <p className="text-orange-700 dark:text-orange-400 font-medium">🔥 {item.meatPoint}</p>}
                    {groupedAddonsList.length > 0 && (
                      <p className="text-green-700 dark:text-green-400 font-medium">
                        ✨ + {groupedAddonsList.map(([name, qtd]) => `${qtd}x ${name}`).join(', ')}
                      </p>
                    )}
                    {item.removedIngredients.length > 0 && (
                      <p className="text-red-600 dark:text-red-400">Sem: {item.removedIngredients.join(', ')}</p>
                    )}
                    {item.observation && <p className="italic">Obs: {item.observation}</p>}
                  </div>
                </div>
                <div className="flex justify-between items-center mt-3">
                  <span className="font-bold text-gray-800 dark:text-white">{formatCurrency(lineTotal)}</span>
                  <div className="flex items-center gap-3 bg-gray-50 dark:bg-slate-800 rounded-lg p-1 border border-gray-200 dark:border-slate-700">
                    <button
                      type="button"
                      onClick={() => updateQuantity(item.cartId, -1)}
                      disabled={locked || item.quantity <= 1}
                      aria-label="Diminuir quantidade"
                      className="p-1 hover:bg-white dark:hover:bg-slate-700 rounded shadow-sm text-gray-600 dark:text-gray-300 disabled:opacity-40"
                    >
                      <Minus size={14} aria-hidden="true" />
                    </button>
                    <span className="text-sm font-bold w-5 text-center text-gray-900 dark:text-white">{item.quantity}</span>
                    <button
                      type="button"
                      onClick={() => updateQuantity(item.cartId, 1)}
                      disabled={locked || item.quantity >= MAX_ITEM_QUANTITY}
                      aria-label="Aumentar quantidade"
                      className="p-1 hover:bg-white dark:hover:bg-slate-700 rounded shadow-sm text-green-600 dark:text-green-400 disabled:opacity-40"
                    >
                      <Plus size={14} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* --- ENTREGA OU RETIRADA (o que a loja aceita) --- */}
      <section aria-labelledby="fulfillment-title" className="bg-white dark:bg-slate-900 p-5 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 space-y-4 transition-colors">
        <div className="flex justify-between items-center gap-3">
          <h2 id="fulfillment-title" className="font-bold text-gray-800 dark:text-white flex items-center gap-2">
            {orderType === 'DELIVERY' ? <MapPin size={18} className="text-brand-ink dark:text-brand-ink-dark" aria-hidden="true" /> : <Store size={18} className="text-brand-ink dark:text-brand-ink-dark" aria-hidden="true" />}
            {noFulfillment ? 'Entrega e retirada' : orderType === 'DELIVERY' ? 'Entrega' : 'Retirada na Loja'}
          </h2>
          {!noFulfillment && (
            <span className="text-xs font-bold text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-900/20 px-2 py-1 rounded-lg flex items-center gap-1">
              <Clock size={14} aria-hidden="true" /> <span className="sr-only">Prazo estimado: </span>{estimatedTime}
            </span>
          )}
        </div>

        {noFulfillment ? (
          <p className="text-sm text-gray-600 dark:text-gray-400 flex items-start gap-2">
            <Info size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
            Esta loja não está aceitando pedidos para entrega nem para retirada pelo site no momento.
          </p>
        ) : (
          <>
            {deliveryEnabled && takeoutEnabled ? (
              <div className="grid grid-cols-2 gap-3" role="group" aria-label="Como receber o pedido">
                <button type="button" onClick={() => setOrderType('TAKEOUT')} disabled={locked} aria-pressed={orderType === 'TAKEOUT'} className={`p-3 rounded-xl border-2 text-sm font-bold transition-all disabled:opacity-60 ${orderType === 'TAKEOUT' ? TOGGLE_ACTIVE : TOGGLE_IDLE}`}>Retirada</button>
                <button type="button" onClick={() => setOrderType('DELIVERY')} disabled={locked} aria-pressed={orderType === 'DELIVERY'} className={`p-3 rounded-xl border-2 text-sm font-bold transition-all disabled:opacity-60 ${orderType === 'DELIVERY' ? TOGGLE_ACTIVE : TOGGLE_IDLE}`}>Delivery</button>
              </div>
            ) : (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {deliveryEnabled ? 'Esta loja faz apenas entregas pelo site.' : 'Esta loja trabalha apenas com retirada no balcão pelo site.'}
              </p>
            )}

            <div>
              {orderType === 'TAKEOUT' ? (
                <div className="bg-brand/5 dark:bg-slate-800 border border-brand/20 dark:border-slate-700 rounded-xl p-4 flex items-start gap-3">
                  <div className="bg-white dark:bg-slate-700 p-2 rounded-full text-brand-ink dark:text-brand-ink-dark shadow-sm" aria-hidden="true"><Store size={20} /></div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-gray-800 dark:text-white">{store.name}</p>
                    {takeoutAddress ? (
                      <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                        {[takeoutAddress.street, takeoutAddress.area].filter(Boolean).join(' · ')}
                      </p>
                    ) : (
                      <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                        A loja ainda não informou o endereço de retirada{storePhone ? `. Confirme pelo telefone ${storePhone}.` : '.'}
                      </p>
                    )}
                    {store.takeout_estimate && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Pronto para retirada em {store.takeout_estimate}.</p>
                    )}
                    {takeoutMapUrl && (
                      <a href={takeoutMapUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-bold text-brand-ink dark:text-brand-ink-dark mt-2 hover:underline">
                        <Navigation size={12} aria-hidden="true" /> Ver no Mapa<span className="sr-only"> (abre em nova aba)</span>
                      </a>
                    )}
                  </div>
                </div>
              ) : addresses.length > 0 ? (
                <fieldset className="space-y-3">
                  <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Selecione o endereço:</legend>
                  {!store.delivers_outside_zones && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 flex items-start gap-2">
                      <Info size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
                      {store.name} entrega só nos bairros e CEPs atendidos: fora deles, o pedido é recusado antes do pagamento.
                    </p>
                  )}
                  {addresses.map((addr) => {
                    const selected = selectedAddressId === addr.id;
                    const refused = selected && outOfArea;
                    const cepNote = cepNeighborhoodNote(addr);
                    return (
                      <label key={addr.id} className={`flex items-start gap-3 p-3 rounded-xl border-2 cursor-pointer transition-all ${refused ? 'border-red-400 dark:border-red-500 bg-red-50/60 dark:bg-red-900/10' : selected ? 'border-brand bg-brand/5' : 'border-gray-100 dark:border-slate-700 hover:border-gray-200 dark:hover:border-slate-600'} ${locked ? 'opacity-60 pointer-events-none' : ''}`}>
                        <input type="radio" name="address" checked={selected} onChange={() => setSelectedAddressId(addr.id)} disabled={locked} className="mt-1 accent-brand" />
                        <div className="text-sm flex-1 min-w-0">
                          <p className="font-bold text-gray-800 dark:text-white">{addr.nickname ? `${addr.nickname} - ` : ''}{addr.street}, {addr.number}</p>
                          <p className="text-gray-500 dark:text-gray-400">{addr.neighborhood} - {addr.city}</p>
                          {cepNote && <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">{cepNote}</p>}
                          {refused && <p className="text-xs font-bold text-red-600 dark:text-red-400 mt-1">Fora da área de entrega</p>}
                        </div>
                      </label>
                    );
                  })}
                  {outOfArea && (
                    <div role="alert" className="p-3 rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-sm text-red-700 dark:text-red-300 space-y-2">
                      <p className="font-bold flex items-start gap-2"><Ban size={16} className="shrink-0 mt-0.5" aria-hidden="true" /> {currentQuoteError}</p>
                      <p>Escolha outro endereço ou cadastre um novo{takeoutEnabled ? ', ou retire o pedido no balcão' : ''}. Nada foi cobrado.</p>
                      {takeoutEnabled && (
                        <button type="button" onClick={() => setOrderType('TAKEOUT')} disabled={locked} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 font-bold hover:bg-red-100 dark:hover:bg-red-900/40 disabled:opacity-60">
                          <Store size={14} aria-hidden="true" /> Retirar no balcão
                        </button>
                      )}
                    </div>
                  )}
                  <button type="button" onClick={openAddressModal} disabled={locked} className="w-full py-2 text-sm text-brand-ink dark:text-brand-ink-dark font-bold hover:bg-brand/5 rounded-lg border border-dashed border-brand/40 dark:border-slate-600 disabled:opacity-60">+ Novo Endereço</button>
                </fieldset>
              ) : (
                <div className="text-center p-4 bg-gray-50 dark:bg-slate-800 rounded-xl border border-dashed border-gray-300 dark:border-slate-700 space-y-2">
                  {!isAuthenticated && <p className="text-sm text-gray-500 dark:text-gray-400">Entre na sua conta para cadastrar o endereço de entrega.</p>}
                  <button type="button" onClick={openAddressModal} disabled={locked || isStaff} className="bg-gray-800 dark:bg-slate-700 text-white px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 mx-auto hover:bg-gray-900 transition-colors disabled:opacity-60"><Plus size={16} aria-hidden="true" /> Cadastrar Endereço</button>
                </div>
              )}
            </div>
          </>
        )}
      </section>

      {/* --- RESUMO --- */}
      <section aria-labelledby="summary-title" className="bg-white dark:bg-slate-900 p-5 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 space-y-3 transition-colors">
        <h2 id="summary-title" className="font-bold text-gray-800 dark:text-white flex items-center gap-2">
          Resumo {quoteLoading && <Loader2 size={16} className="animate-spin text-gray-400" aria-label="Calculando" />}
        </h2>
        <div className="flex justify-between text-sm text-gray-600 dark:text-gray-400">
          <span>{quoteData ? 'Subtotal' : 'Subtotal (estimado)'}</span>
          <span>{formatCurrency(subtotal)}</span>
        </div>
        <div className="flex justify-between text-sm text-gray-600 dark:text-gray-400">
          <span>Taxa de entrega</span>
          <span>{deliveryFeeLabel}</span>
        </div>
        <div className="flex justify-between font-bold text-gray-800 dark:text-white pt-3 border-t border-gray-100 dark:border-slate-800">
          <span>Total</span>
          <span>{payableTotal !== null ? formatCurrency(payableTotal) : '--'}</span>
        </div>
        {!isAuthenticated && (
          <p className="text-xs text-gray-500 dark:text-gray-400">Entre na sua conta para calcular a entrega e finalizar o pedido.</p>
        )}
        {currentQuoteError && outOfArea && (
          // O aviso completo (com as opções) fica junto do endereço; aqui, só o motivo do bloqueio
          <p className="text-sm text-red-600 dark:text-red-400 flex items-start gap-2"><AlertCircle size={16} className="shrink-0 mt-0.5" aria-hidden="true" /> {currentQuoteError}</p>
        )}
        {currentQuoteError && !outOfArea && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-red-600 dark:text-red-400 flex items-start gap-2" role="alert"><AlertCircle size={16} className="shrink-0 mt-0.5" aria-hidden="true" /> {currentQuoteError}</p>
            <button
              type="button"
              onClick={retryQuote}
              className="text-sm font-bold text-brand-ink dark:text-brand-ink-dark flex items-center gap-1 hover:underline"
            >
              <RotateCw size={14} aria-hidden="true" /> Tentar novamente
            </button>
          </div>
        )}
      </section>

      {/* --- PAGAMENTO --- */}
      {approvedPaymentId === null && (
        <section aria-labelledby="payment-title" className="bg-white dark:bg-slate-900 p-5 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 space-y-4 transition-colors">
          <h2 id="payment-title" className="font-bold text-gray-800 dark:text-white">Pagamento</h2>

          {onlineEnabled || pix ? (
            <div className={`flex p-1 bg-gray-100 dark:bg-slate-800 rounded-xl mb-4 ${toggleDisabled ? 'opacity-50 pointer-events-none' : ''}`} role="group" aria-label="Quando pagar">
              <button type="button" onClick={() => setPaymentType('ONLINE')} disabled={toggleDisabled} aria-pressed={paymentType === 'ONLINE'} className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${paymentType === 'ONLINE' ? 'bg-white dark:bg-slate-700 shadow-sm text-brand-ink dark:text-brand-ink-dark' : 'text-gray-500 dark:text-gray-400'}`}>Pagar Agora (Online)</button>
              <button type="button" onClick={() => setPaymentType('OFFLINE')} disabled={toggleDisabled} aria-pressed={paymentType === 'OFFLINE'} className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${paymentType === 'OFFLINE' ? 'bg-white dark:bg-slate-700 shadow-sm text-brand-ink dark:text-brand-ink-dark' : 'text-gray-500 dark:text-gray-400'}`}>{offlineLabel}</button>
            </div>
          ) : (
            <p className="text-xs text-gray-500 dark:text-gray-400 flex items-start gap-2">
              <Info size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
              {store.name} recebe o pagamento {orderType === 'TAKEOUT' ? 'na retirada' : 'na entrega'} (dinheiro ou cartão na maquininha).
            </p>
          )}

          {paymentType === 'ONLINE' ? (
            <div className="animate-in fade-in space-y-6">
              <div className="flex gap-4 border-b border-gray-100 dark:border-slate-800 pb-2" role="group" aria-label="Forma de pagamento online">
                {cardEnabled && (
                  <button
                    type="button"
                    onClick={() => setOnlineMethod('CREDIT_CARD')}
                    disabled={toggleDisabled}
                    aria-pressed={onlineMethod === 'CREDIT_CARD'}
                    className={`pb-2 text-sm font-bold transition-all border-b-2 ${onlineMethod === 'CREDIT_CARD' ? 'border-brand text-brand-ink dark:text-brand-ink-dark' : 'border-transparent text-gray-500 dark:text-gray-400'}`}
                  >
                    Cartão de Crédito
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setOnlineMethod('PIX')}
                  disabled={toggleDisabled}
                  aria-pressed={onlineMethod === 'PIX'}
                  className={`pb-2 text-sm font-bold transition-all border-b-2 ${onlineMethod === 'PIX' ? 'border-brand text-brand-ink dark:text-brand-ink-dark' : 'border-transparent text-gray-500 dark:text-gray-400'}`}
                >
                  PIX
                </button>
              </div>

              {onlineMethod === 'CREDIT_CARD' && publicKey ? (
                <PaymentForm
                  storeSlug={slug}
                  publicKey={publicKey}
                  total={payableTotal}
                  payload={orderPayload}
                  blockedReason={blockedReason}
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
                    {pixLoading ? <><Loader2 size={18} className="animate-spin" aria-hidden="true" /> Gerando...</> : payableTotal !== null ? `Gerar PIX de ${formatCurrency(payableTotal)}` : 'Gerar QR Code PIX'}
                  </button>
                  {blockedReason && isAuthenticated && <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">{blockedReason}</p>}
                </div>
              )}
            </div>
          ) : (
            <div className="animate-in fade-in space-y-4">
              <div>
                <label htmlFor="offline-method" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Forma de pagamento {orderType === 'TAKEOUT' ? 'na retirada' : 'na entrega'}</label>
                <select
                  id="offline-method"
                  value={offlineMethod}
                  onChange={(event) => setOfflineMethod(event.target.value as OfflineMethod)}
                  disabled={toggleDisabled}
                  className="w-full p-3 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl outline-none focus:border-brand focus:ring-2 focus:ring-brand text-gray-900 dark:text-white disabled:opacity-50"
                >
                  {OFFLINE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>

              {offlineMethod === 'MONEY' && (
                <div className="bg-brand/5 dark:bg-slate-800 p-4 rounded-xl border border-brand/20 dark:border-slate-700 animate-in slide-in-from-top-2">
                  <label htmlFor="change-for" className="text-sm font-bold text-gray-700 dark:text-white mb-2 flex items-center gap-2">
                    <Banknote size={18} className="text-green-600 dark:text-green-400" aria-hidden="true" />
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
                    aria-describedby="change-for-hint"
                    className="w-full p-3 bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-600 rounded-lg font-bold text-lg text-gray-800 dark:text-white focus:ring-2 focus:ring-brand outline-none"
                  />
                  <p id="change-for-hint" className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                    {payableTotal !== null ? <>O total do pedido é <b>{formatCurrency(payableTotal)}</b>. </> : null}
                    Deixe em branco se não precisar de troco.
                  </p>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {showBottomBar && (
        <div className="fixed bottom-0 left-0 right-0 bg-white dark:bg-slate-900 border-t border-gray-100 dark:border-slate-800 p-4 lg:p-6 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] dark:shadow-none z-40 transition-colors">
          <div className="max-w-2xl mx-auto space-y-3">
            {errorMsg && <div role="alert" className="bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 p-3 rounded-lg text-sm flex items-center gap-2"><AlertCircle size={18} className="shrink-0" aria-hidden="true" />{errorMsg}</div>}

            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400 font-medium uppercase">Total a pagar</p>
                <p className="text-2xl font-bold text-gray-800 dark:text-white">{payableTotal !== null ? formatCurrency(payableTotal) : '--'}</p>
              </div>

              {paymentType === 'OFFLINE' && (
                <button
                  type="button"
                  onClick={handleFinishOffline}
                  disabled={submitting || isStaff || (!!blockedReason && isAuthenticated)}
                  className={`px-6 sm:px-8 py-3 rounded-xl font-bold transition-colors flex items-center gap-2 ${isStaff ? 'bg-gray-300 dark:bg-slate-700 text-gray-500 dark:text-gray-400 cursor-not-allowed' : 'bg-green-600 text-white hover:bg-green-700 disabled:opacity-50'}`}
                >
                  {isStaff ? 'Bloqueado (Staff)' : submitting ? <><Loader2 size={18} className="animate-spin" aria-hidden="true" /> Enviando...</> : <>Finalizar Pedido <ArrowRight size={20} aria-hidden="true" /></>}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {!showBottomBar && errorMsg && (
        <div role="alert" className="bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 p-3 rounded-lg text-sm flex items-center gap-2">
          <AlertCircle size={18} className="shrink-0" aria-hidden="true" />{errorMsg}
        </div>
      )}

      {modals}
    </div>
  );
}
