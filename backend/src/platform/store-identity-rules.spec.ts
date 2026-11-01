import {
  CUSTOM_DOMAIN_FORMAT_MESSAGE,
  customDomainError,
  isReservedStoreSlug,
  normalizeCustomDomain,
  normalizeSlugInput,
  RESERVED_STORE_SLUGS,
  SLUG_FORMAT_MESSAGE,
  SLUG_RESERVED_MESSAGE,
  storeSlugError,
} from './store-identity-rules';

describe('store-identity-rules', () => {
  describe('slug da loja', () => {
    it('aceita minúsculas, números e hífens (3 a 60 caracteres)', () => {
      for (const slug of [
        'abc',
        'lanchonete-do-bairro',
        'pizzaria-2',
        '123',
        `a${'b'.repeat(58)}c`,
      ]) {
        expect(storeSlugError(slug)).toBeNull();
      }
    });

    it('recusa formato inválido (o mesmo do roteamento /stores/:storeSlug)', () => {
      for (const slug of [
        '',
        'ab',
        '-abc',
        'abc-',
        'Abc',
        'loja legal',
        'café',
        'loja_1',
        'loja/1',
        `a${'b'.repeat(59)}c`,
        42,
        null,
        undefined,
      ]) {
        expect(storeSlugError(slug)).toBe(SLUG_FORMAT_MESSAGE);
      }
    });

    it('recusa todos os endereços reservados', () => {
      const required = [
        'admin',
        'api',
        'platform',
        'plataforma',
        'www',
        'app',
        'loja',
        'lojas',
        'login',
        'signin',
        'signup',
        'static',
        'assets',
        'uploads',
        'health',
        'stores',
        'store',
        'default',
        'cadastrar-loja',
        'convite',
        'redefinir-senha',
        'esqueci-senha',
        'my-orders',
        'profile',
        'cart',
        'dashboard',
        'orders',
        'products',
        'users',
        'trash',
        'settings',
        'customers',
        'subscription',
        'public',
        'billing',
        'plans',
      ];
      expect([...RESERVED_STORE_SLUGS].sort()).toEqual([...required].sort());
      for (const slug of required) {
        expect(isReservedStoreSlug(slug)).toBe(true);
        expect(storeSlugError(slug)).toBe(SLUG_RESERVED_MESSAGE);
      }
      // Parecido com um reservado, mas não igual
      expect(storeSlugError('admin-loja')).toBeNull();
      expect(storeSlugError('default-2')).toBeNull();
    });

    it('a entrada é normalizada só nas pontas e na caixa', () => {
      expect(normalizeSlugInput('  Minha-Loja ')).toBe('minha-loja');
      expect(normalizeSlugInput(10)).toBe(10);
    });
  });

  describe('domínio próprio', () => {
    it('aceita hostnames válidos (inclusive punycode)', () => {
      for (const host of [
        'minhaloja.com.br',
        'pedidos.minhaloja.com.br',
        'loja-1.example.store',
        'xn--caf-dma.com',
        'a.co',
      ]) {
        expect(customDomainError(host)).toBeNull();
      }
    });

    it('recusa protocolo, caminho, porta, IP, espaços e rótulos inválidos', () => {
      for (const host of [
        'https://minhaloja.com.br',
        'minhaloja.com.br/loja',
        'minhaloja.com.br:8080',
        '192.168.0.1',
        'localhost',
        'minha loja.com',
        '-loja.com',
        'loja-.com',
        'loja..com',
        'loja.c',
        'loja.123',
        `${'a'.repeat(64)}.com`,
        `${'a.'.repeat(130)}com`,
        '',
        null,
        7,
      ]) {
        expect(customDomainError(host)).toBe(CUSTOM_DOMAIN_FORMAT_MESSAGE);
      }
    });

    it('normaliza caixa, espaços e o ponto final; vazio ou "null" remove', () => {
      expect(normalizeCustomDomain('  Pedidos.MinhaLoja.com.br. ')).toBe(
        'pedidos.minhaloja.com.br',
      );
      expect(normalizeCustomDomain('')).toBeNull();
      expect(normalizeCustomDomain('null')).toBeNull();
      expect(normalizeCustomDomain(null)).toBeNull();
      expect(normalizeCustomDomain(undefined)).toBeUndefined();
    });
  });
});
