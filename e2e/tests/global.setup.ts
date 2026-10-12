import { test as setup, expect } from '@playwright/test';
import { contextAs, loginAs } from '../support/api';
import { DEFAULT_USERS, type DefaultUserKey } from '../support/users';

setup('usuários padrão conseguem entrar (um por perfil)', async ({ request }) => {
  for (const key of Object.keys(DEFAULT_USERS) as DefaultUserKey[]) {
    const session = await loginAs(request, key);
    expect(session.user.role, `perfil de ${key}`).toBe(DEFAULT_USERS[key].role);
  }
});

setup('loja aberta para receber pedidos', async () => {
  const { ctx } = await contextAs('admin');
  const res = await ctx.patch('/store/status', { data: { is_open: true } });
  expect(res.ok(), await res.text()).toBeTruthy();
  const status = await (await ctx.get('/store/status')).json();
  expect(status.is_open).toBe(true);
  await ctx.dispose();
});
