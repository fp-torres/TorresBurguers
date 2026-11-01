import { Logger } from '@nestjs/common';
import { BRAND } from '../config/brand';
import { appWebUrl } from './links';
import { MAIL_DARK_TEXT, type MailBrand, mailPalette } from './mail-brand';

/**
 * Montagem dos e-mails transacionais em duas versões, texto e HTML (multipart/alternative):
 *
 * - HTML compatível com clientes de e-mail: tabelas, estilos inline (o <style> do cabeçalho só melhora
 *   o celular), sem scripts, fontes, folhas de estilo ou imagens externas; a única imagem possível é o
 *   logo da loja (ver mail-brand.ts → storeLogoUrl). Largura máxima de 600 px, fluida no celular.
 * - Acessível: lang pt-BR, tabelas de layout com role="presentation", título <h1>, texto de 16 px,
 *   contraste AA nas cores derivadas da marca, link também escrito por extenso.
 * - Seguro: todo texto (nomes de pessoas e de lojas inclusive) passa por singleLine + escapeHtml; os
 *   únicos links são os do próprio site (APP_WEB_URL), conferidos por safeAppLink.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Texto pronto para o HTML (conteúdo ou atributo entre aspas): nenhuma marcação vinda dos dados. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

// Caracteres trocados por espaço: controles C0/C1 e DEL, separadores de linha Unicode (U+2028 e U+2029)
// e marcas de direção (U+200E, U+200F, U+202A a U+202E, U+2066 a U+2069), que invertem o texto exibido
const UNSAFE_CHARS = new RegExp(
  `[${(
    [
      [0x00, 0x1f],
      [0x7f, 0x9f],
      [0x2028, 0x2029],
      [0x200e, 0x200f],
      [0x202a, 0x202e],
      [0x2066, 0x2069],
    ] as const
  )
    .map(
      ([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`,
    )
    .join('')}]+`,
  'g',
);

/** Texto em uma linha: sem caracteres de controle nem marcas de direção, com os espaços reduzidos. */
export function singleLine(value: string): string {
  return value.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

/** Assunto enviado: "[Comestra] <assunto>", em uma linha (é também o <title> do HTML). */
export function brandedSubject(subject: string): string {
  return singleLine(`[${BRAND.name}] ${subject}`);
}

const logger = new Logger('MailLayout');

/**
 * Link permitido num e-mail: http(s) do próprio site (APP_WEB_URL: mesma origem e dentro do caminho
 * base dele), sem usuário e senha. Devolve a forma normalizada (a que o navegador abriria) ou null.
 */
export function safeAppLink(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  let target: URL;
  let site: URL;
  try {
    target = new URL(url.trim());
    site = new URL(appWebUrl(env));
  } catch {
    return null;
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return null;
  if (target.username || target.password) return null;
  if (target.origin !== site.origin) return null;
  const basePath = site.pathname.replace(/\/+$/, '');
  if (
    basePath &&
    target.pathname !== basePath &&
    !target.pathname.startsWith(`${basePath}/`)
  ) {
    return null;
  }
  return target.href;
}

/** Botão com o link principal do e-mail. */
export interface MailAction {
  /** Texto do botão (versão HTML). */
  label: string;
  /** Página do site (APP_WEB_URL); qualquer outro endereço é descartado (ver safeAppLink). */
  url: string;
}

/** Conteúdo de um e-mail, em texto puro (mail-templates.ts): a montagem escapa tudo. */
export interface MailContent {
  /** Assunto, sem o prefixo "[Comestra]" (acrescentado no envio). */
  subject: string;
  /** Resumo que a caixa de entrada mostra ao lado do assunto (oculto na mensagem). */
  preview: string;
  /** Título da mensagem (só no HTML: no texto, o assunto já diz). */
  heading: string;
  greeting?: string;
  /** Parágrafos antes do link. */
  paragraphs: string[];
  action?: MailAction;
  /** Observação logo depois do link (validade, uso único). */
  actionNote?: string;
  /** Parágrafos finais. */
  closing?: string[];
}

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

/** No lugar de um link recusado por safeAppLink (erro de programação: os links vêm de appLink). */
export const MISSING_LINK_TEXT =
  'O link não pôde ser incluído nesta mensagem. Peça um novo link.';

/** Monta o assunto e as versões em texto e HTML de um e-mail com a marca informada. */
export function renderMail(
  content: MailContent,
  brand: MailBrand,
  env: NodeJS.ProcessEnv = process.env,
): RenderedMail {
  let link: string | null = null;
  if (content.action) {
    link = safeAppLink(content.action.url, env);
    if (!link) {
      logger.error(
        `Link fora do site (APP_WEB_URL) descartado do e-mail "${singleLine(content.subject)}".`,
      );
    }
  }
  return {
    subject: singleLine(content.subject),
    text: renderText(content, brand, link),
    html: renderHtml(content, brand, link),
  };
}

function footerText(brand: MailBrand): string {
  return brand.scope === 'store'
    ? `Mensagem automática enviada pela ${BRAND.name} em nome de ${brand.name}. Não é preciso respondê-la.`
    : `Mensagem automática da ${BRAND.name}. Não é preciso respondê-la.`;
}

function renderText(
  content: MailContent,
  brand: MailBrand,
  link: string | null,
): string {
  const blocks: Array<string | undefined> = [content.greeting];
  blocks.push(...content.paragraphs);
  if (content.action) {
    blocks.push(link ?? MISSING_LINK_TEXT);
    if (link) blocks.push(content.actionNote);
  } else {
    blocks.push(content.actionNote);
  }
  blocks.push(...(content.closing ?? []));
  const body = blocks
    .map((block) => (block ? singleLine(block) : ''))
    .filter(Boolean)
    .join('\n\n');
  // "-- " (com o espaço) é o separador de assinatura reconhecido pelos programas de e-mail
  return `${body}\n\n-- \n${singleLine(footerText(brand))}\n`;
}

const FONT =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";

/** Cores fixas do layout (contraste AA: texto ≥ 7:1 no branco; rodapé ≈ 7:1 no cinza da página). */
const COLORS = {
  page: '#f4f4f5',
  card: '#ffffff',
  border: '#e4e4e7',
  heading: MAIL_DARK_TEXT,
  text: '#1f2937',
  muted: '#4b5563',
  footer: '#52525b',
};

/** Primeira letra ou algarismo do nome (monograma quando não há logo). */
function initialOf(name: string): string {
  const letter = /[\p{L}\p{N}]/u.exec(name)?.[0];
  return (letter ?? Array.from(name.trim())[0] ?? '•').toLocaleUpperCase(
    'pt-BR',
  );
}

function renderHtml(
  content: MailContent,
  brand: MailBrand,
  link: string | null,
): string {
  const palette = mailPalette(brand.color);
  const text = (value: string) => escapeHtml(singleLine(value));
  const paragraph = (value: string) =>
    `<p style="margin:0 0 16px 0;${FONT}font-size:16px;line-height:24px;color:${COLORS.text};">${text(value)}</p>`;
  const note = (value: string, margin = '0 0 16px 0') =>
    `<p style="margin:${margin};${FONT}font-size:14px;line-height:20px;color:${COLORS.muted};">${text(value)}</p>`;
  const title = text(brandedSubject(content.subject));
  const name = text(brand.name);

  const mark = brand.logoUrl
    ? `<img src="${escapeHtml(brand.logoUrl)}" width="48" alt="" style="display:block;width:auto;height:auto;max-width:48px;max-height:48px;border:0;outline:none;text-decoration:none;border-radius:10px;">`
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="48" height="48" align="center" valign="middle" bgcolor="${palette.button}" aria-hidden="true" style="width:48px;height:48px;border-radius:10px;background-color:${palette.button};${FONT}font-size:22px;line-height:48px;font-weight:700;color:${palette.buttonText};text-align:center;">${escapeHtml(initialOf(brand.name))}</td></tr></table>`;

  const body: string[] = [
    `<h1 style="margin:0 0 16px 0;${FONT}font-size:22px;line-height:30px;font-weight:700;color:${COLORS.heading};">${text(content.heading)}</h1>`,
  ];
  if (content.greeting) body.push(paragraph(content.greeting));
  body.push(...content.paragraphs.map(paragraph));

  let fallback = '';
  if (content.action && link) {
    const href = escapeHtml(link);
    body.push(
      `<table role="presentation" class="mail-button" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px 0;border-collapse:separate;"><tr><td align="center" bgcolor="${palette.button}" style="border-radius:8px;background-color:${palette.button};mso-padding-alt:12px 28px;"><a href="${href}" style="display:inline-block;padding:12px 28px;${FONT}font-size:16px;line-height:20px;font-weight:700;color:${palette.buttonText};text-decoration:none;border-radius:8px;">${text(content.action.label)}</a></td></tr></table>`,
    );
    if (content.actionNote) body.push(note(content.actionNote));
    fallback =
      `<tr><td class="mail-pad" style="padding:0 32px 28px 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${COLORS.border};padding-top:16px;">` +
      note(
        'Se o botão não funcionar, copie e cole este endereço no navegador:',
        '0 0 4px 0',
      ) +
      `<p style="margin:0;${FONT}font-size:14px;line-height:20px;word-break:break-all;"><a href="${href}" style="color:${palette.link};text-decoration:underline;word-break:break-all;">${href}</a></p>` +
      '</td></tr></table></td></tr>';
  } else if (content.action) {
    body.push(paragraph(MISSING_LINK_TEXT));
  } else if (content.actionNote) {
    body.push(note(content.actionNote));
  }
  body.push(...(content.closing ?? []).map(paragraph));

  return [
    '<!DOCTYPE html>',
    '<html lang="pt-BR" dir="ltr" xmlns="http://www.w3.org/1999/xhtml">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta http-equiv="X-UA-Compatible" content="IE=edge">',
    '<meta name="x-apple-disable-message-reformatting">',
    '<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">',
    '<meta name="color-scheme" content="light">',
    '<meta name="supported-color-schemes" content="light">',
    `<title>${title}</title>`,
    '<!--[if mso]><style>table,td,div,h1,p,a{font-family:Arial,Helvetica,sans-serif !important;}</style><![endif]-->',
    '<style>',
    ':root{color-scheme:light;supported-color-schemes:light;}',
    'body{margin:0;padding:0;width:100%;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}',
    '@media only screen and (max-width:620px){.mail-outer{padding:16px 8px !important;}.mail-pad{padding-left:20px !important;padding-right:20px !important;}.mail-button{width:100% !important;}.mail-button a{display:block !important;}}',
    '</style>',
    '</head>',
    `<body style="margin:0;padding:0;width:100%;background-color:${COLORS.page};">`,
    `<div role="article" aria-roledescription="email" aria-label="${title}" lang="pt-BR" dir="ltr" style="background-color:${COLORS.page};">`,
    `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${text(content.preview)}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.page}" style="width:100%;background-color:${COLORS.page};">`,
    '<tr><td align="center" class="mail-outer" style="padding:32px 16px;">',
    '<!--[if mso]><table role="presentation" align="center" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.card}" style="width:100%;max-width:600px;background-color:${COLORS.card};border:1px solid ${COLORS.border};border-radius:12px;border-collapse:separate;">`,
    `<tr><td height="6" bgcolor="${palette.accent}" style="height:6px;line-height:6px;font-size:6px;background-color:${palette.accent};border-radius:12px 12px 0 0;">&nbsp;</td></tr>`,
    `<tr><td class="mail-pad" style="padding:24px 32px 0 32px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="48" valign="middle" style="width:48px;vertical-align:middle;">${mark}</td><td valign="middle" style="padding-left:12px;vertical-align:middle;${FONT}font-size:18px;line-height:24px;font-weight:700;color:${COLORS.heading};">${name}</td></tr></table></td></tr>`,
    `<tr><td class="mail-pad" style="padding:24px 32px 12px 32px;">${body.join('')}</td></tr>`,
    fallback,
    '</table>',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;"><tr><td class="mail-pad" style="padding:16px 32px 0 32px;${FONT}font-size:14px;line-height:20px;color:${COLORS.footer};text-align:center;">${text(footerText(brand))}</td></tr></table>`,
    '<!--[if mso]></td></tr></table><![endif]-->',
    '</td></tr>',
    '</table>',
    '</div>',
    '</body>',
    '</html>',
  ]
    .filter(Boolean)
    .join('\n');
}
