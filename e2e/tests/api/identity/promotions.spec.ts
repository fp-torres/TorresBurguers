import { test, expect } from '@playwright/test';
import { bearer, body } from './helpers';

const ALLOWED_KEYS = ['type', 'title', 'message', 'subtitle', 'coupon', 'theme', 'details'];

/** Formato do contrato: {type: 'football' | 'promo', title, message, subtitle?, coupon?, theme?, details?}. */
function expectBannerShape(banner: any): void {
  expect(['football', 'promo']).toContain(banner.type);
  expect(typeof banner.title).toBe('string');
  expect(banner.title.trim().length).toBeGreaterThan(0);
  expect(typeof banner.message).toBe('string');
  expect(banner.message.trim().length).toBeGreaterThan(0);
  for (const key of Object.keys(banner)) expect(ALLOWED_KEYS, `chave inesperada "${key}"`).toContain(key);
  for (const key of ['subtitle', 'coupon', 'theme'] as const) {
    if (banner[key] !== undefined) expect(typeof banner[key], key).toBe('string');
  }
  if (banner.type === 'football') {
    expect(banner.details).toEqual({
      home: expect.any(String),
      away: expect.any(String),
      tournament: expect.any(String),
      time: expect.any(String),
    });
  } else if (banner.details !== undefined) {
    expect(typeof banner.details).toBe('object');
  }
}

test.describe('Banner de promoções (público)', () => {
  test('GET /promotions/banner devolve o banner no formato do contrato', async ({ request }) => {
    const res = await request.get('/promotions/banner');
    expect(res.status()).toBe(200);
    const banner = await res.json();
    expectBannerShape(banner);
    // Contrato v2: o banner não promete descontos nem cupons que o checkout não aplica
    expect(banner.coupon, 'banner sem cupom').toBeUndefined();
    expect(`${banner.title} ${banner.message} ${banner.subtitle ?? ''}`).not.toMatch(/% ?off|grátis|gratis|metade do preço|frete free|cupom/i);
  });

  test('GET /promotions/football (alias) devolve o mesmo banner', async ({ request }) => {
    const [banner, alias] = await Promise.all([request.get('/promotions/banner'), request.get('/promotions/football')]);
    expect(alias.status()).toBe(200);
    const aliasBody = await alias.json();
    expectBannerShape(aliasBody);
    expect(aliasBody).toEqual(await banner.json());
  });

  test('várias consultas simultâneas nunca respondem 5xx', async ({ request }) => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) => request.get(i % 2 ? '/promotions/football' : '/promotions/banner')),
    );
    for (const res of responses) {
      expect(res.status(), JSON.stringify(await body(res))).toBe(200);
    }
  });

  test('é pública: token inválido é ignorado e o texto não cita a marca antiga', async ({ request }) => {
    const res = await request.get('/promotions/banner', { headers: bearer('token-invalido') });
    expect(res.status()).toBe(200);
    expect(await res.text()).not.toMatch(/torres/i);
  });
});
