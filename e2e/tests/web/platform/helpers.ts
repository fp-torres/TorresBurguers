import { expect, request, type APIRequestContext, type Locator, type Page, type Response } from '@playwright/test';
import { E2E } from '../../../support/env';
import { loginAs, uid, uniqueEmail, type Session } from '../../../support/api';
import { useSession } from '../../../support/web';
import {
  addProduct,
  bearer,
  createStore as createTenantStore,
  expectStatus,
  newCustomer,
  retireStore,
  type Json,
  type Member,
  type TenantStore,
} from '../../api/tenancy/helpers';

/**
 * Apoio das suítes web do SUPERPAINEL (/platform) e da VITRINE MULTI-LOJA (tests/web/multistore).
 *
 * - As lojas extras são criadas pela API, com os helpers da suíte de isolamento (api/tenancy): loja criada
 *   pelo superpainel no plano interno "demo" (sem cobrança e sem limites), responsável que entra pelo
 *   convite, zonas de entrega próprias e loja aberta. No fim de cada arquivo elas são desativadas
 *   (nada é apagado; saem da vitrine e do diretório).
 * - Planos e lojas com cobrança são criados aqui mesmo (privados) e aposentados no fim do arquivo.
 * - A loja demo do seed nunca muda de situação, plano ou configuração nestas suítes.
 */

export { addProduct, bearer, expectStatus, newCustomer, uid, uniqueEmail };
export type { Json, Member, Session, TenantStore };

export const API_URL = E2E.apiURL;
export const PASSWORD = 'SenhaForte@123';

/** Contexto HTTP próprio (beforeAll/afterAll não têm o fixture `request`). Lembre do dispose(). */
export function newApi(): Promise<APIRequestContext> {
  return request.newContext({ baseURL: E2E.apiURL });
}

/** Login do superadmin do seed (uma sessão por arquivo: as chamadas de preparo e limpeza usam esta). */
export async function superadminSession(api: APIRequestContext): Promise<Session> {
  return loginAs(api, 'superadmin');
}

/** Injeta a sessão (token + usuário) no navegador antes de abrir a página. */
export async function signIn(page: Page, session: Session): Promise<void> {
  await useSession(page, session);
}

export async function getJson(api: APIRequestContext, path: string, token: string): Promise<Json> {
  return expectStatus(await api.get(path, { headers: bearer(token) }), 200, `GET ${path}`);
}

// ---------------------------------------------------------------------------
// Lojas e planos de teste
// ---------------------------------------------------------------------------

/** Loja nova pelo superpainel (plano interno, responsável já dentro, aberta e com entrega por padrão). */
export async function tenantStore(
  api: APIRequestContext,
  superadmin: Session,
  label: string,
  options: { open?: boolean; delivery?: boolean } = {},
): Promise<TenantStore> {
  return createTenantStore(api, superadmin, label, options);
}

/** Desativa a loja de teste (melhor esforço; a limpeza nunca derruba o arquivo). */
export async function retireTenantStore(api: APIRequestContext, superadmin: Session, store: { id: number }): Promise<void> {
  await retireStore(api, superadmin, store as TenantStore).catch(() => undefined);
}

/** Plano privado do teste (fora da página pública de planos). */
export async function createPlan(api: APIRequestContext, superadmin: Session, data: Record<string, unknown> = {}): Promise<Json> {
  const code = uid('wpl').toLowerCase().slice(0, 40);
  const res = await api.post('/platform/plans', {
    headers: bearer(superadmin.token),
    data: { code, name: `Plano Web ${code}`.slice(0, 80), price: 0, is_public: false, trial_days: 0, ...data },
  });
  return expectStatus(res, 201, 'POST /platform/plans');
}

/** Tira o plano de venda (planos nunca são apagados). */
export async function retirePlan(api: APIRequestContext, superadmin: Session, planId: number): Promise<void> {
  await api
    .patch(`/platform/plans/${planId}`, { headers: bearer(superadmin.token), data: { status: 'INACTIVE', is_public: false } })
    .catch(() => undefined);
}

export interface PaidStore {
  id: number;
  slug: string;
  name: string;
  subscriptionId: number;
}

/**
 * Loja num plano pago com cobrança manual e a primeira fatura já registrada como paga: a assinatura fica
 * ativa com um período pago a vencer (o que permite agendar o cancelamento para o fim do período).
 */
