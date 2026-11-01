import { BRAND } from '../config/brand';
import {
  type MailBrand,
  platformMailBrand,
  type StoreBrandSource,
  storeMailBrand,
} from './mail-brand';
import { renderMail } from './mail-layout';
import type { MailMessage } from './mail.service';

/**
 * Modelos dos e-mails transacionais. Cada um devolve o assunto e as versões em texto e em HTML
 * (mail-layout.ts), com a marca da loja (convite, redefinição de senha da equipe) ou da plataforma.
 */

/** Nome de cada perfil da equipe como aparece para as pessoas (igual ao do site). */
export const STAFF_ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Administrador',
  EMPLOYEE: 'Atendente',
  KITCHEN: 'Cozinha',
  COURIER: 'Entregador',
};

/**
 * E-mail com o link de redefinição de senha (uso único, prazo curto). Marca: a da loja para contas da
 * equipe (ver mail-brand.ts → mailBrandForAccount); a da plataforma para clientes e superadmins.
 */
export function passwordResetMail(
  input: {
    to: string;
    name: string;
    url: string;
    minutes: number;
    brand?: MailBrand;
  },
  env: NodeJS.ProcessEnv = process.env,
): MailMessage {
  const brand = input.brand ?? platformMailBrand();
  const name = input.name.trim();
  const account =
    brand.scope === 'store'
      ? `da sua conta da equipe de ${brand.name} na ${BRAND.name}`
      : `da sua conta na ${BRAND.name}`;
  return {
    to: input.to,
    ...renderMail(
      {
        subject: 'Redefinição de senha',
        preview: `Use o link para criar uma nova senha. Ele vale por ${input.minutes} minutos.`,
        heading: 'Redefinição de senha',
        greeting: name ? `Olá, ${name}!` : 'Olá!',
        paragraphs: [
          `Recebemos um pedido para redefinir a senha ${account}. Para criar uma nova senha, use o link abaixo.`,
        ],
        action: { label: 'Criar nova senha', url: input.url },
        actionNote: `O link vale por ${input.minutes} minutos e só pode ser usado uma vez.`,
        closing: [
          'Se você não pediu a redefinição, ignore este e-mail: a sua senha atual continua valendo.',
        ],
      },
      brand,
      env,
    ),
  };
}

/** Data e hora do envio no horário de Brasília (ex.: 25/10/2026, 14:30:05). */
function brasiliaDateTime(date: Date): string {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'medium',
    timeZone: 'America/Sao_Paulo',
  }).format(date);
}

/**
 * E-mail de teste do superpainel (Configurações → Enviar e-mail de teste), com a marca da plataforma.
 * Não leva links nem segredos.
 */
export function testMail(
  input: {
    to: string;
    operatorName: string;
    sentAt: Date;
  },
  env: NodeJS.ProcessEnv = process.env,
): MailMessage {
  return {
    to: input.to,
    ...renderMail(
      {
        subject: 'E-mail de teste',
        preview:
          'Se você recebeu esta mensagem, o envio de e-mails da plataforma está funcionando.',
        heading: 'E-mail de teste',
        greeting: 'Olá!',
        paragraphs: [
          `Este é um e-mail de teste enviado pelo superpainel da ${BRAND.name} por ${input.operatorName}, em ${brasiliaDateTime(input.sentAt)} (horário de Brasília).`,
          'Se você recebeu esta mensagem, o envio dos e-mails da plataforma (convites e redefinição de senha) está funcionando.',
        ],
        closing: ['Nenhuma ação é necessária.'],
      },
      platformMailBrand(),
      env,
    ),
  };
}

/** E-mail do convite para a equipe de uma loja, com o nome, a cor e o logo da loja. */
export function invitationMail(
  input: {
    to: string;
    store: StoreBrandSource;
    role: string;
    url: string;
    days: number;
  },
  env: NodeJS.ProcessEnv = process.env,
): MailMessage {
  const brand = storeMailBrand(input.store, env);
  const role = STAFF_ROLE_LABELS[input.role] ?? input.role;
  return {
    to: input.to,
    ...renderMail(
      {
        subject: `Convite para a equipe de ${brand.name}`,
        preview: `${brand.name} convidou você para a equipe, com o perfil ${role}.`,
        heading: 'Convite para a equipe',
        greeting: 'Olá!',
        paragraphs: [
          `Você foi convidado(a) para a equipe de ${brand.name} na ${BRAND.name}, com o perfil ${role}. Para aceitar e criar o seu acesso, use o link abaixo.`,
        ],
        action: { label: 'Aceitar o convite', url: input.url },
        actionNote: `O convite vale por ${input.days} dias e só pode ser usado uma vez.`,
        closing: ['Se você não esperava este convite, ignore este e-mail.'],
      },
      brand,
      env,
    ),
  };
}

