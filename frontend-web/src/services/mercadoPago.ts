/**
 * SDK do Mercado Pago (tokenização do cartão no navegador).
 *
 * O script é carregado sob demanda (async), quando o formulário de cartão de uma loja abre: o resto do
 * site não baixa o SDK. Por isso ele pode ainda não estar pronto quando a tela de pagamento abre:
 * use loadMercadoPagoSdk() / getMercadoPagoInstance() em vez de ler window.MercadoPago direto.
 *
 * Cada loja recebe na própria conta do Mercado Pago: a chave PÚBLICA vem do perfil da loja
 * (GET /stores/:slug → payments.mp_public_key). O Access Token é secreto e fica só no backend.
 */

import { STORAGE_KEYS } from '../config/brand';
import { hasInternalAccess, type AccessSubject } from '../utils/roles';

/** Chave pública de TESTE (sandbox), usada só em desenvolvimento quando a loja não tem chave. */
const DEV_TEST_PUBLIC_KEY = 'TEST-6aeab6dc-85c6-4d63-b0e6-8f605114628d';

/**
 * Chave pública para tokenizar o cartão nesta loja: a da loja; SOMENTE em desenvolvimento
 * (import.meta.env.DEV), sem chave da loja, VITE_MP_PUBLIC_KEY ou a chave de teste.
 * null = pagamento com cartão indisponível nesta loja (o PIX não depende da chave).
 */
export function resolveMercadoPagoPublicKey(storeKey: string | null | undefined): string | null {
  const key = storeKey?.trim();
  if (key) return key;
  if (import.meta.env.DEV) {
    return (import.meta.env.VITE_MP_PUBLIC_KEY as string | undefined)?.trim() || DEV_TEST_PUBLIC_KEY;
  }
  return null;
}

/** Chave de teste (sandbox): a tela mostra o cartão de teste e avisa que nada é cobrado. */
export function isTestPublicKey(publicKey: string | null | undefined): boolean {
  return !!publicKey && publicKey.startsWith('TEST-');
}

const SDK_URL = 'https://sdk.mercadopago.com/js/v2';
const SDK_SCRIPT_ID = 'mercadopago-sdk';
const LOAD_TIMEOUT_MS = 15_000;

/** Contas da equipe e da plataforma não pagam com cartão na vitrine (e o SDK não é carregado para elas). */
export const INTERNAL_ACCOUNT_CARD_MESSAGE = 'O pagamento com cartão não fica disponível para contas da equipe ou da plataforma.';

/**
 * Sessão deste navegador é da equipe de uma loja ou da plataforma. O SDK (script de terceiros, URL sem versão
 * fixa e sem SRI) não roda no mesmo documento que guarda esses tokens: um script comprometido leria o
 * localStorage e levaria o acesso da equipe ou do superadministrador.
 */
function internalSessionActive(): boolean {
  try {
    // Sessão bearer (token) ou em cookie (marcador): o token de acesso da sessão em cookie fica na memória
    if (!localStorage.getItem(STORAGE_KEYS.token) && !localStorage.getItem(STORAGE_KEYS.session)) return false;
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEYS.user) ?? 'null');
    return typeof parsed === 'object' && parsed !== null && hasInternalAccess(parsed as AccessSubject);
  } catch {
    return false;
  }
}

/** O SDK já foi injetado neste documento (o código dele continua rodando mesmo depois de sair da vitrine). */
export function isMercadoPagoSdkPresent(): boolean {
  return !!document.getElementById(SDK_SCRIPT_ID) || !!readSdk();
}

/** Construtor global criado pelo SDK: new MercadoPago(publicKey, { locale }). */
export type MercadoPagoConstructor = new (
  publicKey: string,
  options?: { locale?: string; deviceProfileCspNonce?: string },
) => unknown;

export interface MercadoPagoPaymentMethod {
  id: string;
  payment_type_id?: string;
  settings?: { security_code?: { length?: number } }[];
}

/** Métodos do SDK usados no checkout. */
export interface MercadoPagoInstance {
  createCardToken(data: {
    cardNumber: string;
    cardholderName: string;
    cardExpirationMonth: string;
    cardExpirationYear: string;
    securityCode: string;
    identificationType: string;
    identificationNumber: string;
  }): Promise<{ id?: string }>;
  getPaymentMethods?(data: { bin: string }): Promise<{ results?: MercadoPagoPaymentMethod[] }>;
}

