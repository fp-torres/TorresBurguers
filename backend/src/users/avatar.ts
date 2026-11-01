import { BadRequestException } from '@nestjs/common';

/**
 * Ícones prontos que a conta pode escolher como foto (texto no campo "avatar"). É a MESMA lista do
 * site (frontend-web, página "Meus Dados"): mudou lá, mude aqui.
 */
export const AVATAR_ICON_URLS: readonly string[] = [
  'https://cdn-icons-png.flaticon.com/512/3075/3075977.png',
  'https://cdn-icons-png.flaticon.com/512/1046/1046784.png',
  'https://cdn-icons-png.flaticon.com/512/2405/2405597.png',
  'https://cdn-icons-png.flaticon.com/512/4264/4264632.png',
  'https://cdn-icons-png.flaticon.com/512/2819/2819194.png',
];

export const AVATAR_NOT_ALLOWED_MESSAGE =
  'Foto inválida: envie a imagem no campo "file" ou escolha um dos ícones disponíveis.';

/**
 * Valor de "avatar" enviado como TEXTO pelo cliente: só um dos ícones prontos, ou o valor que a conta
 * já tem (reenviar sem mudar). URLs externas (pixel de rastreamento no painel da loja e no
 * superpainel), arquivos de outra conta ou de outra loja e caminhos quaisquer → 400. A foto enviada
 * como arquivo não passa por aqui: o servidor grava o caminho gerado pelo próprio upload.
 */
export function assertAvatarChoice(
  value: string | undefined,
  current?: string | null,
): void {
  if (value === undefined) return;
  if (current !== undefined && current !== null && value === current) return;
  if (AVATAR_ICON_URLS.includes(value)) return;
  throw new BadRequestException(AVATAR_NOT_ALLOWED_MESSAGE);
}
