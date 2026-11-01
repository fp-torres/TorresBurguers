import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import type { Request } from 'express';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { revokeOpenAccountEmailTokens } from '../account/account-email-tokens.service';
import { AccountEmailTokenPurpose } from '../account/entities/account-email-token.entity';
import { maskEmail } from '../audit/audit-sanitize';
import { AuditService } from '../audit/audit.service';
import { randomToken, sha256Hex } from '../common/crypto/secret-box';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { requestMeta } from '../common/request-meta';
import { appLink } from '../notifications/links';
import { mailBrandForAccount } from '../notifications/mail-brand';
import { passwordResetMail } from '../notifications/mail-templates';
import { MailService } from '../notifications/mail.service';
import { accountActor, accountScope } from '../users/account-actor';
import { normalizeEmail } from '../users/email';
import { User } from '../users/entities/user.entity';
import { type AuthUser, isSuperAdmin } from './auth-user';
import { PasswordResetToken } from './entities/password-reset-token.entity';
import { clientIpKey, isLinkToken } from './link-token';

/** Validade do link de redefinição. */
export const RESET_TOKEN_TTL_MINUTES = 60;

/**
 * Links de "Esqueci minha senha" enviados a um mesmo destinatário (conta) em 24 h. Contados no banco
 * (valem entre instâncias e depois de reiniciar a API), além do limite por IP (429) e do limite curto
 * por e-mail (FORGOT_PASSWORD). Acima dele nada é enviado, sem aviso a quem pediu.
 */
export const FORGOT_PASSWORD_RECIPIENT_DAILY_LIMIT = 3;
const RECIPIENT_WINDOW_MS = 24 * 60 * 60_000;

export const FORGOT_PASSWORD_MESSAGE =
  'Se houver uma conta com este e-mail, enviaremos um link para criar uma nova senha. Confira também a caixa de spam.';
export const RESET_LINK_INVALID_MESSAGE =
  'Link de redefinição inválido ou expirado. Peça um novo em "Esqueci minha senha".';
export const PASSWORD_RESET_DONE_MESSAGE =
  'Senha redefinida. Entre com a nova senha.';

export const PLATFORM_ACCOUNT_RESET_MESSAGE =
  'Contas da administração da plataforma não recebem link pelo superpainel: a pessoa usa "Esqueci minha senha" ou a operação usa o comando platform:superadmin no servidor.';
export const RESET_LINK_NOT_SENT_MESSAGE =
  'Não foi possível enviar o link por e-mail, então nenhum link foi gerado. Confira o envio de e-mails em Configurações e tente de novo.';

/**
 * POST /platform/users/:id/password-reset. Com o SMTP configurado, o link vai só para o e-mail do
 * titular (url null); sem ele, a url volta para o operador repassar.
 */
export type PlatformResetLink =
  | { url: string; delivered: false; expires_at: Date }
  | { url: null; delivered: true; email_masked: string; expires_at: Date };

const SALT_ROUNDS = 10;

/** Página do site que recebe o link (frontend web). */
export function passwordResetUrl(token: string): string {
  return appLink(`/redefinir-senha/${token}`);
}

