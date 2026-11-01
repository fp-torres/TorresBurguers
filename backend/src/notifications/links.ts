import { Logger } from '@nestjs/common';
import { isProduction } from '../config/env';

/** Site (frontend web) padrão do ambiente de desenvolvimento (Vite). */
export const DEFAULT_APP_WEB_URL = 'http://localhost:5173';

const logger = new Logger('Links');
let warned = false;

/**
 * Endereço do site usado nos links enviados por e-mail (convites, redefinição de senha):
 * APP_WEB_URL (ex.: https://app.comestra.com.br), sem barra no fim. Vazio ou inválido → padrão de
 * desenvolvimento, com aviso no log em produção (os links apontariam para a máquina errada).
 */
export function appWebUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.APP_WEB_URL?.trim().replace(/\/+$/, '');
  if (raw && /^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(raw)) return raw;

  if (!warned && (raw || isProduction(env))) {
    warned = true;
    logger.warn(
      `APP_WEB_URL ${raw ? `inválido ("${raw}")` : 'não definido'}: os links de convite e de redefinição de senha usarão ${DEFAULT_APP_WEB_URL}.`,
    );
  }
  return DEFAULT_APP_WEB_URL;
}

/** Link absoluto para uma página do site (ex.: appLink('/convite/abc')). */
export function appLink(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `${appWebUrl(env)}${path.startsWith('/') ? path : `/${path}`}`;
}

// Um aviso por valor inválido (a função é chamada a cada e-mail)
const warnedPublicApiUrls = new Set<string>();

/**
 * Endereço público da API (PUBLIC_API_URL, ex.: https://api.comestra.com.br ou
 * https://comestra.com.br/api), sem barra no fim. É a base das imagens de /uploads nos e-mails (logo da
 * loja), que são abertos fora do site e precisam de um endereço absoluto. Vazio → null: os e-mails saem
 * sem logo. Inválido (sem http:// ou https://, com usuário e senha, ?consulta ou #âncora) → null, com um
 * aviso no log (sem o valor, que poderia trazer uma senha).
 */
export function publicApiUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.PUBLIC_API_URL?.trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (!url.username && !url.password && !url.search && !url.hash) {
        return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
      }
    } catch {
      // inválido: aviso abaixo
    }
  }
  if (!warnedPublicApiUrls.has(raw)) {
    warnedPublicApiUrls.add(raw);
    logger.warn(
      'PUBLIC_API_URL inválido: use o endereço público da API com http:// ou https:// (ex.: https://api.comestra.com.br), sem usuário, senha, ?consulta nem #âncora. Os e-mails sairão sem o logo das lojas.',
    );
  }
  return null;
}
