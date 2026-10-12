/**
 * SDK do Mercado Pago (tokenização do cartão no navegador).
 *
 * O index.html carrega o script com async (não trava a abertura do site, nem sem internet).
 * Por isso o SDK pode ainda não estar pronto quando a tela de pagamento abre:
 * use loadMercadoPagoSdk() em vez de ler window.MercadoPago direto.
 */

/** Chave PÚBLICA (VITE_MP_PUBLIC_KEY). Sem configuração, usa a chave de teste. O Access Token fica só no backend. */
export const MP_PUBLIC_KEY =
  (import.meta.env.VITE_MP_PUBLIC_KEY as string | undefined)?.trim() || 'TEST-6aeab6dc-85c6-4d63-b0e6-8f605114628d';

const SDK_URL = 'https://sdk.mercadopago.com/js/v2';
const SDK_SCRIPT_ID = 'mercadopago-sdk';
const LOAD_TIMEOUT_MS = 15_000;

/** Construtor global criado pelo SDK: new MercadoPago(publicKey, { locale }). */
export type MercadoPagoConstructor = new (publicKey: string, options?: { locale?: string }) => unknown;

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
  const ready = readSdk();
  if (ready) return Promise.resolve(ready);
  if (pending) return pending;

  pending = new Promise<MercadoPagoConstructor>((resolve, reject) => {
    let script = document.getElementById(SDK_SCRIPT_ID) as HTMLScriptElement | null;

    // O index.html marca data-status quando o script termina. Se ele já terminou sem criar o SDK
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
