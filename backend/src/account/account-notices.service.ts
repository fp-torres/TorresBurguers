import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { maskEmail } from '../audit/audit-sanitize';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { mailBrandForAccount } from '../notifications/mail-brand';
import {
  emailChangeConfirmMail,
  emailChangedNoticeMail,
  emailChangeInUseMail,
  emailChangeRevertedMail,
  emailVerificationMail,
  passwordChangedMail,
} from '../notifications/mail-templates';
import type { MailMessage } from '../notifications/mail.service';
import { MailService } from '../notifications/mail.service';
import { normalizeEmail } from '../users/email';
import { User } from '../users/entities/user.entity';
import {
  EMAIL_CHANGE_TTL_HOURS,
  EMAIL_REVERT_TTL_DAYS,
  EMAIL_VERIFICATION_TTL_HOURS,
  emailChangeUrl,
  emailRevertUrl,
  emailVerificationUrl,
  forgotPasswordUrl,
} from './account-email-links';

/** O que os avisos precisam da conta: nome e loja (a marca do e-mail). */
export type NoticeAccount = Pick<User, 'name' | 'store_id'>;

/**
 * E-mails das ações da conta (verificação, troca de e-mail, "Não fui eu", senha alterada). Marca da loja
 * para a equipe e da plataforma para clientes e superadmin (mailBrandForAccount); tudo escapado pelo
 * renderMail. Nenhum método lança erro: uma falha vai para o log e a ação da conta continua valendo
 * (quem chama dispara em segundo plano, com `void`).
 *
 * Os e-mails para um endereço informado por alguém (verificação, confirmação da troca, aviso de e-mail
 * em uso) respeitam o limite silencioso ACCOUNT_EMAIL_TARGET por destino: acima dele nada sai, sem aviso
 * a quem pediu (protege a caixa de terceiros). Os avisos de segurança ao titular sempre saem.
 */
@Injectable()
export class AccountNoticesService {
  private readonly logger = new Logger(AccountNoticesService.name);

  constructor(
    private readonly mail: MailService,
    private readonly rateLimit: RateLimitService,
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  /** Link de verificação do e-mail da conta. Devolve se o e-mail foi entregue a um provedor. */
  async verification(
    account: NoticeAccount,
    email: string,
    token: string,
  ): Promise<boolean> {
    if (!this.allowTarget(email)) return false;
    return this.deliver('verificação de e-mail', async () =>
      emailVerificationMail({
        to: email,
        name: account.name,
        url: emailVerificationUrl(token),
        hours: EMAIL_VERIFICATION_TTL_HOURS,
        brand: await this.brandOf(account),
      }),
    );
  }

  /** Confirmação da troca, no endereço NOVO. */
  async changeConfirm(
    account: NoticeAccount,
    newEmail: string,
    token: string,
  ): Promise<boolean> {
    if (!this.allowTarget(newEmail)) return false;
    return this.deliver('confirmação de troca de e-mail', async () =>
      emailChangeConfirmMail({
        to: newEmail,
        name: account.name,
        url: emailChangeUrl(token),
        hours: EMAIL_CHANGE_TTL_HOURS,
        brand: await this.brandOf(account),
      }),
    );
  }

  /** Pedido de troca para um endereço que já tem conta: aviso ao dono do endereço, sem link. */
  async changeInUse(newEmail: string): Promise<boolean> {
    if (!this.allowTarget(newEmail)) return false;
    return this.deliver('aviso de e-mail em uso', () =>
      Promise.resolve(emailChangeInUseMail({ to: newEmail })),
    );
  }

  /**
   * Aviso ao endereço ANTIGO depois da troca: com o "Não fui eu" (revertToken) quando a própria pessoa
   * trocou; informativo, sem link, quando foi o ADMIN da loja.
   */
  async emailChanged(
    account: NoticeAccount,
    change: {
      oldEmail: string;
      newEmail: string;
      revertToken: string | null;
      byStoreAdmin?: boolean;
      changedAt?: Date;
    },
  ): Promise<boolean> {
    return this.deliver('aviso de troca de e-mail', async () =>
      emailChangedNoticeMail({
        to: change.oldEmail,
        name: account.name,
        newEmailMasked: maskEmail(change.newEmail),
        changedAt: change.changedAt ?? new Date(),
        revertUrl: change.revertToken
          ? emailRevertUrl(change.revertToken)
          : null,
        days: EMAIL_REVERT_TTL_DAYS,
        byStoreAdmin: change.byStoreAdmin,
        brand: await this.brandOf(account),
      }),
    );
  }

  /** Troca desfeita pelo "Não fui eu": aviso ao endereço que foi substituído. */
  async changeReverted(
    account: NoticeAccount,
    replacedEmail: string,
    restoredEmail: string,
  ): Promise<boolean> {
    return this.deliver('aviso de troca de e-mail desfeita', async () =>
      emailChangeRevertedMail({
        to: replacedEmail,
        name: account.name,
        restoredEmailMasked: maskEmail(restoredEmail),
        brand: await this.brandOf(account),
      }),
    );
  }

  /** Senha alterada (pela própria pessoa ou pelo ADMIN da loja): aviso ao e-mail informado. */
  async passwordChanged(
    account: NoticeAccount,
    email: string,
    options: { byStoreAdmin?: boolean; changedAt?: Date } = {},
  ): Promise<boolean> {
    return this.deliver('aviso de senha alterada', async () =>
      passwordChangedMail({
        to: email,
        name: account.name,
        changedAt: options.changedAt ?? new Date(),
        forgotUrl: forgotPasswordUrl(),
        byStoreAdmin: options.byStoreAdmin,
        brand: await this.brandOf(account),
      }),
    );
  }

  // ---------------------------------------------------------------------------

  /** Limite silencioso por destino (ACCOUNT_EMAIL_TARGET): false = não enviar. */
  private allowTarget(email: string): boolean {
    const key = `email:${normalizeEmail(email)}`;
    if (this.rateLimit.isLimited('ACCOUNT_EMAIL_TARGET', key)) {
      this.logger.warn(
        `E-mail da conta para ${maskEmail(email)} não enviado: limite por destino atingido.`,
      );
      return false;
    }
    this.rateLimit.hit('ACCOUNT_EMAIL_TARGET', key);
    return true;
  }

  private brandOf(account: NoticeAccount) {
    return mailBrandForAccount(this.users.manager, account.store_id);
  }

  /** Monta e envia; nunca lança (o MailService também não). */
  private async deliver(
    label: string,
    build: () => Promise<MailMessage>,
  ): Promise<boolean> {
    try {
      const result = await this.mail.send(await build());
      return result.delivered;
    } catch (error) {
      this.logger.error(
        `Falha ao montar o e-mail (${label}): ${(error as Error)?.message ?? String(error)}`,
      );
      return false;
    }
  }
}
