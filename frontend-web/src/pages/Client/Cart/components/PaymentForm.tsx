import { useEffect, useId, useRef, useState, type ChangeEvent, type FocusEvent, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { AlertCircle, CreditCard as CardIcon, Loader2, Lock } from 'lucide-react';
import CreditCard from '../../../../components/CreditCard';
import { maskCardNumber, maskCPF, maskDate } from '../../../../utils/masks';
import { isValidCpf } from '../../../../utils/validation';
import { isTestPublicKey } from '../../../../services/mercadoPago';
import {
  attemptKey, cardRejectionMessage, errorMessage, getMercadoPago, isUncertainFailure, lookupCreditMethod, pollPaymentStatus, preloadMercadoPago, storeCheckoutApi, type CardPaymentResponse, type MercadoPagoPaymentMethod, type OrderPayload, type PaymentAttempt,
} from '../checkout';
import { formatCurrency } from '../../../../utils/format';

type FocusField = 'number' | 'name' | 'expiry' | 'cvc' | '';

interface PaymentFormProps {
  /** Slug da loja da rota: o pagamento vai para POST /stores/:slug/payment/card. */
  storeSlug: string;
  /** Chave pública do Mercado Pago da loja (tokenização do cartão no navegador). */
  publicKey: string;
  /** Total calculado pelo servidor (orçamento). */
  total: number | null;
  /** Pedido que será pago — o mesmo corpo do orçamento. */
  payload: OrderPayload | null;
  /** Motivo para não pagar agora (loja fechada, sem endereço...). Sem motivo, o clique segue para onBeforePay. */
  blockedReason?: string | null;
  /** A página está ocupada (ex.: registrando outro pedido). */
  busy?: boolean;
  /** Validações da página (login, endereço, loja aberta). false = não cobra. */
  onBeforePay: () => boolean;
  /** Recalcula o total no servidor logo antes de cobrar (pede confirmação se mudou). null = não cobra. */
  onConfirmTotal: () => Promise<number | null>;
  onProcessingChange?: (processing: boolean) => void;
  /** Pagamento aprovado e pedido registrado pelo servidor. */
  onOrderCreated: (orderId: number) => void;
  /** Aprovado, mas o pedido ainda não apareceu: o servidor registra sozinho em instantes. */
  onApprovedPending: (paymentId: number) => void;
}

const EMPTY_CARD = { number: '', name: '', expiry: '', cvc: '', docNumber: '' };
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

/** Bandeira pelos primeiros dígitos (sem resposta do Mercado Pago, é a que vale). */
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

/** Nome usado pelo desenho do cartão (react-credit-cards). */
function issuerFor(brand: string): string | undefined {
  if (brand === UNKNOWN_BRAND) return undefined;
  if (brand === 'master' || brand === 'debmaster') return 'mastercard';
  return brand.replace(/^deb/, '');
}

/** Dígito verificador (Luhn) do número do cartão. */
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

/** MM/AA válido e ainda não vencido. */
function isValidExpiry(expiry: string): boolean {
  const match = /^(\d{2})\/(\d{2})$/.exec(expiry);
  if (!match) return false;
  const month = Number(match[1]);
  const year = 2000 + Number(match[2]);
  if (month < 1 || month > 12) return false;
  const now = new Date();
  return year > now.getFullYear() || (year === now.getFullYear() && month >= now.getMonth() + 1);
}

const LABEL_CLASS = 'block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1 uppercase';

export default function PaymentForm({
  storeSlug, publicKey, total, payload, blockedReason, busy = false, onBeforePay, onConfirmTotal, onProcessingChange, onOrderCreated, onApprovedPending,
}: PaymentFormProps) {
  const [card, setCard] = useState(EMPTY_CARD);
  const [focus, setFocus] = useState<FocusField>('');
  const [processing, setProcessing] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [formError, setFormError] = useState('');
  const fieldId = useId();

  // Trava contra clique duplo (o estado do React só atualiza no próximo render)
  const processingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // Chave da tentativa: repetida se a resposta não chegar (nunca cobra duas vezes)
  const attemptRef = useRef<PaymentAttempt | null>(null);

  useEffect(() => {
    preloadMercadoPago(publicKey);
  }, [publicKey]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const brand = detectCardBrand(card.number);
  const cvcLength = brand === 'amex' ? 4 : 3;
  const isTestKey = isTestPublicKey(publicKey);

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const { name, value } = event.target;
    let formatted = value;
    if (name === 'number') formatted = maskCardNumber(value);
    if (name === 'expiry') formatted = maskDate(value);
    if (name === 'docNumber') formatted = maskCPF(value);
    if (name === 'cvc') formatted = value.replace(/\D/g, '').slice(0, 4);
    if (name === 'name') formatted = value.toUpperCase();
    setCard((previous) => ({ ...previous, [name]: formatted }));
    setFormError('');
  }

  function handleFocus(event: FocusEvent<HTMLInputElement>) {
    const name = event.target.name;
    setFocus(name === 'number' || name === 'name' || name === 'expiry' || name === 'cvc' ? name : '');
  }

  /**
   * Confere o cartão. Bandeira desconhecida no aparelho → pergunta ao Mercado Pago pelo BIN antes de
   * recusar (cartões Elo e de bancos novos). Devolve o meio do Mercado Pago quando ele respondeu.
   */
  async function validateCard(): Promise<{ error: string | null; method: MercadoPagoPaymentMethod | null }> {
    const digits = card.number.replace(/\D/g, '');
    if (!isValidCardNumber(digits)) return { error: 'Número do cartão inválido.', method: null };

    let method: MercadoPagoPaymentMethod | null = null;
    let cvc = cvcLength;
    if (brand === UNKNOWN_BRAND) {
      method = await lookupCreditMethod(publicKey, digits);
      if (!method) return { error: 'Bandeira não aceita. Use Visa, Mastercard, Elo, Amex ou Hipercard.', method: null };
      cvc = method.settings?.[0]?.security_code?.length || (method.id === 'amex' ? 4 : 3);
    }
    if (card.name.trim().length < 2) return { error: 'Informe o nome impresso no cartão.', method };
    if (!isValidExpiry(card.expiry)) return { error: 'Validade inválida ou cartão vencido.', method };
    if (card.cvc.length !== cvc) return { error: `O CVV deve ter ${cvc} dígitos.`, method };
    if (!isValidCpf(card.docNumber.replace(/\D/g, ''))) return { error: 'CPF do titular inválido.', method };
    return { error: null, method };
  }

  function setBusyState(value: boolean) {
    processingRef.current = value;
    setProcessing(value);
    onProcessingChange?.(value);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (processingRef.current || busy) return;
    if (!onBeforePay() || !payload) return;

    setBusyState(true);
    setFormError('');
    setStatusText('Conferindo o cartão...');
    try {
      const { error: invalid, method } = await validateCard();
      if (invalid) {
        setFormError(invalid);
        return;
      }

      // O total pode ter mudado (promoção, taxa): o cliente confirma antes de qualquer cobrança
      setStatusText('Conferindo o total...');
      const confirmedTotal = await onConfirmTotal();
      if (confirmedTotal === null) return;

      setStatusText('Processando pagamento...');
      const digits = card.number.replace(/\D/g, '');
      const [month, year] = card.expiry.split('/');
      // Token criado com a chave pública da LOJA: o pagamento cai na conta Mercado Pago dela
      const mp = await getMercadoPago(publicKey);

      let token: { id?: string };
      try {
        token = await mp.createCardToken({
          cardNumber: digits,
          cardholderName: card.name.trim(),
          cardExpirationMonth: month,
          cardExpirationYear: `20${year}`,
          securityCode: card.cvc,
          identificationType: 'CPF',
          identificationNumber: card.docNumber.replace(/\D/g, ''),
        });
      } catch {
        throw new Error('Não foi possível validar o cartão. Confira número, validade, CVV e CPF.');
      }
      if (!token?.id) throw new Error('Não foi possível validar o cartão. Confira os dados.');

      const paymentMethodId = (method ?? (await lookupCreditMethod(publicKey, digits)))?.id ?? brand;

      // Mesma tentativa (mesmo pedido) = mesma chave: repetir depois de uma falha de rede não cobra de novo
      const attempt = attemptKey(attemptRef.current, JSON.stringify(payload));
      attemptRef.current = attempt;

      // O valor não é enviado: o servidor calcula a partir do pedido
      let data: CardPaymentResponse;
      try {
        data = await storeCheckoutApi(storeSlug).createCard({
          order: payload,
          token: token.id,
          paymentMethodId,
          installments: 1,
          docType: 'CPF',
          docNumber: card.docNumber.replace(/\D/g, ''),
          idempotencyKey: attempt.key,
        });
      } catch (error) {
        if (isUncertainFailure(error)) {
          throw new Error(
            'Não recebemos a confirmação do pagamento a tempo. Confira em Meus Pedidos se o pedido foi registrado; tentar de novo é seguro e não gera cobrança em dobro.',
          );
        }
        attemptRef.current = null; // recusa definitiva: a próxima tentativa é outra
        throw error;
      }
      attemptRef.current = null;

      let status = data.status;
      let orderId = typeof data.orderId === 'number' ? data.orderId : null;
      let detail = data.status_detail;

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
        if (outcome.result === 'aborted') return;
        if (outcome.result === 'approved' || outcome.result === 'approved_pending') {
          status = 'approved';
          orderId = outcome.orderId ?? null;
        } else if (outcome.result === 'failed') {
          status = outcome.status ?? 'rejected';
          detail = outcome.statusDetail ?? detail;
        }
      }

      if (status === 'approved') {
        setCard(EMPTY_CARD);
        toast.success(data.simulation ? 'Pagamento aprovado (simulação de testes).' : 'Pagamento aprovado!');
        if (orderId !== null) onOrderCreated(orderId);
        else onApprovedPending(data.id);
      } else if (status === 'rejected' || status === 'cancelled') {
        const message = cardRejectionMessage(detail);
        setFormError(message);
        toast.error(message);
      } else {
        const message = `O pagamento nº ${data.id} ainda está em análise. Não pague de novo: se ele for aprovado, o pedido aparece em Meus Pedidos automaticamente.`;
        setFormError(message);
        toast.error('Pagamento em análise.');
      }
    } catch (error) {
      const message = errorMessage(error, 'Não foi possível processar o pagamento. Tente novamente.');
      setFormError(message);
      toast.error(message);
    } finally {
      abortRef.current = null;
      setStatusText('');
      setBusyState(false);
    }
  }

  const working = processing || busy;
  const buttonDisabled = working || !!blockedReason;
  const inputClass =
    'w-full bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl p-3 focus:ring-2 focus:ring-brand outline-none transition-all text-gray-900 dark:text-white disabled:opacity-60';
  const errorId = `${fieldId}-error`;

  return (
    <div className="space-y-6">
      <CreditCard
        number={card.number}
        name={card.name}
        expiry={card.expiry}
        cvc={card.cvc}
        focus={focus}
        issuer={issuerFor(brand)}
      />

      <form onSubmit={handleSubmit} className="space-y-4" noValidate aria-describedby={formError ? errorId : undefined}>
        <fieldset disabled={working} className="space-y-4">
          <legend className="sr-only">Dados do cartão de crédito</legend>
          <div>
            <label htmlFor={`${fieldId}-number`} className={LABEL_CLASS}>Número do Cartão</label>
            <div className="relative">
              <input
                id={`${fieldId}-number`}
                type="text"
                inputMode="numeric"
                autoComplete="cc-number"
                name="number"
                placeholder="0000 0000 0000 0000"
                value={card.number}
                onChange={handleChange}
                onFocus={handleFocus}
                className={`${inputClass} pl-10 font-mono`}
                maxLength={19}
                required
              />
              <CardIcon className="absolute left-3 top-3.5 text-gray-400 dark:text-gray-500" size={18} aria-hidden="true" />
            </div>
          </div>

          <div>
            <label htmlFor={`${fieldId}-name`} className={LABEL_CLASS}>Nome no Cartão</label>
            <input
              id={`${fieldId}-name`}
              type="text"
              autoComplete="cc-name"
              name="name"
              placeholder="COMO ESTÁ NO CARTÃO"
              value={card.name}
              onChange={handleChange}
              onFocus={handleFocus}
              className={inputClass}
              maxLength={60}
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor={`${fieldId}-expiry`} className={LABEL_CLASS}>Validade</label>
              <input
                id={`${fieldId}-expiry`}
                type="text"
                inputMode="numeric"
                autoComplete="cc-exp"
                name="expiry"
                placeholder="MM/AA"
                value={card.expiry}
                onChange={handleChange}
                onFocus={handleFocus}
                className={`${inputClass} font-mono text-center`}
                maxLength={5}
                required
              />
            </div>
            <div>
              <label htmlFor={`${fieldId}-cvc`} className={LABEL_CLASS}>CVV</label>
              <div className="relative">
                <input
                  id={`${fieldId}-cvc`}
                  type="password"
                  inputMode="numeric"
                  autoComplete="cc-csc"
                  name="cvc"
                  placeholder={cvcLength === 4 ? '1234' : '123'}
                  value={card.cvc}
                  onChange={handleChange}
                  onFocus={handleFocus}
                  className={`${inputClass} pl-10 font-mono`}
                  maxLength={brand === UNKNOWN_BRAND ? 4 : cvcLength}
                  required
                />
                <Lock className="absolute left-3 top-3.5 text-gray-400 dark:text-gray-500" size={18} aria-hidden="true" />
              </div>
            </div>
          </div>

          <div>
            <label htmlFor={`${fieldId}-doc`} className={LABEL_CLASS}>CPF do Titular</label>
            <input
              id={`${fieldId}-doc`}
              type="text"
              inputMode="numeric"
              name="docNumber"
              placeholder="000.000.000-00"
              value={card.docNumber}
              onChange={handleChange}
              onFocus={handleFocus}
              className={`${inputClass} font-mono`}
              maxLength={14}
              required
            />
          </div>
        </fieldset>

        {/* Só com a chave de TESTE (sandbox) da loja: nada é cobrado de verdade */}
        {isTestKey && (
          <p className="text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-slate-800 rounded-lg p-3">
            Ambiente de testes: use o cartão <b>5031 4332 1540 6351</b>, validade <b>11/30</b>, CVV <b>123</b> e CPF <b>123.456.789-09</b>.
            Nenhum valor real é cobrado.
          </p>
        )}

        {formError && (
          <div id={errorId} role="alert" className="bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 p-3 rounded-lg text-sm flex items-start gap-2">
            <AlertCircle size={18} className="shrink-0 mt-0.5" aria-hidden="true" />
            <span>{formError}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={buttonDisabled}
          className="w-full bg-green-600 text-white font-bold py-4 rounded-xl hover:bg-green-700 transition-all shadow-lg shadow-green-200 dark:shadow-none flex items-center justify-center gap-2 mt-4 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {working ? (
            <>
              <Loader2 size={18} className="animate-spin" aria-hidden="true" /> {statusText || 'Aguarde...'}
            </>
          ) : (
            <>
              <Lock size={18} aria-hidden="true" /> {total !== null ? `Pagar ${formatCurrency(total)}` : 'Pagar com cartão'}
            </>
          )}
        </button>
        {blockedReason && !working && (
          <p className="text-center text-xs text-gray-500 dark:text-gray-400">{blockedReason}</p>
        )}
      </form>
    </div>
  );
}
