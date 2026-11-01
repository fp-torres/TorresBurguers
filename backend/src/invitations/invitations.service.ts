import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import {
  type EntityManager,
  type FindOptionsWhere,
  In,
  IsNull,
  LessThanOrEqual,
  MoreThan,
  Not,
  Repository,
} from 'typeorm';
import { maskEmail } from '../audit/audit-sanitize';
import { AuditService } from '../audit/audit.service';
import { type AuthUser, isSuperAdmin } from '../auth/auth-user';
import { clientIpKey, isLinkToken } from '../auth/link-token';
import { SessionTokenService } from '../auth/session-token.service';
import { PlanLimitsService } from '../billing/plan-limits.service';
import { randomToken, sha256Hex } from '../common/crypto/secret-box';
import { isUniqueViolation } from '../common/database-errors';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { appLink } from '../notifications/links';
import { invitationMail } from '../notifications/mail-templates';
import { MailService } from '../notifications/mail.service';
import { Store, StoreAccountStatus } from '../store/entities/store.entity';
import { STORE_NOT_FOUND_MESSAGE } from '../tenancy/tenant.service';
import { accountActor } from '../users/account-actor';
import { normalizeEmail } from '../users/email';
import { PlatformRole, User, UserRole } from '../users/entities/user.entity';
import {
  SESSION_STORE_SELECT,
  type SessionStoreField,
  type SessionUser,
  toSessionUser,
} from '../users/session-user';
import {
  assertStoreId,
  isStaffRole,
  STAFF_ROLE_REQUIRED_MESSAGE,
} from '../users/users.policy';
import { UsersService } from '../users/users.service';
import { Invitation } from './entities/invitation.entity';
import {
  type InvitationStatus,
  type InvitationView,
  invitationStatus,
  type Paginated,
  toInvitationView,
} from './invitation-view';

/** Validade do convite. */
export const INVITATION_TTL_DAYS = 7;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export const INVITATION_INVALID_MESSAGE =
  'Convite inválido, expirado ou já utilizado. Peça um novo convite à loja.';
export const INVITATION_NOT_FOUND_MESSAGE = 'Convite não encontrado.';
export const ACCOUNT_EXISTS_MESSAGE = 'Já existe uma conta com este e-mail.';

/**
 * Convites enviados por UMA loja (POST /store/invitations) para um mesmo e-mail em 24 h (o reenvio
 * também conta) → 429. Por loja: uma loja hostil não bloqueia os convites de outra para o mesmo e-mail.
 * O superpainel não entra nesse limite.
 */
export const INVITATION_RECIPIENT_DAILY_LIMIT = 3;
/**
 * Convites para um mesmo e-mail em 24 h somando TODAS as lojas (e o superpainel): cada um é um e-mail
 * da plataforma, então o destinatário não pode virar alvo de envio em massa. Atingido o teto, o convite
 * da loja é criado SEM e-mail e o link volta para quem convidou repassar (nada é recusado).
 */
export const INVITATION_RECIPIENT_MAIL_DAILY_LIMIT = 10;
/** Convites enviados por uma loja em 24 h (além do TEAM_WRITE, que vale por 10 min). */
export const INVITATION_STORE_DAILY_LIMIT = 100;
const INVITATION_LIMIT_WINDOW_MS = 24 * 60 * 60_000;

export const INVITATION_RECIPIENT_LIMIT_MESSAGE =
  'A loja já enviou muitos convites para este e-mail nas últimas 24 horas. Tente de novo amanhã.';
/** Convite criado sem e-mail (teto por destinatário somando as lojas): o link aparece para repassar. */
export const INVITATION_MAIL_SKIPPED_MESSAGE =
  'O convite foi criado, mas o e-mail não foi enviado agora. Copie o link e envie à pessoa.';
export const INVITATION_STORE_LIMIT_MESSAGE =
  'A loja atingiu o limite de convites das últimas 24 horas. Tente de novo amanhã.';
export const OWNER_INVITATION_PROTECTED_MESSAGE =
  'Este convite de troca do responsável pela loja foi criado pela administração da plataforma: só ela pode cancelá-lo ou substituí-lo.';

