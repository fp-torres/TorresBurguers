import { test, expect } from '@playwright/test';
import { backendVersion, body } from './helpers';

test.describe('Saúde da API (GET /health)', () => {
  test('é pública e responde status ok, o nome Comestra e a versão do backend', async ({ request }) => {
    const res = await request.get('/health');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/json');

    const payload = await body(res);
    expect(payload).toEqual({ status: 'ok', name: 'Comestra', version: backendVersion() });
    expect(payload.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('não expõe a marca antiga nem exige token (token inválido é ignorado)', async ({ request }) => {
    const res = await request.get('/health', { headers: { Authorization: 'Bearer token-invalido' } });
    expect(res.status()).toBe(200);
    expect(await res.text()).not.toMatch(/torres/i);
  });
});
