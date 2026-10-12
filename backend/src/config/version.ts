import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Versão da API lida do package.json do backend.
 * O caminho relativo funciona tanto em src/config (ts-node/jest) quanto em dist/config (build).
 */
function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return process.env.npm_package_version || '0.0.0';
  }
}

export const APP_VERSION = readVersion();
