import { BRAND } from '../config/brand';
import { envFlag, isProduction } from '../config/env';

/**
 * Configuração do e-mail transacional (convites, redefinição de senha, e-mail de teste do superpainel).
 *
 * - MAIL_DRIVER: `log` (padrão: nada é enviado, a mensagem vai para o log da API) ou `smtp`.
 * - SMTP_HOST, SMTP_PORT (padrão 587, ou 465 com SMTP_SECURE), SMTP_SECURE (TLS direto; padrão: ligado
 *   só na porta 465), SMTP_USER e SMTP_PASSWORD (opcionais, sempre juntos) e MAIL_FROM (remetente).
 *
 * Usuário e senha do SMTP nunca saem desta configuração: as respostas da API, os avisos e os logs mostram
 * só o driver, o servidor, a porta e o remetente.
 */
export const MAIL_DRIVERS = ['log', 'smtp'] as const;
export type MailDriver = (typeof MAIL_DRIVERS)[number];

/**
 * Prazo de cada etapa da conversa com o servidor SMTP (milissegundos). Os padrões do nodemailer chegam a
 * minutos; aqui um servidor fora do ar não prende a requisição que disparou o e-mail por muito tempo.
 */
export const SMTP_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 30_000,
} as const;

export interface SmtpSettings {
  host: string;
  port: number;
  /** TLS desde o início da conexão (porta 465). Desligado: STARTTLS quando o servidor oferece. */
  secure: boolean;
  /** Credenciais (opcionais): nunca aparecem em respostas, avisos, logs ou na auditoria. */
  user: string | null;
  password: string | null;
}

export interface MailConfig {
  driver: MailDriver;
  /** Valor desconhecido de MAIL_DRIVER (o driver de log é usado no lugar); null quando válido ou vazio. */
  unknownDriver: string | null;
  /** Remetente (MAIL_FROM) válido; null quando ausente ou inválido. */
  from: string | null;
  /** Servidor SMTP; null sem SMTP_HOST ou com SMTP_PORT inválida. */
  smtp: SmtpSettings | null;
  /** O que impede o driver smtp de enviar (sem valores secretos). Vazio = SMTP configurado. */
  smtpIssues: string[];
}

/** Situação do e-mail para o superpainel (GET /platform/settings): nunca inclui usuário nem senha. */
export interface MailStatusView {
  /** Driver ativo: log (nada é enviado) ou smtp. */
  driver: MailDriver;
  /** SMTP_HOST, a porta, MAIL_FROM e as credenciais (quando usadas) estão completos e válidos. */
  smtp_configured: boolean;
  /** Remetente (MAIL_FROM); null quando ausente ou inválido. */
  from: string | null;
  /** Servidor SMTP (sem usuário nem senha); `auth` diz se há credenciais configuradas. */
  smtp: { host: string; port: number; secure: boolean; auth: boolean } | null;
  /** Avisos de configuração (os mesmos do log da subida da API), sem valores secretos. */
  issues: string[];
}