/**
 * Redefinição de senha por link de uso único: o token só existe no link (randomToken) e o banco
 * guarda o SHA-256; vale 60 minutos; um link novo invalida os anteriores; redefinir encerra todas
 * as sessões da conta (token_version + 1). Sem provedor de e-mail, o link vai para o log em
 * dev/test e, em produção, o superadmin gera o link pelo superpainel (createLinkForUser).
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    @InjectRepository(PasswordResetToken)
    private readonly tokens: Repository<PasswordResetToken>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /**
   * POST /auth/forgot-password. Resposta sempre igual (202), exista a conta ou não: o trabalho
   * (consulta, token, e-mail) segue em segundo plano, para nem o tempo de resposta revelar a conta.
   * Limite por IP (429) aqui; o limite por e-mail é silencioso (protege a caixa da vítima).
   */
  requestReset(email: string, request?: Request | null): void {
    this.rateLimit.consume('FORGOT_PASSWORD', `ip:${clientIpKey(request)}`);
    void this.sendResetLink(normalizeEmail(email), request).catch(
      (error: unknown) =>
        this.logger.error(
          `Falha ao gerar o link de redefinição de senha: ${(error as Error).message}`,
        ),
    );
  }

  /**
   * Gera e envia o link para a conta ativa com o e-mail. Conta inexistente, bloqueada ou e-mail
   * acima do limite: nada é enviado. Devolve se um link foi enviado (só para testes e logs internos).
   */
  async sendResetLink(
    email: string,
    request?: Request | null,
  ): Promise<boolean> {
    const emailKey = `email:${email}`;
    if (this.rateLimit.isLimited('FORGOT_PASSWORD', emailKey)) return false;
    this.rateLimit.hit('FORGOT_PASSWORD', emailKey);

    const user = await this.accountByEmail(email);
    if (!user || user.blocked_at) {
      await this.audit.record({
        action: 'auth.password_reset.request',
        actorEmail: email,
        ...(user ? { targetType: 'user', targetId: user.id } : {}),
        result: user ? 'DENIED' : 'FAILURE',
        metadata: { reason: user ? 'blocked' : 'unknown_account' },
        request,
      });
      return false;
    }
    if (await this.recipientLimitReached(user.id)) {
      // A caixa da pessoa não vira alvo de envio em massa (de vários IPs ao longo do dia)
      await this.audit.record({
        action: 'auth.password_reset.request',
        actorEmail: email,
        storeId: user.store_id,
        targetType: 'user',
        targetId: user.id,
        result: 'DENIED',
        metadata: {
          reason: 'recipient_limit',
          limit: FORGOT_PASSWORD_RECIPIENT_DAILY_LIMIT,
        },
        request,
      });
      return false;
    }

    const { token, expiresAt } = await this.issueToken(user, {
      createdBy: null,
      ip: requestMeta(request).ip,
    });
    await this.mailLink(user, passwordResetUrl(token));
    await this.audit.record({
      action: 'auth.password_reset.request',
      actorEmail: email,
      storeId: user.store_id,
      targetType: 'user',
      targetId: user.id,
      metadata: { expires_at: expiresAt },
      request,
    });
    return true;
  }

  /** GET /auth/reset-password/:token: confere o link sem usá-lo. Inválido, usado ou vencido → 404. */
  async inspect(
    token: string,
    request?: Request | null,
  ): Promise<{ email_masked: string; expires_at: Date }> {
    const found = await this.usableOrInvalid(token, clientIpKey(request));
    return {
      email_masked: maskEmail(found.user.email),
      expires_at: found.record.expires_at,
    };
  }

  /**
   * POST /auth/reset-password: grava a nova senha (mesma política do cadastro), encerra todas as
   * sessões, marca o link como usado e invalida os outros links pendentes da conta.
   */
  async reset(
    token: string,
    password: string,
    request?: Request | null,
  ): Promise<void> {
    const ip = clientIpKey(request);
    // Conferência barata antes do bcrypt: link inválido não gasta processamento
    await this.usableOrInvalid(token, ip);

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const done = await this.tokens.manager.transaction(async (manager) => {
      const tokens = manager.getRepository(PasswordResetToken);
      const users = manager.getRepository(User);
      // Trava o link: dois envios simultâneos não usam o mesmo link duas vezes
      const record = await tokens.findOne({
        where: { token_hash: sha256Hex(token) },
        lock: { mode: 'pessimistic_write' },
      });
      const now = new Date();
      if (!record || record.used_at || record.expires_at <= now) return null;
      const user = await users.findOne({ where: { id: record.user_id } });
      if (!user) return null;

      const used = await tokens.update(
        { id: record.id, used_at: IsNull() },
        { used_at: now },
      );
      if (!used.affected) return null;
      await tokens.update(
        { user_id: user.id, used_at: IsNull(), expires_at: MoreThan(now) },
        { expires_at: now },
      );
      // Link pedido pela própria pessoa ("Esqueci minha senha") só chega pela caixa da conta: prova a
      // posse do e-mail. Toda troca de e-mail vence os links pendentes, então o link é do e-mail atual.
      // O link do superpainel (created_by preenchido) pode ter sido repassado: não confirma nada.
      const viaEmail = record.created_by_user_id === null;
      await users.update(
        { id: user.id },
        {
          password_hash: passwordHash,
          token_version: () => '"token_version" + 1',
          ...(viaEmail
            ? {
                email_verified_at: () => 'COALESCE("email_verified_at", now())',
              }
            : {}),
        },
      );
      // Um pedido de troca de e-mail em aberto (talvez de quem tinha a senha antiga) é cancelado
      await revokeOpenAccountEmailTokens(
        manager,
        user.id,
        [AccountEmailTokenPurpose.CHANGE],
        now,
      );
      return { user, record, viaEmail };
    });
    if (!done) this.invalidLink(ip);

    await this.audit.record({
      actor: accountActor(done.user),
      scope: accountScope(done.user),
      storeId: done.user.store_id,
      action: 'auth.password_reset.complete',
      targetType: 'user',
      targetId: done.user.id,
      metadata: {
        via: done.viaEmail ? 'email' : 'platform_link',
        email_verified: done.viaEmail || !!done.user.email_verified_at,
      },
      request,
    });
  }

  /**
   * Superpainel: link de redefinição de senha para uma conta.
   * - Com o SMTP configurado (MailService.configured), o link vai SÓ para o e-mail do titular
   *   ({ url: null, delivered: true }): o operador nunca o vê, então não consegue entrar como a
   *   pessoa (o suporte da plataforma é somente leitura), e o titular fica sabendo. Falha no envio →
   *   o link é anulado e a resposta é 503, sem a URL.
   * - Sem SMTP (driver de log, dev/test ou produção ainda sem provedor), o link aparece só nesta
   *   resposta para o operador repassar por um canal seguro ({ url, delivered: false }).
   * Contas da plataforma (superadmin) não recebem link por aqui: "Esqueci minha senha" ou o comando
   * platform:superadmin no servidor. O banco guarda apenas o hash do link.
   */
  async createLinkForUser(
    userId: number,
    actor: AuthUser,
    request?: Request | null,
  ): Promise<PlatformResetLink> {
    if (!isSuperAdmin(actor)) {
      throw new ForbiddenException(
        'Área exclusiva da administração da plataforma.',
      );
    }
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('Usuário não encontrado');
    if (user.platform_role) {
      throw new ForbiddenException(PLATFORM_ACCOUNT_RESET_MESSAGE);
    }

    const { token, expiresAt } = await this.issueToken(user, {
      createdBy: actor.id,
      ip: requestMeta(request).ip,
    });
    const url = passwordResetUrl(token);
    const viaEmail = this.mail.configured;
    const delivered = viaEmail && (await this.mailLink(user, url)).delivered;
    const audited = {
      actor,
      storeId: user.store_id,
      action: 'user.password_reset_link',
      targetType: 'user',
      targetId: user.id,
      request,
    } as const;

    if (viaEmail && !delivered) {
      // O operador não recebe o link no lugar do e-mail: ele deixa de valer
      await this.expirePending(user.id, new Date());
      await this.audit.record({
        ...audited,
        result: 'FAILURE',
        metadata: { email: user.email, reason: 'mail_not_delivered' },
      });
      throw new ServiceUnavailableException(RESET_LINK_NOT_SENT_MESSAGE);
    }

    await this.audit.record({
      ...audited,
      metadata: { email: user.email, expires_at: expiresAt, delivered },
    });
    return delivered
      ? {
          url: null,
          delivered: true,
          email_masked: maskEmail(user.email),
          expires_at: expiresAt,
        }
      : { url, delivered: false, expires_at: expiresAt };
  }

  /** E-mail com o link de redefinição (marca da loja para a equipe; da plataforma para os demais). */
  private async mailLink(user: User, url: string) {
    return this.mail.send(
      passwordResetMail({
        to: user.email,
        name: user.name,
        url,
        minutes: RESET_TOKEN_TTL_MINUTES,
        brand: await mailBrandForAccount(this.users.manager, user.store_id),
      }),
    );
  }

  // ---------------------------------------------------------------------------

  /** Links de "Esqueci minha senha" já enviados à conta nas últimas 24 h chegaram ao limite? */
  private async recipientLimitReached(userId: number): Promise<boolean> {
    const sent = await this.tokens.count({
      where: {
        user_id: userId,
        created_by_user_id: IsNull(),
        created_at: MoreThan(new Date(Date.now() - RECIPIENT_WINDOW_MS)),
      },
    });
    return sent >= FORGOT_PASSWORD_RECIPIENT_DAILY_LIMIT;
  }

  /** Vence os links pendentes (não usados e no prazo) da conta. */
  private async expirePending(userId: number, now: Date): Promise<void> {
    await this.tokens.update(
      { user_id: userId, used_at: IsNull(), expires_at: MoreThan(now) },
      { expires_at: now },
    );
  }

  /** Cria o link novo e invalida os pendentes da conta (só um link vale por vez). */
  private async issueToken(
    user: User,
    origin: { createdBy: number | null; ip: string | null },
  ): Promise<{ token: string; expiresAt: Date }> {
    const now = new Date();
    await this.expirePending(user.id, now);
    const token = randomToken();
    const expiresAt = new Date(
      now.getTime() + RESET_TOKEN_TTL_MINUTES * 60_000,
    );
    await this.tokens.save(
      this.tokens.create({
        user_id: user.id,
        token_hash: sha256Hex(token),
        expires_at: expiresAt,
        used_at: null,
        created_by_user_id: origin.createdBy,
        requested_ip: origin.ip,
      }),
    );
    return { token, expiresAt };
  }

  /**
   * Conta ativa com o e-mail (sem diferenciar maiúsculas). Contas antigas que diferem só na caixa:
   * vale a gravada exatamente assim (minúsculas), senão a mais antiga.
   */
  private async accountByEmail(email: string): Promise<User | null> {
    const candidates = await this.users
      .createQueryBuilder('u')
      .where('LOWER(u.email) = :email', { email })
      .orderBy('u.id', 'ASC')
      .getMany();
    return (
      candidates.find((user) => user.email === email) ?? candidates[0] ?? null
    );
  }

  /** Link pendente (não usado, dentro do prazo) de uma conta ativa, ou null. */
  private async findUsable(
    token: string,
  ): Promise<{ record: PasswordResetToken; user: User } | null> {
    if (!isLinkToken(token)) return null;
    const record = await this.tokens.findOne({
      where: {
        token_hash: sha256Hex(token),
        used_at: IsNull(),
        expires_at: MoreThan(new Date()),
      },
    });
    if (!record) return null;
    const user = await this.users.findOne({ where: { id: record.user_id } });
    return user ? { record, user } : null;
  }

  /**
   * Link usável ou 404. A tentativa reserva a vaga do IP ANTES da consulta (atômico: uma rajada
   * simultânea de links não passa do limite) e a devolve quando o link é válido.
   */
  private async usableOrInvalid(
    token: string,
    ip: string,
  ): Promise<{ record: PasswordResetToken; user: User }> {
    const release = this.rateLimit.take('TOKEN_REDEEM', ip);
    let found: { record: PasswordResetToken; user: User } | null;
    try {
      found = await this.findUsable(token);
    } catch (error) {
      release();
      throw error;
    }
    if (!found) throw new NotFoundException(RESET_LINK_INVALID_MESSAGE);
    release();
    return found;
  }

  /** Link inválido: conta no limite de tentativas do IP e responde 404 (sempre a mesma mensagem). */
  private invalidLink(ip: string): never {
    this.rateLimit.hit('TOKEN_REDEEM', ip);
    throw new NotFoundException(RESET_LINK_INVALID_MESSAGE);
  }
}
