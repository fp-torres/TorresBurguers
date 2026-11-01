import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { BRAND } from '../config/brand';
import { safeForLog } from '../common/uploads/safe-log';
import { Store } from '../store/entities/store.entity';
import { publicApiUrl } from './links';

/**
 * Cor principal da plataforma (o laranja da Comestra), a mesma de frontend-web/src/config/brand.ts
 * (BRAND.color) e do tema do site. Vale nos e-mails da plataforma e nos de lojas sem cor própria.
 */
export const PLATFORM_MAIL_COLOR = '#ea580c';

/** Texto escuro usado sobre cores claras (o mesmo da vitrine: --store-brand-contrast). */
export const MAIL_DARK_TEXT = '#111827';

const WHITE = '#ffffff';

/**
 * Identidade visual de um e-mail:
 * - `platform`: e-mails da Comestra (e-mail de teste, contas de clientes e da plataforma);
 * - `store`: e-mails de uma loja (convite para a equipe, redefinição de senha da equipe), com o nome,
 *   a cor principal e o logo da loja.
 */
export interface MailBrand {
  scope: 'platform' | 'store';
  /** Nome exibido no cabeçalho. */
  name: string;
  /** Cor principal #rrggbb, já validada. */
  color: string;
  /** URL absoluta do logo (só com PUBLIC_API_URL; ver storeLogoUrl) ou null. */
  logoUrl: string | null;
}

/** Campos da loja usados na marca do e-mail. */
export type StoreBrandSource = Pick<Store, 'name'> &
  Partial<Pick<Store, 'logo' | 'primary_color'>>;

/** Marca da plataforma (backend/src/config/brand.ts): nome, laranja da Comestra e monograma, sem logo. */
export function platformMailBrand(): MailBrand {
  return {
    scope: 'platform',
    name: BRAND.name,
    color: PLATFORM_MAIL_COLOR,
    logoUrl: null,
  };
}

/** Ponto entre as partes de um endereço ("loja.com", "www.x", "a@b.com"): seguido de 2+ letras. */
const DOMAIN_DOT = /(?<=[\p{L}\p{N}_-])\.(?=\p{L}{2})/gu;

/**
 * "Desarma" endereços num texto escolhido pela loja (o nome dela): os programas de e-mail transformam
 * "dominio.com" e "https://..." em links clicáveis, e o nome da loja vai no assunto e no corpo de
 * e-mails enviados pela plataforma (convites a qualquer endereço). O ponto de um domínio vira "[.]" e
 * "://" vira "[:]//" (a forma usual de neutralizar endereços); nomes comuns ("Sr. Burger 2.0") não mudam.
 */