const PORT_PATTERN = /^\d{1,5}$/;
/** Endereço simples (local@dominio.tld), sem espaços nem caracteres de lista/cabeçalho. */
const ADDRESS_PATTERN =
  /^[^\s@<>"(),;:\\]+@[^\s@<>"(),;:\\]+\.[^\s@<>"(),;:\\]+$/;

/** MAIL_FROM aceito: `endereco@dominio` ou `Nome <endereco@dominio>` (uma linha, até 200 caracteres). */
export function isValidMailFrom(value: string): boolean {
  if (!value || value.length > 200 || /[\r\n]/.test(value)) return false;
  const named = value.match(/^([^<>]*)<([^<>]+)>$/);
  return ADDRESS_PATTERN.test((named ? named[2] : value).trim());
}

/** Lê as variáveis de e-mail (valores inválidos viram problemas listados, nunca exceções). */
export function mailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig {
  const rawDriver = env.MAIL_DRIVER?.trim() ?? '';
  const driverName = rawDriver.toLowerCase();
  const known = (MAIL_DRIVERS as readonly string[]).includes(driverName);
  const driver: MailDriver = known ? (driverName as MailDriver) : 'log';

  const issues: string[] = [];
  const host = env.SMTP_HOST?.trim() ?? '';
  if (!host) issues.push('SMTP_HOST não definido.');

  const rawPort = env.SMTP_PORT?.trim() ?? '';
  let port: number | null;
  let secure: boolean;
  if (rawPort) {
    const parsed = PORT_PATTERN.test(rawPort) ? Number(rawPort) : NaN;
    port = parsed >= 1 && parsed <= 65535 ? parsed : null;
    if (port === null) {
      issues.push(
        `SMTP_PORT inválida ("${rawPort.slice(0, 20)}"): use um número de 1 a 65535.`,
      );
    }
    secure = envFlag('SMTP_SECURE', port === 465, env);
  } else {
    secure = envFlag('SMTP_SECURE', false, env);
    port = secure ? 465 : 587;
  }

  const user = env.SMTP_USER?.trim() || null;
  const password = env.SMTP_PASSWORD?.trim() ? env.SMTP_PASSWORD : null;
  if (user && !password) issues.push('SMTP_USER definido sem SMTP_PASSWORD.');
  if (!user && password) issues.push('SMTP_PASSWORD definida sem SMTP_USER.');

  const rawFrom = env.MAIL_FROM?.trim() ?? '';
  const from = rawFrom && isValidMailFrom(rawFrom) ? rawFrom : null;
  if (!rawFrom) {
    issues.push(
      `MAIL_FROM não definido (ex.: ${BRAND.name} <nao-responda@seudominio.com.br>).`,
    );
  } else if (!from) {
    issues.push(
      'MAIL_FROM inválido: use "Nome <endereco@dominio>" ou só o endereço.',
    );
  }

  return {
    driver,
    unknownDriver: rawDriver && !known ? rawDriver.slice(0, 40) : null,
    from,
    smtp: host && port !== null ? { host, port, secure, user, password } : null,
    smtpIssues: issues,
  };
}

/** O driver smtp consegue enviar (configuração completa)? */
export function smtpReady(config: MailConfig): boolean {
  return config.smtpIssues.length === 0 && !!config.smtp && !!config.from;
}

/**
 * Avisos de configuração do e-mail (exibidos na subida da API e no superpainel). Nenhum valor secreto
 * aparece: só nomes de variáveis, o driver e o servidor.
 */
export function mailWarnings(
  config: MailConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const warnings: string[] = [];
  if (config.unknownDriver !== null) {
    warnings.push(
      `MAIL_DRIVER="${config.unknownDriver}" não é reconhecido (use log ou smtp): o driver de log é usado e nenhum e-mail é enviado.`,
    );
  }
  if (config.driver === 'smtp' && !smtpReady(config)) {
    warnings.push(
      `MAIL_DRIVER=smtp com a configuração incompleta: ${config.smtpIssues.join(' ')} Nenhum e-mail será enviado até corrigir.`,
    );
  }
  if (config.driver === 'log' && isProduction(env)) {
    warnings.push(
      'E-mail transacional com o driver de log em produção: nenhum e-mail é enviado (convites e links de redefinição de senha não chegam às pessoas; o superpainel mostra os links que ele mesmo gera). Configure MAIL_DRIVER=smtp, SMTP_HOST e MAIL_FROM.',
    );
  }
  return warnings;
}

/** Situação do e-mail para o superpainel (sem usuário nem senha do SMTP). */
export function mailStatusView(
  config: MailConfig,
  env: NodeJS.ProcessEnv = process.env,
): MailStatusView {
  return {
    driver: config.driver,
    smtp_configured: smtpReady(config),
    from: config.from,
    smtp: config.smtp
      ? {
          host: config.smtp.host,
          port: config.smtp.port,
          secure: config.smtp.secure,
          auth: config.smtp.user !== null,
        }
      : null,
    issues: mailWarnings(config, env),
  };
}

/** Explicação de cada código de erro do nodemailer (o que conferir na configuração). */
const ERROR_HINTS: Record<string, string> = {
  EAUTH:
    'o servidor SMTP recusou o usuário ou a senha (confira SMTP_USER e SMTP_PASSWORD)',
  ENOAUTH:
    'o servidor SMTP exige autenticação (defina SMTP_USER e SMTP_PASSWORD)',
  EDNS: 'o endereço do servidor SMTP não foi encontrado (confira SMTP_HOST)',
  ESOCKET:
    'não foi possível conectar ao servidor SMTP (confira SMTP_HOST, SMTP_PORT e SMTP_SECURE)',
  ECONNECTION:
    'a conexão com o servidor SMTP foi encerrada (confira SMTP_PORT e SMTP_SECURE)',
  ETIMEDOUT:
    'o servidor SMTP não respondeu a tempo (confira SMTP_HOST, SMTP_PORT e o firewall)',
  ETLS: 'a negociação TLS com o servidor SMTP falhou (confira SMTP_PORT e SMTP_SECURE)',
  EENVELOPE:
    'o servidor SMTP recusou o remetente ou o destinatário (confira MAIL_FROM e o endereço de destino)',
  EMESSAGE: 'o servidor SMTP recusou a mensagem',
  EPROTOCOL: 'o servidor SMTP respondeu fora do protocolo',
  ECONFIG: 'a configuração do SMTP é inválida',
};

export interface MailFailure {
  /** Código do nodemailer (EAUTH, ETIMEDOUT...) ou do sistema; null quando ausente. */
  code: string | null;
  /** Código da resposta SMTP (ex.: 535); null quando ausente. */
  responseCode: number | null;
  /** Motivo em português, sem segredos (vai para a resposta do e-mail de teste e para a auditoria). */
  summary: string;
  /** Mensagem original com usuário e senha mascarados (só para o log). */
  detail: string;
}

/** Troca usuário e senha (e as formas em base64 que o AUTH do SMTP usa) por "***". */
export function redactSecrets(
  text: string,
  secrets: ReadonlyArray<string | null | undefined>,
): string {
  const values = secrets.filter((secret): secret is string => !!secret);
  const variants = new Set<string>();
  for (const value of values) {
    variants.add(value);
    variants.add(Buffer.from(value).toString('base64'));
  }
  if (values.length === 2) {
    // AUTH PLAIN: base64("\0usuario\0senha")
    variants.add(
      Buffer.from(`\u0000${values[0]}\u0000${values[1]}`).toString('base64'),
    );
  }
  let result = text;
  // Mais longos primeiro: um segredo contido em outro não deixa sobras
  for (const variant of [...variants].sort((a, b) => b.length - a.length)) {
    if (variant.length >= 3) result = result.split(variant).join('***');
  }
  return result;
}

/** Descreve uma falha de envio sem expor usuário nem senha do SMTP. */
export function describeMailError(
  error: unknown,
  smtp: Pick<SmtpSettings, 'user' | 'password'> | null,
): MailFailure {
  const raw = (error && typeof error === 'object' ? error : {}) as {
    code?: unknown;
    responseCode?: unknown;
    message?: unknown;
  };
  const code =
    typeof raw.code === 'string' && raw.code ? raw.code.slice(0, 40) : null;
  const responseCode =
    typeof raw.responseCode === 'number' ? raw.responseCode : null;
  const hint =
    (code && ERROR_HINTS[code]) || 'o envio pelo servidor SMTP falhou';
  const reference = [code, responseCode].filter((part) => part !== null);
  const message =
    typeof raw.message === 'string'
      ? raw.message
      : error instanceof Error
        ? error.message
        : String(error);
  return {
    code,
    responseCode,
    summary: `${hint.charAt(0).toUpperCase()}${hint.slice(1)}${
      reference.length ? ` (${reference.join(' ')})` : ''
    }.`,
    detail: redactSecrets(message, [smtp?.user, smtp?.password])
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300),
  };
}
