import { test as setup, expect } from '@playwright/test';
import { contextAs, demoStore, loginAs } from '../support/api';
import { E2E } from '../support/env';
import { DEFAULT_USERS, type DefaultUserKey } from '../support/users';

/** Equipe padrão: pertence à loja demo. Cliente e superadmin são contas globais (sem loja). */
const STAFF_KEYS: DefaultUserKey[] = ['admin', 'kitchen', 'courier', 'employee'];

setup('usuários padrão conseguem entrar (um por perfil) e a equipe pertence à loja demo', async ({ request }) => {
  const store = await demoStore();
  expect(store.slug).toBe(E2E.demoStoreSlug);

  for (const key of Object.keys(DEFAULT_USERS) as DefaultUserKey[]) {
    const session = await loginAs(request, key);
    expect(session.user.role, `perfil de ${key}`).toBe(DEFAULT_USERS[key].role);

    if (STAFF_KEYS.includes(key)) {
      expect(session.user.store_id, `${key} pertence à loja demo`).toBe(store.id);
      expect(session.user.store, `${key}: resumo da loja na sessão`).toMatchObject({ id: store.id, slug: E2E.demoStoreSlug });
      expect(session.user.platform_role ?? null, `${key} não tem papel na plataforma`).toBeNull();
    } else {
      expect(session.user.store_id ?? null, `${key} não pertence a nenhuma loja`).toBeNull();
      expect(session.user.store ?? null, `${key}: sessão sem loja`).toBeNull();
    }
  }

  const superadmin = await loginAs(request, 'superadmin');
  expect(superadmin.user.platform_role, 'superadmin da plataforma').toBe('SUPER_ADMIN');
  const client = await loginAs(request, 'client');
  expect(client.user.platform_role ?? null).toBeNull();
});

setup('loja demo aberta para receber pedidos', async ({ request }) => {
  const { ctx } = await contextAs('admin');
  const res = await ctx.patch('/store/status', { data: { is_open: true } });
  expect(res.ok(), await res.text()).toBeTruthy();
  const status = await (await ctx.get('/store/status')).json();
  expect(status.is_open).toBe(true);
  await ctx.dispose();

  // A vitrine da loja demo (rota por loja) e as rotas antigas (loja padrão) enxergam a mesma loja aberta
  const store = await demoStore();
  const publicStatus = await (await request.get(`${E2E.apiURL}/stores/${E2E.demoStoreSlug}/status`)).json();
  expect(publicStatus).toMatchObject({ id: store.id, is_open: true });
  const legacyStatus = await (await request.get(`${E2E.apiURL}/store/status`)).json();
  expect(legacyStatus).toMatchObject({ id: store.id, is_open: true });
});
