import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import type { Request } from 'express';
import { type EntityManager, Not, Repository } from 'typeorm';
import { maskEmail } from '../audit/audit-sanitize';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth-user';
import { clientIpKey } from '../auth/link-token';
import { expirePendingResetLinks } from '../auth/reset-links';
import { SessionTokenService } from '../auth/session-token.service';
import { isUniqueViolation } from '../common/database-errors';
import {
  type RateLimitRelease,
  RateLimitService,
} from '../common/rate-limit/rate-limit.service';
import { requestMeta } from '../common/request-meta';
import { accountActor, accountScope } from '../users/account-actor';
import { emailEquals, normalizeEmail } from '../users/email';
import { User } from '../users/entities/user.entity';
import type { SessionUser } from '../users/session-user';
import {
  CURRENT_PASSWORD_WRONG_MESSAGE,
  UsersService,
} from '../users/users.service';
import { AccountEmailTokensService } from './account-email-tokens.service';
import { AccountNoticesService } from './account-notices.service';
import {
  type AccountSecurityMode,
  accountSecurityMode,
} from './account-security-mode';
import type {
  ChangePasswordDto,
  RequestEmailChangeDto,
} from './dto/account.dto';
import {
  type AccountEmailToken,
  AccountEmailTokenPurpose,
} from './entities/account-email-token.entity';

const SALT_ROUNDS = 10;
const NEXT_TOKEN_VERSION = () => '"token_version" + 1';
const { VERIFY, CHANGE, REVERT } = AccountEmailTokenPurpose;

export const NEW_PASSWORD_SAME_MESSAGE =
  'A nova senha deve ser diferente da atual.';
export const EMAIL_CHANGE_SAME_MESSAGE = 'Este já é o e-mail da sua conta.';
export const EMAIL_CHANGE_LINK_INVALID_MESSAGE =
  'Link de confirmação inválido ou expirado. Peça a troca de novo em Minha conta.';
export const EMAIL_CHANGE_TAKEN_MESSAGE =
  'Este e-mail passou a ser usado por outra conta. Peça a troca para outro endereço.';
export const EMAIL_CHANGE_DONE_MESSAGE =
  'E-mail alterado. Entre com o novo e-mail.';
export const EMAIL_REVERT_LINK_INVALID_MESSAGE =
  'Link inválido ou expirado. Para recuperar o acesso, use "Esqueci minha senha" ou fale com o suporte.';
export const EMAIL_REVERT_TAKEN_MESSAGE =
  'O e-mail anterior passou a ser usado por outra conta. Fale com o suporte da plataforma.';
export const EMAIL_VERIFICATION_LINK_INVALID_MESSAGE =
  'Link de confirmação inválido ou expirado. Peça um novo em Minha conta.';
export const EMAIL_ALREADY_VERIFIED_MESSAGE = 'Seu e-mail já está confirmado.';
export const EMAIL_VERIFIED_MESSAGE = 'E-mail confirmado.';

export function emailChangeRequestedMessage(email: string): string {
  return `Enviamos um link de confirmação para ${email}. O e-mail da conta só muda depois da confirmação (o link vale 24 horas).`;
}

export function verificationSentMessage(maskedEmail: string): string {
  return `Enviamos um link de confirmação para ${maskedEmail}.`;
}

export function emailRevertDoneMessage(maskedEmail: string): string {
  return `Troca de e-mail desfeita. Entre com ${maskedEmail} e a nova senha.`;
}

export interface PendingEmailChange {
  email: string;
  requested_at: Date;
  expires_at: Date;
}

/** GET /account/security */
export interface AccountSecurityView {
  email: string;
  email_verified: boolean;
  email_verified_at: Date | null;
  email_change: PendingEmailChange | null;
  account_security_mode: AccountSecurityMode;
}

/** Resposta das rotas que emitem sessão (o mesmo formato do login). */
export interface AccountSessionResponse {
  access_token: string;
  user: SessionUser;
}

/** Desfechos do uso de um link: inválido (404) ou e-mail tomado por outra conta (409). */
const INVALID = Symbol('invalid-link');
const TAKEN = Symbol('email-taken');
type Outcome<T> = T | typeof INVALID | typeof TAKEN;