/** 429 no formato de erro do contrato ({ statusCode, message, error }). */
function dailyLimitReached(message: string): HttpException {
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      message,
      error: 'Too Many Requests',
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/** Página do site que recebe o convite (frontend web). */
export function invitationUrl(token: string): string {
  return appLink(`/convite/${token}`);
}

export interface CreateInvitationInput {
  /** Loja validada: a do ADMIN autenticado, ou a da rota do superpainel. */
  storeId: number;
  email: string;
  role: string;
  /** Torna o convidado o responsável principal da loja ao aceitar (só o superpainel). */
  makeOwner?: boolean;
  invitedBy: AuthUser;
  request?: Request | null;
  /**
   * Convite do superpainel (POST /platform/stores/:id/invitations): com o SMTP configurado, o link vai
   * SÓ para o convidado (url null, delivered true) e uma falha no envio cancela o convite (503); sem
   * SMTP, o link volta para o operador repassar (delivered false). Mesma regra do link de redefinição.
   */
  deliverOnlyByEmail?: boolean;
}

export interface CreatedInvitation {
  invitation: InvitationView;
  /**
   * Link do convite: aparece só nesta resposta (o banco guarda o hash do token). null quando o convite do
   * superpainel foi entregue por e-mail (deliverOnlyByEmail).
   */
  url: string | null;
  /** O e-mail com o convite foi aceito por um provedor de verdade (SMTP)? */
  delivered: boolean;
  /** Aviso sobre o envio (só no deliverOnlyByEmail entregue: o e-mail mascarado do convidado). */
  message?: string;
}

export const INVITATION_NOT_SENT_MESSAGE =
  'Não foi possível enviar o convite por e-mail, então ele foi cancelado. Confira o envio de e-mails em Configurações e tente de novo.';

/** Convite do superpainel entregue só por e-mail (o link não aparece para o operador). */
export function invitationSentNotice(email: string): string {
  return `Convite enviado por e-mail para ${maskEmail(email)}. O link não aparece aqui: só a pessoa convidada o recebe.`;
}

export interface InvitationPreview {
  store: { name: string; slug: string; logo: string | null };
  email_masked: string;
  role: string;
  expires_at: Date;
}

export interface AcceptInvitationInput {
  name: string;
  password: string;
  phone?: string | null;
}

type StoreSummary = Pick<Store, SessionStoreField>;

/** Conta de quem convidou, como o aceite a confere. */
type Inviter = Pick<
  User,
  'id' | 'role' | 'store_id' | 'platform_role' | 'deleted_at' | 'blocked_at'
>;

const INVITER_SELECT = {
  id: true,
  role: true,
  store_id: true,
  platform_role: true,
  deleted_at: true,
  blocked_at: true,
} as const;

/**
 * Quem convidou ainda pode convidar para a loja? Equipe: ADMIN da MESMA loja, fora da lixeira e sem
 * bloqueio. Plataforma: superadmin ativo. Conta excluída de vez (o FK zera invited_by_user_id),
 * rebaixada, na lixeira ou bloqueada → o convite deixa de valer (um ex-ADMIN não ganha uma conta
 * ADMIN nova depois de perder o acesso).
 */
export function inviterCanStillInvite(
  inviter: Inviter | null | undefined,
  storeId: number,
): boolean {
  if (!inviter || inviter.deleted_at || inviter.blocked_at) return false;
  if (inviter.platform_role) {
    return inviter.platform_role === PlatformRole.SUPER_ADMIN;
  }
  return inviter.store_id === storeId && inviter.role === UserRole.ADMIN;
}

/**
 * Convite de troca do responsável (make_owner, só o superpainel cria) ainda utilizável: a loja não o
 * cancela nem o substitui (vencido, ele pode ser substituído; aceito ou cancelado, já não importa).
 */
export function isProtectedOwnerInvitation(
  invitation: Pick<
    Invitation,
    'make_owner' | 'accepted_at' | 'revoked_at' | 'expires_at'
  >,
  now: Date = new Date(),
): boolean {
  return (
    invitation.make_owner === true &&
    invitationStatus(invitation, now) === 'PENDING'
  );
}

export interface ListInvitationsOptions {
  /**
   * Visão da loja (GET /store/invitations): o id de quem convidou só aparece quando é da equipe da
   * própria loja; convites do superpainel saem com invited_by_user_id null (id interno da plataforma).
   */
  hidePlatformInviters?: boolean;
}

/** Filtro de situação da lista (as datas são avaliadas agora). */
function statusWhere(
  status: InvitationStatus | undefined,
  now: Date,
): FindOptionsWhere<Invitation> {
  switch (status) {
    case 'PENDING':
      return {
        accepted_at: IsNull(),
        revoked_at: IsNull(),
        expires_at: MoreThan(now),
      };
    case 'EXPIRED':
      return {
        accepted_at: IsNull(),
        revoked_at: IsNull(),
        expires_at: LessThanOrEqual(now),
      };
    case 'ACCEPTED':
      return { accepted_at: Not(IsNull()) };
    case 'REVOKED':
      return { accepted_at: IsNull(), revoked_at: Not(IsNull()) };
    default:
      return {};
  }
}

/**
 * Convites para a equipe de uma loja: o token aparece uma única vez (no link) e o banco guarda o
 * SHA-256; vale 7 dias e uma vez só. Aceitar cria a conta da equipe NA LOJA DO CONVITE, com o perfil
 * do convite (nunca com dados enviados por quem aceita), e já faz o login.
 */
@Injectable()
export class InvitationsService {
  constructor(
    @InjectRepository(Invitation)
    private readonly invitations: Repository<Invitation>,
    @InjectRepository(Store)
    private readonly stores: Repository<Store>,
    private readonly users: UsersService,
    private readonly planLimits: PlanLimitsService,
    private readonly sessionTokens: SessionTokenService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /**
   * Cria o convite (e substitui um convite pendente para o mesmo e-mail na mesma loja). E-mail que
   * já tem conta → 409. Envia o link por e-mail e também o devolve (enquanto não há provedor).
   *
   * Pela loja (quem convida não é da plataforma): limites diários por destinatário e por loja (429)
   * e o convite de troca do responsável (make_owner, só o superpainel cria) não é substituído (409).
   * Cada convite substituído entra na auditoria como invitation.revoke (reason: superseded).
   */
  async create(input: CreateInvitationInput): Promise<CreatedInvitation> {
    const { storeId, invitedBy, request } = input;
    assertStoreId(storeId);
    if (!isStaffRole(input.role)) {
      throw new BadRequestException(STAFF_ROLE_REQUIRED_MESSAGE);
    }
    const email = normalizeEmail(input.email);

    // Nome, logo e cor: a marca da loja no e-mail do convite
    const store = await this.stores.findOne({
      where: { id: storeId },
      select: {
        id: true,
        name: true,
        account_status: true,
        logo: true,
        primary_color: true,
      },
    });
    if (!store) throw new NotFoundException(STORE_NOT_FOUND_MESSAGE);
    if (store.account_status === StoreAccountStatus.INACTIVE) {
      throw new BadRequestException(
        'Esta loja está desativada: reative-a antes de convidar a equipe.',
      );
    }
    if (await this.users.emailInUse(email)) {
      // Tentativa registrada: o 409 revela que o e-mail tem conta (sondagem de e-mails fica visível)
      await this.audit.record({
        actor: invitedBy,
        storeId,
        action: 'invitation.create',
        targetType: 'invitation',
        result: 'FAILURE',
        metadata: { email, role: input.role, reason: 'email_in_use' },
        request,
      });
      throw new ConflictException(ACCOUNT_EXISTS_MESSAGE);
    }

    const now = new Date();
    const byPlatform = isSuperAdmin(invitedBy);
    // Convite da loja com o teto de e-mails do destinatário atingido: criado sem e-mail (link para repassar)
    let mailAllowed = true;
    if (!byPlatform) {
      ({ mailAllowed } = await this.assertDailyLimits(
        storeId,
        email,
        input.role,
        invitedBy,
        now,
        request,
      ));
    }

    // Substitui qualquer convite em aberto (inclusive vencido) para o mesmo e-mail nesta loja: o banco
    // garante um único convite em aberto por loja + e-mail (UQ_invitations_store_email_pending)
    const open = await this.invitations.find({
      where: {
        store_id: storeId,
        email,
        accepted_at: IsNull(),
        revoked_at: IsNull(),
      },
    });
    if (
      !byPlatform &&
      open.some((row) => isProtectedOwnerInvitation(row, now))
    ) {
      // A troca do responsável é decisão da plataforma: a loja não a substitui por um convite dela
      throw new ConflictException(OWNER_INVITATION_PROTECTED_MESSAGE);
    }
    if (open.length) {
      // Pelos ids lidos: um convite criado neste meio-tempo não é revogado sem auditoria (o índice
      // único recusa a gravação abaixo com 409)
      await this.invitations.update(
        {
          id: In(open.map((row) => row.id)),
          store_id: storeId,
          accepted_at: IsNull(),
          revoked_at: IsNull(),
        },
        { revoked_at: now },
      );
    }

    const token = randomToken();
    const invitation = await this.saveUnique(
      this.invitations.create({
        store_id: storeId,
        email,
        role: input.role,
        make_owner: input.makeOwner === true,
        token_hash: sha256Hex(token),
        expires_at: new Date(
          now.getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60_000,
        ),
        accepted_at: null,
        accepted_user_id: null,
        revoked_at: null,
        invited_by_user_id: invitedBy.id,
      }),
    );

    const url = invitationUrl(token);
    // Só o convite do superpainel com SMTP exige a entrega; os demais seguem como antes
    const deliveryRequired =
      input.deliverOnlyByEmail === true && this.mail.configured;
    const { delivered } = mailAllowed
      ? await this.mail.send(
          invitationMail({
            to: email,
            store,
            role: input.role,
            url,
            days: INVITATION_TTL_DAYS,
          }),
        )
      : { delivered: false };
    for (const replaced of open) {
      await this.audit.record({
        actor: invitedBy,
        storeId,
        action: 'invitation.revoke',
        targetType: 'invitation',
        targetId: replaced.id,
        metadata: {
          email: replaced.email,
          role: replaced.role,
          make_owner: replaced.make_owner,
          reason: 'superseded',
          replaced_by: invitation.id,
        },
        request,
      });
    }
    await this.audit.record({
      actor: invitedBy,
      storeId,
      action: 'invitation.create',
      targetType: 'invitation',
      targetId: invitation.id,
      metadata: {
        email,
        role: input.role,
        make_owner: invitation.make_owner,
        ...(input.deliverOnlyByEmail ? { delivered } : {}),
        ...(mailAllowed ? {} : { mail_skipped: 'recipient_mail_limit' }),
      },
      request,
    });

    if (deliveryRequired && !delivered) {
      // O operador não recebe o link no lugar do e-mail: o convite é cancelado (falha fechada)
      const revokedAt = new Date();
      await this.invitations.update(
        {
          id: invitation.id,
          store_id: storeId,
          accepted_at: IsNull(),
          revoked_at: IsNull(),
        },
        { revoked_at: revokedAt },
      );
      await this.audit.record({
        actor: invitedBy,
        storeId,
        action: 'invitation.revoke',
        targetType: 'invitation',
        targetId: invitation.id,
        result: 'FAILURE',
        metadata: { email, role: input.role, reason: 'mail_not_delivered' },
        request,
      });
      throw new ServiceUnavailableException(INVITATION_NOT_SENT_MESSAGE);
    }
    if (deliveryRequired) {
      return {
        invitation: toInvitationView(invitation, now),
        url: null,
        delivered: true,
        message: invitationSentNotice(email),
      };
    }
    if (!mailAllowed) {
      return {
        invitation: toInvitationView(invitation, now),
        url,
        delivered: false,
        message: INVITATION_MAIL_SKIPPED_MESSAGE,
      };
    }
    return { invitation: toInvitationView(invitation, now), url, delivered };
  }

  /**
   * Limites diários dos convites enviados pela loja (cada um é um e-mail da plataforma), contados no
   * banco (valem entre instâncias e reinícios): por destinatário NA LOJA e por loja → 429 e tentativa
   * na auditoria. Por destinatário somando todas as lojas, o teto não recusa: mailAllowed false = o
   * convite é criado sem e-mail (uma loja hostil não bloqueia os convites das outras).
   */
  private async assertDailyLimits(
    storeId: number,
    email: string,
    role: string,
    actor: AuthUser,
    now: Date,
    request?: Request | null,
  ): Promise<{ mailAllowed: boolean }> {
    const since = MoreThan(
      new Date(now.getTime() - INVITATION_LIMIT_WINDOW_MS),
    );
    const checks = [
      {
        reason: 'recipient_daily_limit',
        message: INVITATION_RECIPIENT_LIMIT_MESSAGE,
        limit: INVITATION_RECIPIENT_DAILY_LIMIT,
        where: { store_id: storeId, email, created_at: since },
      },
      {
        reason: 'store_daily_limit',
        message: INVITATION_STORE_LIMIT_MESSAGE,
        limit: INVITATION_STORE_DAILY_LIMIT,
        where: { store_id: storeId, created_at: since },
      },
    ];
    for (const check of checks) {
      const sent = await this.invitations.count({ where: check.where });
      if (sent < check.limit) continue;
      await this.audit.record({
        actor,
        storeId,
        action: 'invitation.create',
        targetType: 'invitation',
        result: 'FAILURE',
        metadata: { email, role, reason: check.reason, limit: check.limit },
        request,
      });
      throw dailyLimitReached(check.message);
    }
    const toRecipient = await this.invitations.count({
      where: { email, created_at: since },
    });
    return { mailAllowed: toRecipient < INVITATION_RECIPIENT_MAIL_DAILY_LIMIT };
  }

  /** Grava o convite; outro convite para o mesmo e-mail criado ao mesmo tempo → 409 (sem 500). */
  private async saveUnique(invitation: Invitation): Promise<Invitation> {
    try {
      return await this.invitations.save(invitation);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'Outro convite para este e-mail acabou de ser criado nesta loja. Atualize a lista e tente de novo.',
        );
      }
      throw error;
    }
  }

  /** Convites da loja, do mais novo para o mais antigo (paginado). */
  async listByStore(
    storeId: number,
    query: { page?: number; pageSize?: number; status?: InvitationStatus } = {},
    options: ListInvitationsOptions = {},
  ): Promise<Paginated<InvitationView>> {
    assertStoreId(storeId);
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Math.floor(query.pageSize ?? DEFAULT_PAGE_SIZE)),
    );
    const now = new Date();
    const [rows, total] = await this.invitations.findAndCount({
      where: { store_id: storeId, ...statusWhere(query.status, now) },
      order: { created_at: 'DESC', id: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    const items = rows.map((row) => toInvitationView(row, now));
    return {
      items: options.hidePlatformInviters
        ? await this.withStoreInviters(items, storeId)
        : items,
      total,
      page,
      pageSize,
    };
  }

  /** Cancela um convite da loja (outra loja ou inexistente → 404; já aceito → 409). */
  async revoke(
    id: number,
    storeId: number,
    actor: AuthUser,
    request?: Request | null,
  ): Promise<InvitationView> {
    assertStoreId(storeId);
    const invitation = await this.invitations.findOne({
      where: { id, store_id: storeId },
    });
    if (!invitation) throw new NotFoundException(INVITATION_NOT_FOUND_MESSAGE);
    // Troca do responsável em aberto: só o superpainel cancela (DELETE /platform/invitations/:id)
    if (isProtectedOwnerInvitation(invitation)) {
      throw new ForbiddenException(OWNER_INVITATION_PROTECTED_MESSAGE);
    }
    const view = await this.revokeFound(invitation, actor, request);
    const [visible] = await this.withStoreInviters([view], storeId);
    return visible;
  }

  /**
   * Visão da loja: mantém invited_by_user_id só quando quem convidou é da equipe da própria loja
   * (convites do superpainel → null; o id de uma conta da plataforma não é exposto à loja).
   */
  private async withStoreInviters(
    views: InvitationView[],
    storeId: number,
  ): Promise<InvitationView[]> {
    const ids = [
      ...new Set(
        views
          .map((view) => view.invited_by_user_id)
          .filter((id): id is number => id !== null),
      ),
    ];
    if (!ids.length) return views;
    const inviters = await this.invitations.manager.getRepository(User).find({
      where: { id: In(ids) },
      withDeleted: true,
      select: INVITER_SELECT,
    });
    const team = new Set(
      inviters
        .filter((user) => !user.platform_role && user.store_id === storeId)
        .map((user) => user.id),
    );
    return views.map((view) =>
      view.invited_by_user_id !== null && team.has(view.invited_by_user_id)
        ? view
        : { ...view, invited_by_user_id: null },
    );
  }

  /** Superpainel (DELETE /platform/invitations/:id): convite de qualquer loja. */
  async revokeAsPlatform(
    id: number,
    actor: AuthUser,
    request?: Request | null,
  ): Promise<InvitationView> {
    if (!isSuperAdmin(actor)) {
      throw new ForbiddenException(
        'Área exclusiva da administração da plataforma.',
      );
    }
    const invitation = await this.invitations.findOne({ where: { id } });
    if (!invitation) throw new NotFoundException(INVITATION_NOT_FOUND_MESSAGE);
    return this.revokeFound(invitation, actor, request);
  }

  /** GET /invitations/:token: dados para a tela de aceite. Inválido, usado ou vencido → 404. */
  async inspect(
    token: string,
    request?: Request | null,
  ): Promise<InvitationPreview> {
    const found = await this.usableOrInvalid(token, clientIpKey(request));
    return {
      store: {
        name: found.store.name,
        slug: found.store.slug,
        logo: found.store.logo ?? null,
      },
      email_masked: maskEmail(found.invitation.email),
      role: found.invitation.role,
      expires_at: found.invitation.expires_at,
    };
  }

  /**
   * POST /invitations/:token/accept: cria a conta da equipe na loja do convite (limite de equipe do
   * plano), marca o convite como usado, torna o convidado responsável pela loja se pedido e já
   * devolve a sessão ({ access_token, user }).
   */
  async accept(
    token: string,
    account: AcceptInvitationInput,
    request?: Request | null,
  ): Promise<{ access_token: string; user: SessionUser }> {
    const ip = clientIpKey(request);
    const { invitation: pending, store } = await this.usableOrInvalid(
      token,
      ip,
    );

    if (await this.users.emailInUse(pending.email)) {
      throw new ConflictException(ACCOUNT_EXISTS_MESSAGE);
    }
    await this.planLimits.assertWithinLimit(pending.store_id, 'staff_users');

    const accepted = await this.invitations.manager.transaction(
      async (manager) => {
        const invitations = manager.getRepository(Invitation);
        // Trava o convite: dois aceites simultâneos não criam duas contas
        const invitation = await invitations.findOne({
          where: { id: pending.id, store_id: pending.store_id },
          lock: { mode: 'pessimistic_write' },
        });
        const now = new Date();
        if (
          !invitation ||
          invitationStatus(invitation, now) !== 'PENDING' ||
          !isStaffRole(invitation.role)
        ) {
          return null;
        }
        // Quem convidou ainda pode convidar? Lido com trava compartilhada: um rebaixamento,
        // lixeira ou bloqueio simultâneo espera este aceite terminar, ou o aceite já vê a mudança
        const inviter = await this.inviterOf(invitation, manager, true);
        if (!inviterCanStillInvite(inviter, invitation.store_id)) return null;
        // Limite de equipe rígido: trava por loja e nova contagem nesta transação (aceites simultâneos
        // de convites diferentes não passam do max_staff_users)
        await this.planLimits.lockAndAssert(
          manager,
          invitation.store_id,
          'staff_users',
        );

        const user = await this.users.insertUser(
          manager.getRepository(User),
          {
            name: account.name,
            email: invitation.email,
            password: account.password,
            phone: account.phone ?? null,
          },
          { role: invitation.role, storeId: invitation.store_id },
          ACCOUNT_EXISTS_MESSAGE,
        );
        await invitations.update(
          { id: invitation.id, store_id: invitation.store_id },
          { accepted_at: now, accepted_user_id: user.id },
        );
        if (invitation.make_owner) {
          await manager
            .getRepository(Store)
            .update({ id: invitation.store_id }, { owner_user_id: user.id });
        }
        return { invitation, user };
      },
    );
    if (!accepted) this.invalidLink(ip);

    const { invitation, user } = accepted;
    await this.audit.record({
      actor: accountActor(user),
      scope: 'STORE',
      storeId: invitation.store_id,
      action: 'invitation.accept',
      targetType: 'invitation',
      targetId: invitation.id,
      metadata: {
        user_id: user.id,
        role: invitation.role,
        make_owner: invitation.make_owner,
      },
      request,
    });
    return {
      access_token: this.sessionTokens.issue(user),
      user: toSessionUser(user, store),
    };
  }

  // ---------------------------------------------------------------------------

  private async revokeFound(
    invitation: Invitation,
    actor: AuthUser,
    request?: Request | null,
  ): Promise<InvitationView> {
    if (invitation.accepted_at) {
      throw new ConflictException(
        'Este convite já foi aceito: a pessoa já faz parte da equipe.',
      );
    }
    if (invitation.revoked_at) return toInvitationView(invitation);

    const now = new Date();
    const result = await this.invitations.update(
      {
        id: invitation.id,
        store_id: invitation.store_id,
        accepted_at: IsNull(),
        revoked_at: IsNull(),
      },
      { revoked_at: now },
    );
    if (!result.affected) {
      // Aceito ou cancelado por outra requisição neste meio-tempo
      const current = await this.invitations.findOne({
        where: { id: invitation.id, store_id: invitation.store_id },
      });
      if (!current) throw new NotFoundException(INVITATION_NOT_FOUND_MESSAGE);
      if (current.accepted_at) {
        throw new ConflictException(
          'Este convite já foi aceito: a pessoa já faz parte da equipe.',
        );
      }
      return toInvitationView(current, now);
    }

    await this.audit.record({
      actor,
      storeId: invitation.store_id,
      action: 'invitation.revoke',
      targetType: 'invitation',
      targetId: invitation.id,
      metadata: { email: invitation.email, role: invitation.role },
      request,
    });
    return toInvitationView({ ...invitation, revoked_at: now }, now);
  }

  /** Convite pendente (não aceito, não cancelado, no prazo) de uma loja que não foi desativada. */
  private async findUsable(
    token: string,
  ): Promise<{ invitation: Invitation; store: StoreSummary } | null> {
    if (!isLinkToken(token)) return null;
    const invitation = await this.invitations.findOne({
      where: {
        token_hash: sha256Hex(token),
        accepted_at: IsNull(),
        revoked_at: IsNull(),
        expires_at: MoreThan(new Date()),
      },
    });
    if (!invitation || !isStaffRole(invitation.role)) return null;

    const store = await this.stores.findOne({
      where: { id: invitation.store_id },
      select: SESSION_STORE_SELECT,
    });
    if (!store || store.account_status === StoreAccountStatus.INACTIVE) {
      return null;
    }
    const inviter = await this.inviterOf(invitation, this.invitations.manager);
    if (!inviterCanStillInvite(inviter, invitation.store_id)) return null;
    return { invitation, store };
  }

  /** Conta de quem convidou (inclusive na lixeira); lock: trava compartilhada (FOR SHARE). */
  private inviterOf(
    invitation: Invitation,
    manager: Pick<EntityManager, 'getRepository'>,
    lock = false,
  ): Promise<Inviter | null> {
    if (invitation.invited_by_user_id === null) return Promise.resolve(null);
    return manager.getRepository(User).findOne({
      where: { id: invitation.invited_by_user_id },
      withDeleted: true,
      select: INVITER_SELECT,
      ...(lock ? { lock: { mode: 'pessimistic_read' as const } } : {}),
    });
  }

  /**
   * Convite usável ou 404. A tentativa reserva a vaga do IP ANTES da consulta (atômico: uma rajada
   * simultânea de links não passa do limite TOKEN_REDEEM) e a devolve quando o link é válido.
   */
  private async usableOrInvalid(
    token: string,
    ip: string,
  ): Promise<{ invitation: Invitation; store: StoreSummary }> {
    const release = this.rateLimit.take('TOKEN_REDEEM', ip);
    let found: { invitation: Invitation; store: StoreSummary } | null;
    try {
      found = await this.findUsable(token);
    } catch (error) {
      release();
      throw error;
    }
    if (!found) throw new NotFoundException(INVITATION_INVALID_MESSAGE);
    release();
    return found;
  }

  /** Link inválido: conta no limite de tentativas do IP e responde 404 (sempre a mesma mensagem). */
  private invalidLink(ip: string): never {
    this.rateLimit.hit('TOKEN_REDEEM', ip);
    throw new NotFoundException(INVITATION_INVALID_MESSAGE);
  }
}
