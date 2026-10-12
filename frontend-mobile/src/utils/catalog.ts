import type Feather from '@expo/vector-icons/Feather';
import type { ComponentProps } from 'react';

export type FeatherIconName = ComponentProps<typeof Feather>['name'];

/** Categorias de produto aceitas pelo backend (enum ProductCategory). */
export const PRODUCT_CATEGORIES = [
  { id: 'hamburgueres', label: 'Lanches', emoji: '🍔', icon: 'coffee' },
  { id: 'combos', label: 'Combos', emoji: '🍟', icon: 'box' },
  { id: 'entradas', label: 'Entradas', emoji: '🧅', icon: 'sunrise' },
  { id: 'acompanhamentos', label: 'Porções', emoji: '🥓', icon: 'hash' },
  { id: 'bebidas', label: 'Bebidas', emoji: '🥤', icon: 'droplet' },
  { id: 'sobremesas', label: 'Sobremesas', emoji: '🍦', icon: 'heart' },
  { id: 'molhos', label: 'Molhos', emoji: '🥣', icon: 'disc' },
  { id: 'adicionais', label: 'Adicionais', emoji: '➕', icon: 'plus-circle' },
] as const satisfies ReadonlyArray<{ id: string; label: string; emoji: string; icon: FeatherIconName }>;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number]['id'];

export function categoryLabel(id?: string | null): string {
  return PRODUCT_CATEGORIES.find((category) => category.id === id)?.label ?? id ?? '';
}

// --- Ponto da carne e observação (mesmas regras do web e da API) ---

/** Só os hambúrgueres têm ponto da carne. */
export const MEAT_POINT_CATEGORY: ProductCategory = 'hamburgueres';
export const MEAT_POINTS = ['Mal Passado', 'Ao Ponto', 'Bem Passado'] as const;
export const DEFAULT_MEAT_POINT = 'Ao Ponto';

/** Tamanho máximo da observação de um item (limite da API). */
export const MAX_OBSERVATION_LENGTH = 300;

export function hasMeatPoint(product: { category?: string | null }): boolean {
  return product.category === MEAT_POINT_CATEGORY;
}

/** Observação pronta para o pedido: sem espaços nas pontas e dentro do limite da API. */
export function normalizeObservation(text?: string | null): string {
  return (text ?? '').trim().slice(0, MAX_OBSERVATION_LENGTH);
}

interface Priced {
  price: number | string;
  promotion_price?: number | string | null;
}

/**
 * Preço cobrado: o promocional quando 0 < promocional < preço cheio (mesma regra do backend).
 * Promocional 0, vazio ou negativo significa "sem promoção" — nunca "grátis".
 */
export function effectivePrice(product: Priced): number {
  const price = Number(product.price) || 0;
  if (product.promotion_price === null || product.promotion_price === undefined || product.promotion_price === '') {
    return price;
  }
  const promotion = Number(product.promotion_price);
  return Number.isFinite(promotion) && promotion > 0 && promotion < price ? promotion : price;
}

export function hasPromotion(product: Priced): boolean {
  return effectivePrice(product) < (Number(product.price) || 0);
}