export function defangLinks(text: string): string {
  return text.replace(/:\/\//g, '[:]//').replace(DOMAIN_DOT, '[.]');
}

/**
 * Marca de uma loja: nome (sem endereços clicáveis: defangLinks), cor principal (#RRGGBB válida; senão,
 * a da plataforma) e logo. O logo só entra com PUBLIC_API_URL definido (a imagem precisa de um endereço
 * público e absoluto).
 */
export function storeMailBrand(
  store: StoreBrandSource,
  env: NodeJS.ProcessEnv = process.env,
): MailBrand {
  return {
    scope: 'store',
    name: defangLinks(store.name?.trim() ?? '') || BRAND.name,
    color: normalizeHexColor(store.primary_color) ?? PLATFORM_MAIL_COLOR,
    logoUrl: storeLogoUrl(store.logo, env),
  };
}

/** Nome de arquivo em /uploads: letras, números, ponto, hífen e sublinhado, sem pasta nem "." no início. */
const UPLOAD_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * URL pública do logo da loja: PUBLIC_API_URL + /uploads/<arquivo>. Aceita o que o cadastro grava
 * ("<arquivo>", "/uploads/<arquivo>" ou "uploads/<arquivo>"). Sem PUBLIC_API_URL, sem logo, ou com
 * outra coisa gravada (URL externa, caminho com pastas) → null: o e-mail não carrega imagens de terceiros.
 */
export function storeLogoUrl(
  logo: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = logo?.trim();
  if (!value) return null;
  const base = publicApiUrl(env);
  if (!base) return null;
  const file = value.replace(/^\/+/, '').replace(/^uploads\//, '');
  return UPLOAD_FILE.test(file) ? `${base}/uploads/${file}` : null;
}

const logger = new Logger('MailBrand');

/**
 * Marca da loja lida do banco (nome, cor e logo). Loja inexistente ou erro na consulta → marca da
 * plataforma, com aviso no log: a marca nunca impede o envio.
 */
export async function loadStoreMailBrand(
  manager: Pick<EntityManager, 'findOne'>,
  storeId: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MailBrand> {
  try {
    const store = await manager.findOne(Store, {
      where: { id: storeId },
      select: { id: true, name: true, logo: true, primary_color: true },
    });
    return store ? storeMailBrand(store, env) : platformMailBrand();
  } catch (error) {
    logger.warn(
      `Marca da loja #${storeId} indisponível para o e-mail (${safeForLog((error as Error)?.message ?? error, 200)}): usando a da plataforma.`,
    );
    return platformMailBrand();
  }
}

/**
 * Marca dos e-mails de uma conta: a da loja para a equipe (store_id preenchido); a da plataforma para
 * clientes (conta global) e para o superadmin.
 */
export function mailBrandForAccount(
  manager: Pick<EntityManager, 'findOne'>,
  storeId: number | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MailBrand> {
  return storeId
    ? loadStoreMailBrand(manager, storeId, env)
    : Promise.resolve(platformMailBrand());
}

// ---------------------------------------------------------------------------
// Cores (mesmas regras da vitrine: frontend-web/src/services/storefrontDisplay.ts → brandCssVariables)
// ---------------------------------------------------------------------------

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Cor #RRGGBB válida (em minúsculas) ou null. Qualquer outra coisa nunca chega ao estilo do e-mail. */
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return HEX_COLOR.test(trimmed) ? trimmed.toLowerCase() : null;
}

type Rgb = [number, number, number];

const BLACK_RGB: Rgb = [0, 0, 0];

function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

/** Mistura duas cores (t = 0 → a; t = 1 → b). */
function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [0, 1, 2].map((index) => a[index] + (b[index] - a[index]) * t) as Rgb;
}

/** Luminância relativa (WCAG). */
function luminance([r, g, b]: Rgb): number {
  const linear = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** Contraste WCAG entre duas cores #rrggbb (1 a 21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(hexToRgb(a));
  const lb = luminance(hexToRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Escurece a cor aos poucos até atingir o contraste mínimo com o fundo. */
function darkenForContrast(
  base: Rgb,
  background: string,
  minimum: number,
): string {
  for (let step = 0; step <= 20; step++) {
    const candidate = rgbToHex(mix(base, BLACK_RGB, step / 20));
    if (contrastRatio(candidate, background) >= minimum) return candidate;
  }
  return rgbToHex(BLACK_RGB);
}

/** Cores do e-mail derivadas da cor da marca, todas com contraste AA (4,5:1) onde há texto. */
export interface MailPalette {
  /** Faixa decorativa do topo: a cor da marca como está (sem texto em cima). */
  accent: string;
  /** Fundo do botão e do monograma. */
  button: string;
  /** Texto sobre `button`. */
  buttonText: string;
  /** Links sobre o fundo branco. */
  link: string;
}

/**
 * Cores escuras ou médias (contraste ≥ 3 com o branco, como o laranja da plataforma): botão com texto
 * branco, na cor da marca escurecida só o necessário para 4,5:1. Cores claras (amarelo, verde-limão...):
 * botão na própria cor, com texto escuro (sempre ≥ 5,9:1). Links: a cor escurecida até 4,5:1 no branco.
 */
export function mailPalette(color: string): MailPalette {
  const hex = normalizeHexColor(color) ?? PLATFORM_MAIL_COLOR;
  const ink = darkenForContrast(hexToRgb(hex), WHITE, 4.5);
  const light = contrastRatio(hex, WHITE) < 3;
  return {
    accent: hex,
    button: light ? hex : ink,
    buttonText: light ? MAIL_DARK_TEXT : WHITE,
    link: ink,
  };
}
