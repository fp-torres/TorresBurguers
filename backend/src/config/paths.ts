import { join, resolve } from 'path';

/**
 * Pasta onde as imagens enviadas são gravadas e servidas em /uploads.
 * Configurável via UPLOADS_DIR (ex.: volume persistente em produção ou pasta isolada nos testes E2E).
 */
export function uploadsDir(): string {
  return resolve(process.env.UPLOADS_DIR || join(process.cwd(), 'uploads'));
}
