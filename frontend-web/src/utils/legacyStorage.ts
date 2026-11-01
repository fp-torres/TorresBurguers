import { STORAGE_KEYS } from '../config/brand';
import { getApiErrorStatus } from '../services/api';
import { publicStoreService } from '../services/publicStoreService';
import { mergeCartItems, readCart, sanitizeCartItems, writeCart, type CartItem } from '../contexts/cartStorage';

/**
 * Prefixo das chaves do navegador gravadas pelas versões anteriores à renomeação do produto.
 * Existe só para a migração abaixo; nenhuma tela usa estas chaves.
 */
const LEGACY_PREFIX = 'torresburgers';

/**
 * Migração única das chaves antigas do localStorage, feita antes de o app ler o armazenamento:
 * - carrinho e tema vão para as chaves novas (se elas ainda não existirem);
 * - token e usuário antigos são apagados (o usuário antigo podia conter password_hash).
 * Rodar de novo não faz nada, então não precisa de marcador.
 * O carrinho da versão de loja única ("comestra.cart") vai para a loja padrão em migrateLegacyCart.
 */
export function migrateLegacyStorage(): void {
  try {
    for (const key of ['cart', 'theme'] as const) {
      const legacyKey = `${LEGACY_PREFIX}.${key}`;
      const legacyValue = localStorage.getItem(legacyKey);
      if (legacyValue === null) continue;
      if (localStorage.getItem(STORAGE_KEYS[key]) === null) localStorage.setItem(STORAGE_KEYS[key], legacyValue);
      localStorage.removeItem(legacyKey);
    }
    localStorage.removeItem(`${LEGACY_PREFIX}.token`);
    localStorage.removeItem(`${LEGACY_PREFIX}.user`);
  } catch {
    // Armazenamento bloqueado ou cheio: o app segue com as chaves novas
  }
}

// --- LOJA PADRÃO (a das rotas e dos dados da versão de loja única) ---

let defaultStoreLookup: Promise<number | null> | null = null;

/**
 * Id da loja padrão (GET /stores/default), consultado no máximo uma vez por visita.
 * null se a plataforma não tiver loja padrão (404). Falha de rede: tenta de novo na próxima chamada.
 */
export function defaultStoreId(): Promise<number | null> {
  defaultStoreLookup ??= publicStoreService
    .getDefault()
    .then((store) => store.id)
    .catch((error: unknown) => {
      if (getApiErrorStatus(error) !== 404) defaultStoreLookup = null;
      return null;
    });
  return defaultStoreLookup;
}

/** A loja é a loja padrão (a dona dos dados guardados pela versão de loja única)? */
export async function isDefaultStore(storeId: number): Promise<boolean> {
  return (await defaultStoreId()) === storeId;
}

// --- CARRINHO DA VERSÃO DE LOJA ÚNICA ---

function hasLegacyCart(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEYS.cart) !== null;
  } catch {
    return false;
  }
}

/** Itens do carrinho antigo (lista); null se não houver. Valor que não é uma lista é descartado. */
function readLegacyCartItems(): CartItem[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.cart);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return sanitizeCartItems(parsed);
  } catch {
    // JSON inválido: descartado abaixo
  }
  try {
    localStorage.removeItem(STORAGE_KEYS.cart);
  } catch {
    // Armazenamento bloqueado: nada a remover
  }
  return null;
}

/** Migrações em andamento por loja: chamadas simultâneas (ex.: efeito repetido do StrictMode) recebem o mesmo resultado. */
const runningMigrations = new Map<number, Promise<CartItem[] | null>>();

/**
 * Carrinho da versão de loja única ("comestra.cart", uma lista de itens): pertence à loja que virou a
 * loja padrão. Na primeira visita a ela, os itens passam para o carrinho da loja e a chave antiga é
 * removida. Idempotente: itens já presentes (mesmo cartId) não são duplicados, inclusive com duas abas
 * migrando ao mesmo tempo; sem carrinho antigo (ou em outra loja), não faz nada.
 * Devolve o carrinho da loja depois da migração, ou null se nada mudou.
 */
export function migrateLegacyCart(store: { id: number; slug: string }): Promise<CartItem[] | null> {
  const running = runningMigrations.get(store.id);
  if (running) return running;
  const migration = runLegacyCartMigration(store).finally(() => runningMigrations.delete(store.id));
  runningMigrations.set(store.id, migration);
  return migration;
}

async function runLegacyCartMigration(store: { id: number; slug: string }): Promise<CartItem[] | null> {
  if (!hasLegacyCart()) return null;
  if (!(await isDefaultStore(store.id))) return null;

  // Lido de novo depois da consulta: outra aba pode ter migrado enquanto isso
  const legacy = readLegacyCartItems();
  if (legacy === null) return null;

  const merged = mergeCartItems(readCart(store.id), legacy);
  writeCart(store.id, store.slug, merged);
  try {
    localStorage.removeItem(STORAGE_KEYS.cart);
  } catch {
    // Armazenamento bloqueado: a próxima visita tenta de novo (sem duplicar itens)
  }
  return merged;
}