export async function paidStore(api: APIRequestContext, superadmin: Session, planId: number, label: string): Promise<PaidStore> {
  const slug = uid('wps').toLowerCase();
  const res = await api.post('/platform/stores', {
    headers: bearer(superadmin.token),
    data: { name: `${label} ${slug}`.slice(0, 120), slug, plan_id: planId, owner: { email: uniqueEmail('wps-dono') } },
  });
  const created = await expectStatus(res, 201, 'POST /platform/stores (plano pago)');
  const subscriptionId = created.subscription.id as number;
  const detail = await getJson(api, `/platform/subscriptions/${subscriptionId}`, superadmin.token);
  for (const invoice of detail.invoices as Json[]) {
    if (invoice.status === 'OPEN' || invoice.status === 'FAILED') {
      const paid = await api.post(`/platform/invoices/${invoice.id}/mark-paid`, {
        headers: bearer(superadmin.token),
        data: { payment_method: 'PIX', notes: 'Pagamento conferido (E2E web).' },
      });
      await expectStatus(paid, 200, `POST /platform/invoices/${invoice.id}/mark-paid`);
    }
  }
  await expect
    .poll(async () => (await getJson(api, `/platform/subscriptions/${subscriptionId}`, superadmin.token)).status, {
      message: 'assinatura ativa depois do pagamento registrado',
    })
    .toBe('ACTIVE');
  return { id: created.store.id, slug: created.store.slug, name: created.store.name, subscriptionId };
}

/** Fim do arquivo: anula faturas abertas, cancela a assinatura na hora e desativa a loja (melhor esforço). */
export async function retirePaidStore(api: APIRequestContext, superadmin: Session, store: PaidStore): Promise<void> {
  const headers = bearer(superadmin.token);
  const reason = 'Fim da suíte web do superpainel (E2E).';
  try {
    const res = await api.get(`/platform/subscriptions/${store.subscriptionId}`, { headers });
    if (res.ok()) {
      const detail = await res.json();
      for (const invoice of (detail.invoices ?? []) as Json[]) {
        if (invoice.status === 'OPEN' || invoice.status === 'FAILED') {
          await api.post(`/platform/invoices/${invoice.id}/void`, { headers, data: { reason } });
        }
      }
      if (detail.status !== 'CANCELED') {
        await api.post(`/platform/subscriptions/${store.subscriptionId}/cancel`, { headers, data: { at_period_end: false, reason } });
      }
    }
    await api.post(`/platform/stores/${store.id}/deactivate`, { headers, data: { reason } });
  } catch {
    // limpeza: melhor esforço
  }
}

/** Pedido de retirada pago na retirada, feito pela API na vitrine da loja (/stores/<slug>/orders). */
export async function placeTakeoutOrder(api: APIRequestContext, slug: string, customer: Session, productId: number): Promise<Json> {
  const res = await api.post(`/stores/${slug}/orders`, {
    headers: bearer(customer.token),
    data: { items: [{ productId, quantity: 1 }], type: 'TAKEOUT', paymentMethod: 'MONEY' },
  });
  return expectStatus(res, 201, `POST /stores/${slug}/orders`);
}

// ---------------------------------------------------------------------------
// Interface do superpainel
// ---------------------------------------------------------------------------

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const INTEGER = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

/** 1234.5 → "R$ 1.234,50" (espaço comum: o Playwright normaliza o espaço não separável da página). */
export function brl(value: number): string {
  return BRL.format(value).replace(/\s/g, ' ');
}

/** 1234 → "1.234". */
export function integer(value: number): string {
  return INTEGER.format(value);
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Valor de um cartão de indicador (StatCard): o rótulo vem antes no HTML e o valor é o parágrafo seguinte. */
export function statValue(scope: Locator | Page, label: string): Locator {
  return scope.getByText(label, { exact: true }).locator('xpath=following-sibling::p[1]');
}

/** Toast do react-hot-toast (role="status") com o texto informado (o mais recente). */
export function toast(page: Page, text: string | RegExp): Locator {
  return page.getByRole('status').filter({ hasText: text }).last();
}

/** Espera a resposta de uma chamada da API de teste (método + caminho exato ou regex, sem query). */
export function waitForApi(page: Page, method: string, pathname: string | RegExp): Promise<Response> {
  return page.waitForResponse((res) => {
    if (!res.url().startsWith(API_URL) || res.request().method() !== method) return false;
    const actual = new URL(res.url()).pathname;
    return typeof pathname === 'string' ? actual === pathname : pathname.test(actual);
  });
}

/** Registra as chamadas de escrita (POST/PATCH/PUT/DELETE) feitas à API pela página. */
export function trackApiWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on('request', (req) => {
    if (req.url().startsWith(API_URL) && !['GET', 'OPTIONS', 'HEAD'].includes(req.method())) {
      writes.push(`${req.method()} ${new URL(req.url()).pathname}`);
    }
  });
  return writes;
}

/** Menu lateral (painel da loja e superpainel). */
export function sidebar(page: Page): Locator {
  return page.getByRole('complementary');
}

/** Título principal da página (h1). */
export function pageHeading(page: Page, name?: string | RegExp): Locator {
  return page.getByRole('heading', { level: 1, ...(name ? { name } : {}) });
}