// ---------------------------------------------------------------------------
// E-mail da conta: verificação, troca (com "Não fui eu") e avisos de segurança
// ---------------------------------------------------------------------------

/** "da sua conta na Comestra" ou "da sua conta da equipe de <loja> na Comestra" (marca do e-mail). */
function accountOf(brand: MailBrand): string {
  return brand.scope === 'store'
    ? `da sua conta da equipe de ${brand.name} na ${BRAND.name}`
    : `da sua conta na ${BRAND.name}`;
}

function greetingFor(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed ? `Olá, ${trimmed}!` : 'Olá!';
}

/** Link de verificação do e-mail da conta (/verificar-email/<código>). */
export function emailVerificationMail(
  input: {
    to: string;
    name?: string | null;
    url: string;
    hours: number;
    brand?: MailBrand;
  },
  env: NodeJS.ProcessEnv = process.env,
): MailMessage {
  const brand = input.brand ?? platformMailBrand();
  return {
    to: input.to,
    ...renderMail(
      {
        subject: 'Confirme o seu e-mail',
        preview: `Confirme que este endereço é seu. O link vale por ${input.hours} horas.`,
        heading: 'Confirme o seu e-mail',
        greeting: greetingFor(input.name),
        paragraphs: [
          `Para confirmar que este é o e-mail ${accountOf(brand)}, use o link abaixo.`,
        ],
        action: { label: 'Confirmar e-mail', url: input.url },
        actionNote: `O link vale por ${input.hours} horas e só pode ser usado uma vez.`,
        closing: [
          'Se você não criou uma conta nem pediu esta confirmação, ignore este e-mail.',
        ],
      },
      brand,
      env,
    ),
  };
}

/** Confirmação da troca de e-mail, enviada ao endereço NOVO (/confirmar-email/<código>). */
export function emailChangeConfirmMail(
  input: {
    to: string;
    name?: string | null;
    url: string;
    hours: number;
    brand?: MailBrand;
  },
  env: NodeJS.ProcessEnv = process.env,
): MailMessage {
  const brand = input.brand ?? platformMailBrand();
  return {
    to: input.to,
    ...renderMail(
      {
        subject: 'Confirme o seu novo e-mail',
        preview: `Confirme a troca do e-mail da sua conta. O link vale por ${input.hours} horas.`,
        heading: 'Confirme o seu novo e-mail',
        greeting: greetingFor(input.name),
        paragraphs: [
          `Recebemos um pedido para usar este endereço como o novo e-mail ${accountOf(brand)}. O e-mail da conta só muda depois da confirmação.`,
        ],
        action: { label: 'Confirmar o novo e-mail', url: input.url },
        actionNote: `O link vale por ${input.hours} horas e só pode ser usado uma vez.`,
        closing: [
          'Se você não pediu a troca, ignore este e-mail: nada muda na conta.',
        ],
      },
      brand,
      env,
    ),
  };
}

/**
 * Pedido de troca para um endereço que JÁ tem conta: o dono do endereço é avisado, sem link (a troca
 * nunca acontece). Quem pediu recebe a mesma resposta de um endereço livre.
 */
export function emailChangeInUseMail(
  input: { to: string },
  env: NodeJS.ProcessEnv = process.env,
): MailMessage {
  return {
    to: input.to,
    ...renderMail(
      {
        subject: 'Pedido para usar o seu e-mail',
        preview: 'Este e-mail já tem conta: nada foi alterado.',
        heading: 'Pedido para usar o seu e-mail',
        greeting: 'Olá!',
        paragraphs: [
          `Alguém pediu para usar este endereço como o e-mail de outra conta na ${BRAND.name}. Este e-mail já está ligado a uma conta, então nada foi alterado.`,
        ],
        closing: [
          'Se foi você, entre com este e-mail ou use "Esqueci minha senha" no site. Se não foi, ignore este e-mail.',
        ],
      },
      platformMailBrand(),
      env,
    ),
  };
}

/**
 * Aviso ao endereço ANTIGO depois de uma troca do e-mail da conta. Troca feita pela própria pessoa: com o
 * link "Não fui eu" (desfaz a troca pedindo uma nova senha). Troca feita pelo ADMIN da loja: aviso
 * informativo, sem link.
 */
