import { STORAGE_KEYS } from '../config/brand';

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
