import { request, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { E2E } from './env';
import { DEFAULT_USERS, type DefaultUserKey } from './users';

/** Resumo da loja na sessão (SessionUser.store): null para clientes e para a administração da plataforma. */
export interface SessionStore {
  id: number;
  slug: string;
  name: string;
  logo: string | null;
  primary_color: string | null;
  account_status: string;
}

export interface Session {
  token: string;
  user: {
    id: number;
    name: string;
    email: string;
    role: string;
    /** Loja da equipe (null para clientes e para o superadmin). */
    store_id?: number | null;
    platform_role?: string | null;
    store?: SessionStore | null;
    [k: string]: unknown;
  };
}

/** Perfil público da loja demo (GET /stores/<slug>): a loja da equipe padrão e a loja padrão das rotas antigas. */
export interface PublicStore {
  id: number;
  slug: string;
  name: string;
  is_open: boolean;
  address: Record<string, string | null>;
  [k: string]: unknown;
}

let demoStorePromise: Promise<PublicStore> | null = null;

/** Loja demo (uma consulta por worker): id, slug, nome e endereço de retirada. */
export function demoStore(): Promise<PublicStore> {
  demoStorePromise ??= (async () => {
    const ctx = await request.newContext({ baseURL: E2E.apiURL });
    try {
      const res = await ctx.get(`/stores/${E2E.demoStoreSlug}`);
      expect(res.ok(), `GET /stores/${E2E.demoStoreSlug}: ${res.status()} ${await res.text()}`).toBeTruthy();
      return (await res.json()) as PublicStore;
    } finally {
      await ctx.dispose();
    }
  })();
  demoStorePromise.catch(() => {
    demoStorePromise = null;
  });
  return demoStorePromise;
}

/** Sufixo único por execução para isolar dados criados pelos testes. */
export function uid(prefix = 'e2e'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function uniqueEmail(prefix = 'cliente'): string {
  return `${uid(prefix)}@e2e.test`;
}

/** Lê o corpo como JSON quando possível (útil em mensagens de falha). */
export async function body(res: APIResponse): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function login(api: APIRequestContext, email: string, password: string): Promise<Session> {
  const res = await api.post(`${E2E.apiURL}/auth/login`, { data: { email, password } });
  expect(res.ok(), `login ${email}: ${res.status()} ${await res.text()}`).toBeTruthy();
  const data = await res.json();
  return { token: data.access_token, user: data.user };
}

export async function loginAs(api: APIRequestContext, key: DefaultUserKey): Promise<Session> {
  const u = DEFAULT_USERS[key];
  return login(api, u.email, u.password);
}

/** Contexto HTTP já autenticado (Authorization: Bearer). Lembre de chamar dispose(). */
export async function authedContext(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: E2E.apiURL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

export async function contextAs(key: DefaultUserKey): Promise<{ ctx: APIRequestContext; session: Session }> {
  const anon = await request.newContext({ baseURL: E2E.apiURL });
  const session = await loginAs(anon, key);
  await anon.dispose();
  return { ctx: await authedContext(session.token), session };
}

/** Cadastra um cliente novo pelo endpoint público e devolve a sessão dele. */
export async function signupClient(
  api: APIRequestContext,
  overrides: Partial<{ name: string; email: string; password: string; phone: string }> = {},
): Promise<Session & { password: string }> {
  const data = {
    name: 'Cliente E2E',
    email: uniqueEmail(),
    password: 'SenhaForte@123',
    phone: '21988887777',
    ...overrides,
  };
  const res = await api.post(`${E2E.apiURL}/users`, { data });
  expect(res.ok(), `signup: ${res.status()} ${await res.text()}`).toBeTruthy();
  const session = await login(api, data.email, data.password);
  return { ...session, password: data.password };
}