export function emailChangedNoticeMail(
  input: {
    to: string;
    name?: string | null;
    newEmailMasked: string;
    changedAt: Date;
    revertUrl?: string | null;
    days: number;
    byStoreAdmin?: boolean;
    brand?: MailBrand;
  },
  env: NodeJS.ProcessEnv = process.env,
): MailMessage {
  const brand = input.brand ?? platformMailBrand();
  const when = `${brasiliaDateTime(input.changedAt)} (horário de Brasília)`;
  const byAdmin = input.byStoreAdmin === true;
  const revert = !byAdmin && input.revertUrl ? input.revertUrl : null;
  return {
    to: input.to,
    ...renderMail(
      {
        subject: 'O e-mail da sua conta foi alterado',
        preview: byAdmin
          ? `O e-mail de acesso foi alterado para ${input.newEmailMasked}.`
          : 'Se não foi você, desfaça a troca pelo link deste e-mail.',
        heading: 'O e-mail da sua conta foi alterado',
        greeting: greetingFor(input.name),
        paragraphs: byAdmin
          ? [
              `Um administrador de ${brand.name} alterou o e-mail de acesso ${accountOf(brand)} de ${input.to} para ${input.newEmailMasked}, em ${when}.`,
              'Se você não esperava essa mudança, fale com a administração da loja.',
            ]
          : [
              `O e-mail ${accountOf(brand)} foi alterado de ${input.to} para ${input.newEmailMasked}, em ${when}.`,
              'Se foi você, nenhuma ação é necessária.',
            ],
        ...(revert
          ? {
              action: { label: 'Não fui eu: desfazer a troca', url: revert },
              actionNote: `O link vale por ${input.days} dias e só pode ser usado uma vez. Ele devolve este e-mail para a conta, pede uma nova senha e encerra todas as sessões.`,
            }
          : {}),
        closing: [
          'Por segurança, as sessões abertas da conta foram encerradas.',
        ],
      },
      brand,
      env,
    ),
  };
}

/** Aviso ao endereço que foi SUBSTITUÍDO quando a troca é desfeita pelo "Não fui eu". */
export function emailChangeRevertedMail(
  input: {
    to: string;
    name?: string | null;
    restoredEmailMasked: string;
    brand?: MailBrand;
  },
  env: NodeJS.ProcessEnv = process.env,
): MailMessage {
  const brand = input.brand ?? platformMailBrand();
  return {
    to: input.to,
    ...renderMail(
      {
        subject: 'A troca de e-mail da sua conta foi desfeita',
        preview: 'Este endereço não é mais o e-mail da conta.',
        heading: 'A troca de e-mail foi desfeita',
        greeting: greetingFor(input.name),
        paragraphs: [
          `A troca do e-mail ${accountOf(brand)} foi desfeita pelo link "Não fui eu" enviado ao endereço anterior (${input.restoredEmailMasked}). Este endereço não é mais o e-mail da conta.`,
          'A senha foi redefinida e todas as sessões foram encerradas.',
        ],
        closing: [
          'Se a troca tinha sido feita por você, fale com o suporte da plataforma.',
        ],
      },
      brand,
      env,
    ),
  };
}

/**
 * Aviso de senha alterada ao e-mail da conta, com o atalho para "Esqueci minha senha" (/esqueci-senha)
 * caso não tenha sido a pessoa. byStoreAdmin: a senha foi definida pelo ADMIN da loja (texto próprio).
 */
export function passwordChangedMail(
  input: {
    to: string;
    name?: string | null;
    changedAt: Date;
    forgotUrl: string;
    byStoreAdmin?: boolean;
    brand?: MailBrand;
  },
  env: NodeJS.ProcessEnv = process.env,
): MailMessage {
  const brand = input.brand ?? platformMailBrand();
  const when = `${brasiliaDateTime(input.changedAt)} (horário de Brasília)`;
  const byAdmin = input.byStoreAdmin === true;
  return {
    to: input.to,
    ...renderMail(
      {
        subject: 'A senha da sua conta foi alterada',
        preview: 'Se não foi você, crie uma nova senha agora.',
        heading: 'A senha da sua conta foi alterada',
        greeting: greetingFor(input.name),
        paragraphs: byAdmin
          ? [
              `Um administrador de ${brand.name} definiu uma nova senha ${accountOf(brand)}, em ${when}.`,
              'Peça a nova senha à administração da loja ou crie outra pelo link abaixo.',
            ]
          : [
              `A senha ${accountOf(brand)} foi alterada em ${when}.`,
              'Se foi você, nenhuma ação é necessária. Se não foi, crie uma nova senha agora pelo link abaixo: isso encerra todas as sessões da conta.',
            ],
        action: { label: 'Criar uma nova senha', url: input.forgotUrl },
        closing: [
          'Por segurança, as outras sessões abertas da conta foram encerradas.',
        ],
      },
      brand,
      env,
    ),
  };
}