function pendingOf(record: AccountEmailToken): PendingEmailChange {
  return {
    email: record.email,
    requested_at: record.created_at,
    expires_at: record.expires_at,
  };
}

/**
 * Segurança da própria conta (rotas /account, plano email-verification fase 1a): troca de senha com a
 * senha atual, troca de e-mail confirmada no endereço novo (com "Não fui eu" no antigo) e verificação
 * do e-mail. Os links saem do AccountEmailTokensService (uso único, SHA-256 no banco); os e-mails, do
 * AccountNoticesService, em segundo plano.
 *
 * Links públicos (conferir e usar): o IP reserva uma vaga no TOKEN_REDEEM ANTES da consulta (uma rajada
 * simultânea não passa do limite) e a devolve quando o link é válido; link inválido conta como falha.
 */
@Injectable()
export class AccountSecurityService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly usersService: UsersService,
    private readonly tokens: AccountEmailTokensService,
    private readonly notices: AccountNoticesService,
    private readonly sessionTokens: SessionTokenService,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
  ) {}

  // ---------------------------------------------------------------------------
  // Leitura
  // ---------------------------------------------------------------------------

  async view(actor: Pick<AuthUser, 'id'>): Promise<AccountSecurityView> {
    const user = await this.usersService.findAccount(actor.id);
    const pending = await this.tokens.findOpenChange(user.id);
    return {
      email: user.email,
      email_verified: !!user.email_verified_at,
      email_verified_at: user.email_verified_at ?? null,
      email_change: pending ? pendingOf(pending) : null,
      account_security_mode: accountSecurityMode(),
    };
  }

  // ---------------------------------------------------------------------------
  // Troca da própria senha (com a senha atual)
  // ---------------------------------------------------------------------------

  /**
   * POST /account/password: confere a senha atual (errada → 400, conta no CREDENTIALS_CHANGE por
   * conta e por IP), grava a nova, encerra todas as sessões (token_version + 1), vence os links de
   * redefinição e o pedido de troca de e-mail em aberto, audita e avisa o titular. Devolve uma sessão
   * nova para quem trocou (o mesmo caminho de emissão do login: issueSession).
   */
  async changePassword(
    actor: AuthUser,
    dto: ChangePasswordDto,
    request?: Request | null,
  ): Promise<AccountSessionResponse> {
    const user = await this.usersService.findAccount(actor.id);
    const now = new Date();
    await this.withCurrentPassword(
      user.id,
      dto.current_password,
      request,
      async () => {
        if (await this.usersService.passwordMatches(user.id, dto.password)) {
          throw new BadRequestException(NEW_PASSWORD_SAME_MESSAGE);
        }
        const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);
        await this.users.manager.transaction(async (manager) => {
          const result = await manager.getRepository(User).update(
            { id: user.id },
            {
              password_hash: passwordHash,
              token_version: NEXT_TOKEN_VERSION,
            },
          );
          if (!result.affected) {
            throw new NotFoundException('Usuário não encontrado');
          }
          await expirePendingResetLinks(manager, user.id, now);
          await this.tokens.revokeOpen(user.id, [CHANGE], manager, now);
        });
      },
    );

    await this.audit.record({
      actor,
      storeId: user.store_id,
      action: 'account.credentials.change',
      targetType: 'user',
      targetId: user.id,
      metadata: { fields: ['password'], via: 'account_password' },
      request,
    });
    void this.notices.passwordChanged(user, user.email, { changedAt: now });
    return this.issueSession(await this.usersService.findAccount(user.id));
  }

  // ---------------------------------------------------------------------------
  // Troca do próprio e-mail (confirmada no endereço novo)
  // ---------------------------------------------------------------------------

  /**
   * POST /account/email-change: com a senha atual. A resposta (202) e o estado pendente são os MESMOS
   * com o e-mail livre, em uso ou reservado (sem oráculo); só o e-mail que sai é diferente: link de
   * confirmação para o endereço livre, aviso "este e-mail já tem conta" (sem link) para o endereço em
   * uso e nada para o reservado.
   */
  async requestEmailChange(
    actor: AuthUser,
    dto: RequestEmailChangeDto,
    request?: Request | null,
  ): Promise<{ message: string; email_change: PendingEmailChange }> {
    const user = await this.usersService.findAccount(actor.id);
    await this.withCurrentPassword(user.id, dto.current_password, request, () =>
      Promise.resolve(),
    );
    const newEmail = normalizeEmail(dto.email);
    if (newEmail === normalizeEmail(user.email)) {
      throw new BadRequestException(EMAIL_CHANGE_SAME_MESSAGE);
    }
    this.rateLimit.consume('ACCOUNT_EMAIL', `user:${user.id}`);

    const state = await this.addressState(newEmail, user.id);
    const now = new Date();
    const { token, record } = await this.users.manager.transaction(
      async (manager) => {
        // Uma troca por vez por conta: pedidos simultâneos esperam (o UQ parcial garante o resto)
        await this.lockAccount(manager, user.id);
        return this.tokens.issue(
          {
            userId: user.id,
            purpose: CHANGE,
            email: newEmail,
            previousEmail: user.email,
            ip: requestMeta(request).ip,
            now,
          },
          manager,
        );
      },
    );

    if (state === 'free')
      void this.notices.changeConfirm(user, newEmail, token);
    else if (state === 'in_use') void this.notices.changeInUse(newEmail);
    // Em uso ou reservado: FAILURE na auditoria (a sondagem fica visível), mesmo com o HTTP 202
    await this.audit.record({
      actor,
      storeId: user.store_id,
      action: 'auth.email_change.request',
      targetType: 'user',
      targetId: user.id,
      result: state === 'free' ? 'SUCCESS' : 'FAILURE',
      metadata: {
        email: newEmail,
        expires_at: record.expires_at,
        ...(state === 'in_use' ? { reason: 'email_in_use' } : {}),
        ...(state === 'reserved' ? { reason: 'email_reserved' } : {}),
      },
      request,
    });
    return {
      message: emailChangeRequestedMessage(newEmail),
      email_change: pendingOf(record),
    };
  }

  /** DELETE /account/email-change: cancela o pedido em aberto (idempotente). */
  async cancelEmailChange(
    actor: AuthUser,
    request?: Request | null,
  ): Promise<void> {
    const user = await this.usersService.findAccount(actor.id);
    const revoked = await this.tokens.revokeOpen(user.id, [CHANGE]);
    if (revoked > 0) {
      await this.audit.record({
        actor,
        storeId: user.store_id,
        action: 'auth.email_change.cancel',
        targetType: 'user',
        targetId: user.id,
        request,
      });
    }
  }

  /** GET /account/email-change/:token: confere o link sem usá-lo. */
  async inspectEmailChange(
    token: string,
    request?: Request | null,
  ): Promise<{
    current_email_masked: string;
    new_email_masked: string;
    expires_at: Date;
  }> {
    return this.redeeming(
      request,
      EMAIL_CHANGE_LINK_INVALID_MESSAGE,
      async () => {
        const record = await this.tokens.findUsable(token, CHANGE);
        const user = record ? await this.activeAccount(record.user_id) : null;
        if (!record || !user || !this.changeStillApplies(record, user)) {
          return INVALID;
        }
        return {
          view: {
            current_email_masked: maskEmail(user.email),
            new_email_masked: maskEmail(record.email),
            expires_at: record.expires_at,
          },
        };
      },
    ).then((done) => done.view);
  }

  /**
   * POST /account/email-change/confirm: aplica a troca numa transação (token e conta travados):
   * e-mail novo e confirmado, sessões encerradas, link usado, outros pedidos de troca e de verificação
   * cancelados, links de redefinição vencidos e o "Não fui eu" do endereço antigo criado (7 dias).
   * Depois, o aviso com o "Não fui eu" vai para o endereço antigo.
   */
  async confirmEmailChange(
    token: string,
    request?: Request | null,
  ): Promise<{ message: string; email: string }> {
    const done = await this.redeeming(
      request,
      EMAIL_CHANGE_LINK_INVALID_MESSAGE,
      () =>
        this.users.manager.transaction(async (manager) => {
          const record = await this.tokens.findUsable(token, CHANGE, {
            manager,
            lock: true,
          });
          if (!record) return INVALID;
          const user = await this.lockAccount(manager, record.user_id);
          if (!user || !this.changeStillApplies(record, user)) {
            return INVALID;
          }
          if (
            await this.usersService.emailInUse(
              record.email,
              user.id,
              manager.getRepository(User),
            )
          ) {
            return TAKEN;
          }
          const now = new Date();
          const oldEmail = normalizeEmail(user.email);
          await manager.getRepository(User).update(
            { id: user.id },
            {
              email: record.email,
              email_verified_at: now,
              token_version: NEXT_TOKEN_VERSION,
            },
          );
          await this.tokens.markUsed(record.id, manager, now);
          await this.tokens.revokeOpen(user.id, [CHANGE, VERIFY], manager, now);
          await expirePendingResetLinks(manager, user.id, now);
          const revert = await this.tokens.issue(
            {
              userId: user.id,
              purpose: REVERT,
              email: oldEmail,
              previousEmail: record.email,
              ip: requestMeta(request).ip,
              now,
            },
            manager,
          );
          return {
            user,
            oldEmail,
            newEmail: record.email,
            revertToken: revert.token,
            now,
          };
        }),
      EMAIL_CHANGE_TAKEN_MESSAGE,
    );

    void this.notices.emailChanged(done.user, {
      oldEmail: done.oldEmail,
      newEmail: done.newEmail,
      revertToken: done.revertToken,
      changedAt: done.now,
    });
    await this.audit.record({
      actor: accountActor(done.user),
      scope: accountScope(done.user),
      storeId: done.user.store_id,
      action: 'auth.email_change.confirm',
      targetType: 'user',
      targetId: done.user.id,
      metadata: { from: done.oldEmail, to: done.newEmail },
      request,
    });
    return { message: EMAIL_CHANGE_DONE_MESSAGE, email: done.newEmail };
  }

  // ---------------------------------------------------------------------------
  // "Não fui eu" (desfaz a troca, com senha nova)
  // ---------------------------------------------------------------------------

  /** GET /account/email-revert/:token */
  async inspectRevert(
    token: string,
    request?: Request | null,
  ): Promise<{
    restored_email_masked: string;
    replaced_email_masked: string;
    expires_at: Date;
  }> {
    return this.redeeming(
      request,
      EMAIL_REVERT_LINK_INVALID_MESSAGE,
      async () => {
        const record = await this.tokens.findUsable(token, REVERT);
        const user = record ? await this.activeAccount(record.user_id) : null;
        if (!record || !user) return INVALID;
        return {
          view: {
            restored_email_masked: maskEmail(record.email),
            replaced_email_masked: maskEmail(user.email),
            expires_at: record.expires_at,
          },
        };
      },
    ).then((done) => done.view);
  }

  /**
   * POST /account/email-revert: devolve o e-mail antigo à conta (vale mesmo depois de outras trocas,
   * A→B→C), confirmado; grava a senha nova; encerra todas as sessões; cancela TODOS os outros links da
   * conta (inclusive outros "Não fui eu") e vence os de redefinição. Não desbloqueia conta bloqueada.
   * 409 só se o e-mail antigo estiver em outra conta (dado legado). Avisa o endereço substituído.
   */
  async revertEmailChange(
    token: string,
    password: string,
    request?: Request | null,
  ): Promise<{ message: string; email_masked: string }> {
    // Conferência barata antes do bcrypt: link inválido não gasta processamento
    await this.inspectRevert(token, request);
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const done = await this.redeeming(
      request,
      EMAIL_REVERT_LINK_INVALID_MESSAGE,
      () =>
        this.users.manager.transaction(async (manager) => {
          const record = await this.tokens.findUsable(token, REVERT, {
            manager,
            lock: true,
          });
          if (!record) return INVALID;
          const user = await this.lockAccount(manager, record.user_id);
          if (!user) return INVALID;
          if (
            await this.usersService.emailInUse(
              record.email,
              user.id,
              manager.getRepository(User),
            )
          ) {
            return TAKEN;
          }
          const now = new Date();
          const replaced = normalizeEmail(user.email);
          await manager.getRepository(User).update(
            { id: user.id },
            {
              email: record.email,
              email_verified_at: now,
              password_hash: passwordHash,
              token_version: NEXT_TOKEN_VERSION,
            },
          );
          await this.tokens.markUsed(record.id, manager, now);
          await this.tokens.revokeOpen(
            user.id,
            [VERIFY, CHANGE, REVERT],
            manager,
            now,
          );
          await expirePendingResetLinks(manager, user.id, now);
          return {
            user,
            restored: record.email,
            replaced,
          };
        }),
      EMAIL_REVERT_TAKEN_MESSAGE,
    );

    if (done.replaced !== done.restored) {
      void this.notices.changeReverted(done.user, done.replaced, done.restored);
    }
    await this.audit.record({
      actor: accountActor(done.user),
      scope: accountScope(done.user),
      storeId: done.user.store_id,
      action: 'auth.email_change.revert',
      targetType: 'user',
      targetId: done.user.id,
      metadata: { restored: done.restored, replaced: done.replaced },
      request,
    });
    const masked = maskEmail(done.restored);
    return { message: emailRevertDoneMessage(masked), email_masked: masked };
  }

  // ---------------------------------------------------------------------------
  // Verificação do e-mail
  // ---------------------------------------------------------------------------

  /**
   * POST /account/email-verification: novo link para o e-mail da conta (202), ou 200 quando o e-mail já
   * está confirmado. Limite ACCOUNT_EMAIL por conta (429).
   */
  async requestVerification(
    actor: AuthUser,
    request?: Request | null,
  ): Promise<{
    status: HttpStatus.OK | HttpStatus.ACCEPTED;
    body: { message: string; email_verified?: true };
  }> {
    const user = await this.usersService.findAccount(actor.id);
    if (user.email_verified_at) {
      return {
        status: HttpStatus.OK,
        body: { message: EMAIL_ALREADY_VERIFIED_MESSAGE, email_verified: true },
      };
    }
    this.rateLimit.consume('ACCOUNT_EMAIL', `user:${user.id}`);
    const { token } = await this.tokens.issue({
      userId: user.id,
      purpose: VERIFY,
      email: user.email,
      ip: requestMeta(request).ip,
    });
    void this.notices.verification(user, user.email, token);
    await this.audit.record({
      actor,
      storeId: user.store_id,
      action: 'auth.email_verification.request',
      targetType: 'user',
      targetId: user.id,
      metadata: { email: normalizeEmail(user.email) },
      request,
    });
    return {
      status: HttpStatus.ACCEPTED,
      body: { message: verificationSentMessage(maskEmail(user.email)) },
    };
  }

  /** GET /account/email-verification/:token */
  async inspectVerification(
    token: string,
    request?: Request | null,
  ): Promise<{ email_masked: string; expires_at: Date }> {
    return this.redeeming(
      request,
      EMAIL_VERIFICATION_LINK_INVALID_MESSAGE,
      async () => {
        const record = await this.tokens.findUsable(token, VERIFY);
        const user = record ? await this.activeAccount(record.user_id) : null;
        if (!record || !user || normalizeEmail(user.email) !== record.email) {
          return INVALID;
        }
        return {
          view: {
            email_masked: maskEmail(user.email),
            expires_at: record.expires_at,
          },
        };
      },
    ).then((done) => done.view);
  }

  /**
   * POST /account/email-verification/confirm: marca o e-mail como confirmado. 404 se o link não vale
   * ou se o e-mail da conta mudou depois do envio.
   */
  async confirmVerification(
    token: string,
    request?: Request | null,
  ): Promise<{ message: string; email_masked: string }> {
    const done = await this.redeeming(
      request,
      EMAIL_VERIFICATION_LINK_INVALID_MESSAGE,
      () =>
        this.users.manager.transaction(async (manager) => {
          const record = await this.tokens.findUsable(token, VERIFY, {
            manager,
            lock: true,
          });
          if (!record) return INVALID;
          const user = await this.lockAccount(manager, record.user_id);
          if (!user || normalizeEmail(user.email) !== record.email) {
            return INVALID;
          }
          const now = new Date();
          if (!user.email_verified_at) {
            await manager
              .getRepository(User)
              .update({ id: user.id }, { email_verified_at: now });
          }
          await this.tokens.markUsed(record.id, manager, now);
          await this.tokens.revokeOpen(user.id, [VERIFY], manager, now);
          return { user };
        }),
    );

    await this.audit.record({
      actor: accountActor(done.user),
      scope: accountScope(done.user),
      storeId: done.user.store_id,
      action: 'auth.email_verification.confirm',
      targetType: 'user',
      targetId: done.user.id,
      metadata: { email: normalizeEmail(done.user.email) },
      request,
    });
    return {
      message: EMAIL_VERIFIED_MESSAGE,
      email_masked: maskEmail(done.user.email),
    };
  }

  // ---------------------------------------------------------------------------
  // Internos
  // ---------------------------------------------------------------------------

  /**
   * Emissão da sessão de quem trocou a senha: o MESMO caminho do login (SessionTokenService → jti e
   * auth_sessions pelo SessionIssuanceInterceptor). Ponto único para o transporte em cookie da
   * renovação de sessão (plano refresh-token), que o interceptor acrescenta à resposta.
   */
  private async issueSession(user: User): Promise<AccountSessionResponse> {
    return {
      access_token: this.sessionTokens.issue(user),
      user: await this.usersService.presentSession(user),
    };
  }

  /**
   * Confere a senha atual dentro da reserva do CREDENTIALS_CHANGE (conta e IP). Errada → 400 e a
   * tentativa conta no limite; qualquer outro desfecho (sucesso ou erro de outra natureza) devolve a vaga.
   */
  private async withCurrentPassword(
    userId: number,
    currentPassword: string,
    request: Request | null | undefined,
    work: () => Promise<void>,
  ): Promise<void> {
    const release: RateLimitRelease =
      this.usersService.reserveCredentialsAttempt(userId, request);
    let failed = false;
    try {
      if (!(await this.usersService.passwordMatches(userId, currentPassword))) {
        failed = true;
        throw new BadRequestException(CURRENT_PASSWORD_WRONG_MESSAGE);
      }
      await work();
    } finally {
      if (!failed) release();
    }
  }

  /** Situação do endereço pedido: livre, com conta (inclusive na lixeira) ou reservado por outra conta. */
  private async addressState(
    email: string,
    userId: number,
  ): Promise<'free' | 'in_use' | 'reserved'> {
    const taken = await this.users.exists({
      where: { email: emailEquals(email), id: Not(userId) },
      withDeleted: true,
    });
    if (taken) return 'in_use';
    return (await this.tokens.isReserved(email, userId)) ? 'reserved' : 'free';
  }

  /** Conta ativa (fora da lixeira) pelo id, ou null. */
  private activeAccount(userId: number): Promise<User | null> {
    return this.users.findOne({ where: { id: userId } });
  }

  /** Conta ativa travada até o fim da transação (FOR UPDATE), ou null. */
  private lockAccount(
    manager: EntityManager,
    userId: number,
  ): Promise<User | null> {
    return manager.getRepository(User).findOne({
      where: { id: userId },
      lock: { mode: 'pessimistic_write' },
    });
  }

  /**
   * O pedido de troca ainda vale para a conta? Conta bloqueada ou com o e-mail alterado depois do
   * pedido (por outra troca, pelo ADMIN ou pelo "Não fui eu") → não.
   */
  private changeStillApplies(record: AccountEmailToken, user: User): boolean {
    return (
      !user.blocked_at && normalizeEmail(user.email) === record.previous_email
    );
  }

  /**
   * Uso de um link público: reserva a vaga do IP no TOKEN_REDEEM antes da consulta. Link inválido → 404
   * (a tentativa conta); link válido (inclusive o 409 de e-mail tomado, que só quem tem o link vê) →
   * a vaga é devolvida.
   */
  private async redeeming<T extends object>(
    request: Request | null | undefined,
    invalidMessage: string,
    work: () => Promise<Outcome<T>>,
    takenMessage?: string,
  ): Promise<T> {
    const release = this.rateLimit.take('TOKEN_REDEEM', clientIpKey(request));
    let outcome: Outcome<T>;
    try {
      outcome = await work();
    } catch (error) {
      release();
      if (isUniqueViolation(error) && takenMessage) {
        throw new ConflictException(takenMessage);
      }
      throw error;
    }
    if (outcome === INVALID) {
      throw new NotFoundException(invalidMessage);
    }
    release();
    if (outcome === TAKEN) {
      throw new ConflictException(takenMessage ?? invalidMessage);
    }
    return outcome;
  }
}
