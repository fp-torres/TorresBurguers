import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleInit,
} from '@nestjs/common';
import { createTransport, type SendMailOptions } from 'nodemailer';
import { isDevOrTest } from '../config/env';
import {
  SMTP_TIMEOUTS,
  describeMailError,
  mailConfig,
  mailStatusView,
  mailWarnings,
  smtpReady,
  type MailConfig,
  type MailDriver,
  type MailStatusView,
  type SmtpSettings,
} from './mail-config';
import { publicApiUrl } from './links';
import { brandedSubject } from './mail-layout';

export interface MailMessage {
  to: string;
  /** Assunto sem o prefixo da plataforma (o envio acrescenta "[Comestra] "). */
  subject: string;
  /** Versão em texto (sempre enviada; é também a que vai para o log em development/test). */
  text: string;
  /** Versão em HTML (opcional; ver mail-layout.ts): enviada junto com o texto (multipart/alternative). */
  html?: string;
}

export interface MailResult {
  /** A mensagem foi aceita por um provedor de e-mail de verdade (servidor SMTP)? */
  delivered: boolean;
  driver: MailDriver;
  /** Message-ID da mensagem aceita pelo SMTP. */
  messageId?: string;
  /** Motivo do não envio pelo SMTP, sem segredos (configuração incompleta ou falha do servidor). */
  error?: string;
}

/** O que o serviço usa do transporte do nodemailer (substituível nos testes). */
export interface MailTransport {
  sendMail(mail: SendMailOptions): Promise<{ messageId?: string }>;
}

export type MailTransportFactory = (smtp: SmtpSettings) => MailTransport;

/** Injeções opcionais (testes): variáveis de ambiente e fábrica do transporte. */
export const MAIL_ENV = Symbol('MAIL_ENV');
export const MAIL_TRANSPORT_FACTORY = Symbol('MAIL_TRANSPORT_FACTORY');

/** Transporte SMTP do nodemailer, com prazos curtos e TLS obrigatório quando há usuário e senha. */
export function createSmtpTransport(smtp: SmtpSettings): MailTransport {
  const auth =
    smtp.user && smtp.password
      ? { user: smtp.user, pass: smtp.password }
      : undefined;
  return createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    // Sem TLS direto (porta 587/25), as credenciais só seguem depois do STARTTLS: nunca em texto aberto
    requireTLS: !smtp.secure && !!auth,
    auth,
    ...SMTP_TIMEOUTS,
  });
}

/**
 * Envio de e-mails transacionais (convites, redefinição de senha, e-mail de teste do superpainel) pelo
 * driver configurado (ver mail-config.ts):
 *
 * - `log` (padrão): nada é enviado. Em development/test o texto completo (com o link) vai para o log da
 *   API; em produção só o destinatário e o assunto (o link é uma credencial) — com aviso na subida.
 * - `smtp`: o transporte do nodemailer é criado no primeiro envio e reaproveitado. A mensagem leva o
 *   texto e, quando o modelo a monta (mail-templates.ts), a versão em HTML com a marca (multipart/alternative).
 *
 * `send` nunca lança erro: configuração incompleta ou falha do servidor vão para o log (sem usuário nem
 * senha) e voltam em `MailResult.error`. Quem chama segue o fluxo (o convite continua criado e o link
 * continua aparecendo no painel; "esqueci a senha" continua respondendo 202).
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private readonly env: NodeJS.ProcessEnv;
  private readonly config: MailConfig;
  private readonly transportFactory: MailTransportFactory;
  private transport: MailTransport | null = null;

  constructor(
    @Optional() @Inject(MAIL_ENV) env?: NodeJS.ProcessEnv,
    @Optional()
    @Inject(MAIL_TRANSPORT_FACTORY)
    transportFactory?: MailTransportFactory,
  ) {
    this.env = env ?? process.env;
    this.config = mailConfig(this.env);
    this.transportFactory = transportFactory ?? createSmtpTransport;
  }

  /** Subida da API: avisos de configuração (driver de log em produção, SMTP incompleto, driver desconhecido). */
  onModuleInit(): void {
    for (const warning of mailWarnings(this.config, this.env)) {
      this.logger.warn(warning);
    }
    // Lido já na subida: um PUBLIC_API_URL inválido aparece no log antes do primeiro e-mail
    const logoBase = publicApiUrl(this.env);
    if (this.configured && this.config.smtp) {
      this.logger.log(
        `E-mails transacionais pelo SMTP ${this.config.smtp.host}:${this.config.smtp.port} (remetente: ${this.config.from}). ${
          logoBase
            ? `Logo das lojas nos e-mails: ${logoBase}/uploads/...`
            : 'Sem PUBLIC_API_URL: os e-mails das lojas saem sem o logo.'
        }`,
      );
    }
  }

  /** Driver ativo. */
  get driver(): MailDriver {
    return this.config.driver;
  }

  /** Os e-mails saem de verdade (driver smtp com a configuração completa)? */
  get configured(): boolean {
    return this.config.driver === 'smtp' && smtpReady(this.config);
  }

  /** Situação para o superpainel (GET /platform/settings), sem usuário nem senha do SMTP. */
  status(): MailStatusView {
    return mailStatusView(this.config, this.env);
  }

  async send(message: MailMessage): Promise<MailResult> {
    const subject = brandedSubject(message.subject);
    if (this.config.driver === 'log') return this.logOnly(message, subject);

    const { smtp, from } = this.config;
    if (!smtp || !from || !smtpReady(this.config)) {
      const error = `Configuração do SMTP incompleta: ${this.config.smtpIssues.join(' ')}`;
      this.logger.error(
        `E-mail para ${message.to} NÃO enviado (${subject}). ${error}`,
      );
      return { delivered: false, driver: 'smtp', error };
    }

    try {
      this.transport ??= this.transportFactory(smtp);
      const info = await this.transport.sendMail({
        from,
        to: message.to,
        subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        // RFC 3834: mensagem automática (evita respostas automáticas de férias e afins)
        headers: { 'Auto-Submitted': 'auto-generated' },
      });
      const messageId =
        typeof info?.messageId === 'string' ? info.messageId : undefined;
      this.logger.log(
        `E-mail enviado para ${message.to} pelo SMTP: ${subject}${messageId ? ` (${messageId})` : ''}`,
      );
      return { delivered: true, driver: 'smtp', messageId };
    } catch (error) {
      const failure = describeMailError(error, smtp);
      this.logger.error(
        `E-mail para ${message.to} NÃO enviado (${subject}). ${failure.summary}${
          failure.detail ? ` Detalhe: ${failure.detail}` : ''
        }`,
      );
      return { delivered: false, driver: 'smtp', error: failure.summary };
    }
  }

  private logOnly(message: MailMessage, subject: string): MailResult {
    if (isDevOrTest(this.env)) {
      // Só a versão em texto (a HTML tem o mesmo conteúdo; para vê-la, use um SMTP local como o Mailpit)
      this.logger.log(
        `E-mail (não enviado; driver de log) para ${message.to} — ${subject}${
          message.html ? ' (versões em texto e HTML; abaixo, o texto)' : ''
        }\n${message.text}`,
      );
    } else {
      this.logger.warn(
        `E-mail para ${message.to} NÃO enviado (driver de log): ${subject}`,
      );
    }
    return { delivered: false, driver: 'log' };
  }
}
