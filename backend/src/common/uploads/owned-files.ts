import { promises as fs } from 'fs';
import * as path from 'path';
import { uploadsDir } from '../../config/paths';
import { storeStorageUsage } from './storage-usage';
import { storeIdFromPrefix } from './store-files';

/**
 * Fotos de perfil enviadas para uma conta já existente ficam com o prefixo u<userId>- no nome
 * (ex.: u42-compressed-1760000000000-ab12cd34.webp), na mesma pasta plana de /uploads.
 * O prefixo diz de quem é o arquivo: ao trocar a foto, só o arquivo da PRÓPRIA conta é apagado
 * (nunca o de outra conta, loja ou um arquivo sem dono).
 */
export function userFilePrefix(userId: number): string {
  return `u${userId}-`;
}

/** Nome do arquivo em /uploads a partir da referência gravada ("/uploads/<nome>" ou "<nome>"). */
export function uploadedFilename(
  ref: string | null | undefined,
): string | null {
  if (!ref) return null;
  const name = ref.startsWith('/uploads/')
    ? ref.slice('/uploads/'.length)
    : ref;
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.startsWith('.') ? name : null;
}

/**
 * Apaga o arquivo da referência se ele tem o prefixo do dono informado (melhor esforço: arquivo que
 * já não existe ou erro de disco não interrompem a operação). Devolve true quando apagou.
 */
export async function removeOwnedUpload(
  ref: string | null | undefined,
  ownerPrefix: string,
): Promise<boolean> {
  const filename = uploadedFilename(ref);
  if (!filename || !ownerPrefix || !filename.startsWith(ownerPrefix)) {
    return false;
  }
  try {
    await fs.unlink(path.join(uploadsDir(), filename));
  } catch {
    return false;
  }
  // Arquivo de loja apagado: o uso de armazenamento dela é medido de novo na próxima consulta
  const storeId = storeIdFromPrefix(ownerPrefix);
  if (storeId !== null) storeStorageUsage.invalidate(storeId);
  return true;
}