function readSdk(): MercadoPagoConstructor | undefined {
  return (window as unknown as { MercadoPago?: MercadoPagoConstructor }).MercadoPago;
}

function injectScript(): HTMLScriptElement {
  const script = document.createElement('script');
  script.id = SDK_SCRIPT_ID;
  script.src = SDK_URL;
  script.async = true;
  document.head.appendChild(script);
  return script;
}

let pending: Promise<MercadoPagoConstructor> | null = null;

/**
 * Resolve com o construtor do SDK assim que ele estiver disponível; carrega o script se preciso.
 * Rejeita se o script falhar (sem internet, bloqueador) ou demorar mais de 15 s; uma nova chamada tenta de novo.
 */
export function loadMercadoPagoSdk(): Promise<MercadoPagoConstructor> {
  if (internalSessionActive()) return Promise.reject(new Error(INTERNAL_ACCOUNT_CARD_MESSAGE));
  const ready = readSdk();
  if (ready) return Promise.resolve(ready);
  if (pending) return pending;

  pending = new Promise<MercadoPagoConstructor>((resolve, reject) => {
    let script = document.getElementById(SDK_SCRIPT_ID) as HTMLScriptElement | null;

    // Cada script injetado recebe data-status quando termina. Se ele já terminou sem criar o SDK
    // (falha de rede, bloqueador), é trocado por um novo; se ainda está baixando, só esperamos.
    if (!script || script.dataset.status) {
      script?.remove();
      script = injectScript();
    }

    const element = script;
    const timer = window.setTimeout(() => finish(new Error('Tempo esgotado ao carregar o Mercado Pago.')), LOAD_TIMEOUT_MS);

    function finish(error?: Error) {
      window.clearTimeout(timer);
      element.removeEventListener('load', onLoad);
      element.removeEventListener('error', onError);
      const sdk = readSdk();
      if (sdk) {
        resolve(sdk);
      } else {
        pending = null;
        reject(error ?? new Error('SDK do Mercado Pago indisponível.'));
      }
    }
    function onLoad() {
      element.dataset.status = 'loaded';
      finish();
    }
    function onError() {
      element.dataset.status = 'error';
      finish(new Error('Não foi possível carregar o Mercado Pago. Verifique sua conexão.'));
    }

    element.addEventListener('load', onLoad);
    element.addEventListener('error', onError);
  });

  return pending;
}

/**
 * Nonce da CSP enviado pelo servidor que hospeda o build (<meta property="csp-nonce" nonce="...">, gerado a
 * cada resposta). Sem ele, a CSP do build bloqueia o script INLINE do perfil do dispositivo (antifraude) que o
 * SDK injeta; a tokenização do cartão não depende dele.
 */
function cspNonce(): string | undefined {
  const meta = document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]');
  return meta?.nonce || meta?.getAttribute('content') || undefined;
}

/** Uma instância do SDK por chave pública (cada loja tem a sua conta no Mercado Pago). */
const instances = new Map<string, Promise<MercadoPagoInstance>>();

/**
 * Instância do SDK para a chave pública da loja (criada uma vez por chave e reaproveitada).
 * Se o SDK não carregar, a próxima chamada tenta de novo.
 */
export function getMercadoPagoInstance(publicKey: string): Promise<MercadoPagoInstance> {
  const cached = instances.get(publicKey);
  if (cached) return cached;

  const created = loadMercadoPagoSdk()
    .then((MercadoPago) => {
      const nonce = cspNonce();
      return new MercadoPago(publicKey, { locale: 'pt-BR', ...(nonce ? { deviceProfileCspNonce: nonce } : {}) }) as MercadoPagoInstance;
    })
    .catch((error: unknown) => {
      instances.delete(publicKey);
      if (error instanceof Error && error.message === INTERNAL_ACCOUNT_CARD_MESSAGE) throw error;
      throw new Error('O sistema de pagamento com cartão não carregou. Verifique sua conexão ou pague via PIX.');
    });
  instances.set(publicKey, created);
  return created;
}
