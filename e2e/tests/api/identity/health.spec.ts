import { test, expect } from '@playwright/test';
import { backendVersion, body } from './helpers';

test.describe('Saúde da API (GET /health)', () => {
  test('é pública e responde só { status: "ok" }: sem o nome do sistema nem a versão do backend', async ({ request }) => {
    const res = await request.get('/health');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/json');

    const payload = await body(res);
    expect(payload).toEqual({ status: 'ok' });
    const text = JSON.stringify(payload);
    expect(text).not.toContain(backendVersion());
    expect(text).not.toMatch(/comestra|version|name/i);
  });

  test('não expõe a marca antiga nem exige token (token inválido é ignorado)', async ({ request }) => {
    const res = await request.get('/health', { headers: { Authorization: 'Bearer token-invalido' } });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(await res.text()).not.toMatch(/torres/i);
  });
});
