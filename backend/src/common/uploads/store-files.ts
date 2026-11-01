/**
 * Arquivos enviados por uma loja (produtos, adicionais, logo) ficam na mesma pasta de uploads,
 * com o prefixo s<storeId>- no nome (ex.: s12-compressed-1760000000000-ab12cd34.webp).
 * A pasta continua plana: o contrato /uploads/<arquivo> (web e app mobile) não muda, e a loja
 * só pode referenciar os próprios arquivos.
 */
export function storeFilePrefix(storeId: number): string {
  return `s${storeId}-`;
}

/**
 * Loja dona de um prefixo gerado por storeFilePrefix ("s12-" → 12); null para qualquer outro prefixo
 * (fotos de perfil "u<id>-", sem prefixo...). Usado para saber se uma imagem gravada conta na cota da loja.
 */
export function storeIdFromPrefix(
  prefix: string | null | undefined,
): number | null {
  const match = /^s(\d{1,10})-$/.exec(prefix ?? '');
  const id = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Nome de arquivo (sem pasta) gerado para a loja informada. */
export function isStoreFile(filename: string, storeId: number): boolean {
  return (
    /^[A-Za-z0-9._-]+$/.test(filename) &&
    filename.startsWith(storeFilePrefix(storeId))
  );
}

/** Arquivo gerado para alguma loja (s<número>-...). */
export function isAnyStoreFile(filename: string): boolean {
  return /^s\d+-[A-Za-z0-9._-]+$/.test(filename);
}

/** URL absoluta https:// com servidor (imagem hospedada fora da API). */
export function isHttpsUrl(value: string): boolean {
  if (!/^https:\/\/\S+$/i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Referência de imagem que um cadastro da loja (produto, adicional) pode gravar:
 * - arquivo enviado pela própria loja (prefixo s<storeId>-);
 * - URL https:// externa;
 * - o valor que o próprio registro já tinha (`current`): imagens antigas, de antes do prefixo
 *   por loja, continuam válidas enquanto não forem trocadas.
 * Arquivo de outra loja ou sem dono, http:// e caminhos são recusados: uma loja nunca aponta
 * para a imagem de outra.
 */
export function isAllowedStoreImageRef(
  ref: string,
  storeId: number,
  current?: string | null,
): boolean {
  if (current !== undefined && current !== null && ref === current) {
    return true;
  }
  return isStoreFile(ref, storeId) || isHttpsUrl(ref);
}
