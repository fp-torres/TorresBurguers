import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import type { Request } from 'express';
import {
  type FindOptionsWhere,
  In,
  IsNull,
  MoreThan,
  Not,
  type QueryDeepPartialEntity,
  Repository,
  type UpdateResult,
} from 'typeorm';
import { AccountEmailTokensService } from '../account/account-email-tokens.service';
import { AccountNoticesService } from '../account/account-notices.service';
import { AccountEmailTokenPurpose } from '../account/entities/account-email-token.entity';
import { AuditService } from '../audit/audit.service';
import { type AuthUser, isSuperAdmin } from '../auth/auth-user';
import { clientIpKey } from '../auth/link-token';
import { expirePendingResetLinks } from '../auth/reset-links';
import { PlanLimitsService } from '../billing/plan-limits.service';
import {
  isForeignKeyViolation,
  isUniqueViolation,
} from '../common/database-errors';
import {
  type RateLimitRelease,
  RateLimitService,
  teamWriteKey,
} from '../common/rate-limit/rate-limit.service';
import { requestMeta } from '../common/request-meta';
import {
  removeOwnedUpload,
  userFilePrefix,
} from '../common/uploads/owned-files';
import { Invitation } from '../invitations/entities/invitation.entity';
import { Store } from '../store/entities/store.entity';
import { assertAvatarChoice } from './avatar';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { emailEquals, normalizeEmail } from './email';
import { User, UserRole } from './entities/user.entity';
import {
  SESSION_STORE_SELECT,
  type SessionStore,
  type SessionUser,
  type TeamMember,
  toSessionStore,
  toSessionUser,
  toTeamMember,
} from './session-user';
import {
  assertKeepsAnAdmin,
  assertStoreId,
  isStaffRole,
  removesActiveAdmin,
  STAFF_ROLE_REQUIRED_MESSAGE,
} from './users.policy';

const SALT_ROUNDS = 10;
export const EMAIL_TAKEN = 'E-mail já cadastrado';
export const USER_NOT_FOUND = 'Usuário não encontrado';
export const CURRENT_PASSWORD_REQUIRED_MESSAGE =
  'Informe a senha atual para trocar o e-mail ou a senha.';
export const CURRENT_PASSWORD_WRONG_MESSAGE = 'A senha atual não confere.';
export const OWNER_CREDENTIALS_MESSAGE =
  'O e-mail, a senha e o perfil do responsável pela loja só podem ser alterados por ele mesmo ou pela plataforma.';
/**
 * O e-mail tem um convite de troca do responsável (make_owner, criado pela plataforma) pendente nesta
 * loja: uma conta da equipe com ele tornaria o convite inaceitável (409 no aceite).
 */
export const OWNER_INVITATION_EMAIL_MESSAGE =
  'Este e-mail tem um convite pendente da administração da plataforma para assumir a loja como responsável: ele não pode ser usado em outra conta da equipe enquanto o convite valer.';

/** Motivo do 409 de uma troca de e-mail na auditoria. */
function emailConflictReason(error: ConflictException): string {
  return error.message === OWNER_INVITATION_EMAIL_MESSAGE
    ? 'owner_invitation_pending'
    : 'email_in_use';
}
export const OWNER_DELETE_MESSAGE =
  'O responsável pela loja não pode ser excluído pela equipe. Para trocar o responsável, fale com o suporte da plataforma.';

/** Por que os convites pendentes de alguém foram cancelados (auditoria invitation.revoke). */
type InviterRevokeReason =
  | 'inviter_demoted'
  | 'inviter_removed'
  | 'inviter_blocked';

/** Quem age nas operações auditadas: o usuário autenticado (req.user). */
type Operator = Pick<
  AuthUser,
  'id' | 'email' | 'role' | 'storeId' | 'platformRole' | 'supportSession'
>;

/** Dados de uma conta nova (cadastro público, equipe criada pelo ADMIN ou aceite de convite). */
export interface NewAccount {
  name: string;
  email: string;
  password: string;
  phone?: string | null;
  avatar?: string | null;
}

/** Incremento da versão das sessões: todos os tokens já emitidos da conta deixam de valer. */
const NEXT_TOKEN_VERSION = () => '"token_version" + 1';

/** Equipe de UMA loja: nunca clientes nem contas da administração da plataforma. */
function teamScope(storeId: number): FindOptionsWhere<User> {
  assertStoreId(storeId);
  return {
    store_id: storeId,
    role: Not(UserRole.CLIENT),
    platform_role: IsNull(),
  };
}

/** Critério composto das escritas numa conta já lida: id + a loja em que ela estava. */
function accountCriteria(
  user: Pick<User, 'id' | 'store_id'>,
): FindOptionsWhere<User> {
  const storeId = user.store_id ?? null;
  return { id: user.id, store_id: storeId === null ? IsNull() : storeId };
}

function assertAffected(result: UpdateResult | { affected?: number | null }) {
  if (!result.affected) throw new NotFoundException(USER_NOT_FOUND);
}

/** Tentativa errada de trocar as próprias credenciais (conta no limite CREDENTIALS_CHANGE). */
function isFailedCredentialsAttempt(error: unknown): boolean {
  return (
    error instanceof ConflictException ||
    (error instanceof BadRequestException &&
      error.message === CURRENT_PASSWORD_WRONG_MESSAGE)
  );
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Store)
    private readonly stores: Repository<Store>,
    private readonly planLimits: PlanLimitsService,
    private readonly audit: AuditService,
    // Convites pendentes de quem perde o direito de convidar são cancelados (ver revokeInvitationsFrom)
    @InjectRepository(Invitation)
    private readonly invitations: Repository<Invitation>,
    private readonly rateLimit: RateLimitService,
    // Verificação do e-mail: reserva do endereço antigo, links e avisos (account/, plano email-verification)
    private readonly emailTokens: AccountEmailTokensService,
    private readonly notices: AccountNoticesService,
  ) {}

  // ---------------------------------------------------------------------------
  // Sessão (JwtStrategy, login e apresentação)
  // ---------------------------------------------------------------------------

  /** Usuário ativo (não excluído) ou null — usado pela JwtStrategy a cada requisição. */
  findActiveById(id: number): Promise<User | null> {
    return this.usersRepository.findOneBy({ id });
  }

  /**
   * Usado SOMENTE pelo login: é a única consulta que carrega o password_hash.
   * Compara o e-mail sem diferenciar maiúsculas; pode haver mais de uma conta antiga
   * que difere só na caixa, por isso devolve todas (a senha decide qual é).
   */
  findForLogin(email: string): Promise<User[]> {
    return this.usersRepository
      .createQueryBuilder('u')
      .addSelect('u.password_hash')
      .where('LOWER(u.email) = :email', { email: normalizeEmail(email) })
      .orderBy('u.id', 'ASC')
      .getMany();
  }

  /** Resumo da loja exibido na sessão (só as colunas permitidas; nunca credenciais). */
  async storeSummary(
    storeId: number | null | undefined,
  ): Promise<SessionStore | null> {
    if (storeId === null || storeId === undefined) return null;
    const store = await this.stores.findOne({
      where: { id: storeId },
      select: SESSION_STORE_SELECT,
    });
    return toSessionStore(store);
  }

  async presentSession(user: User): Promise<SessionUser> {
    return toSessionUser(user, await this.storeSummary(user.store_id));
  }

  /**
   * A própria conta como a sessão atual a enxerga: perfil, loja e papel global efetivos do req.user
   * (numa sessão de suporte, ADMIN somente leitura da loja da sessão).
   */
  async presentAs(
    user: User,
    session: Pick<AuthUser, 'role' | 'storeId' | 'platformRole'>,
  ): Promise<SessionUser> {
    return {
      ...toSessionUser(user, await this.storeSummary(session.storeId)),
      role: session.role,
      store_id: session.storeId,
      platform_role: session.platformRole,
    };
  }

  /** Lista da equipe/lixeira de UMA loja (o resumo da loja é lido uma vez só). */
  async presentTeam(users: User[], storeId: number): Promise<TeamMember[]> {
    const store = await this.storeSummary(storeId);
    return users.map((user) => toTeamMember(user, store));
  }

  async presentMember(user: User): Promise<TeamMember> {
    return toTeamMember(user, await this.storeSummary(user.store_id));
  }

  /** Último acesso (sem mexer em updated_at, que acompanha as mudanças do cadastro). */
  async recordLogin(userId: number): Promise<void> {
    await this.usersRepository.update(
      { id: userId },
      { last_login_at: new Date(), updated_at: () => '"updated_at"' },
    );
  }

  // ---------------------------------------------------------------------------
  // Cadastro
  // ---------------------------------------------------------------------------

  /**
   * Cadastro público de cliente: conta global, sem loja e sem papel na plataforma.
   * uploadedAvatar: caminho gerado pelo upload desta requisição (o "avatar" em texto só aceita os
   * ícones prontos).
   */
  async createClient(
    dto: CreateUserDto,
    uploadedAvatar?: string,
  ): Promise<User> {
    assertAvatarChoice(dto.avatar);
    const user = await this.insertUser(
      this.usersRepository,
      { ...dto, avatar: uploadedAvatar ?? dto.avatar },
      { role: UserRole.CLIENT, storeId: null },
    );
    // Link de verificação em segundo plano (não atrasa a resposta; não é auditado)
    this.startVerification(user);
    return user;
  }

  /**
   * Envia (em segundo plano) o link de verificação do e-mail atual da conta. Falhas só vão para o log:
   * a pessoa pode pedir outro link em Minha conta. Também usado pelo cadastro de loja no
   * autoatendimento (conta do responsável), depois da transação.
   */
  startVerification(
    user: Pick<User, 'id' | 'email' | 'name' | 'store_id'>,
  ): void {
    void (async () => {
      const { token } = await this.emailTokens.issue({
        userId: user.id,
        purpose: AccountEmailTokenPurpose.VERIFY,
        email: user.email,
      });
      await this.notices.verification(user, user.email, token);
    })().catch((error: unknown) =>
      this.logger.error(
        `Falha ao enviar a verificação de e-mail da conta #${user.id}: ${(error as Error)?.message ?? String(error)}`,
      ),
    );
  }

  /**
   * Conta da equipe criada pelo ADMIN, sempre na loja dele (storeId já validado pelo controller
   * a partir do usuário autenticado). Respeita o limite de equipe do plano. E-mail já usado → 409,
   * registrado na auditoria (a sondagem de e-mails fica visível).
   */
  async createStaff(
    dto: CreateUserDto,
    role: UserRole,
    storeId: number,
    actor: Operator,
    request?: Request | null,
    uploadedAvatar?: string,
  ): Promise<User> {
    if (!isStaffRole(role)) {
      throw new BadRequestException(STAFF_ROLE_REQUIRED_MESSAGE);
    }
    assertStoreId(storeId);
    assertAvatarChoice(dto.avatar);
    try {
      await this.assertNoPendingOwnerInvitation(
        storeId,
        normalizeEmail(dto.email),
      );
    } catch (error) {
      if (error instanceof ConflictException) {
        await this.audit.record({
          actor,
          storeId,
          action: 'store.staff.create',
          targetType: 'user',
          result: 'FAILURE',
          metadata: {
            role,
            email: normalizeEmail(dto.email),
            reason: 'owner_invitation_pending',
          },
          request,
        });
      }
      throw error;
    }
    // Aviso antecipado (sem trava); o limite rígido é conferido de novo na transação da gravação
    await this.planLimits.assertWithinLimit(storeId, 'staff_users');

    let user: User;
    try {
      // Limite de equipe rígido: trava por loja e nova contagem na mesma transação do INSERT (cadastros
      // simultâneos, aceites de convite e restaurações da lixeira não passam do max_staff_users)
      user = await this.usersRepository.manager.transaction(async (manager) => {
        await this.planLimits.lockAndAssert(manager, storeId, 'staff_users');
        return this.insertUser(
          manager.getRepository(User),
          { ...dto, avatar: uploadedAvatar ?? dto.avatar },
          { role, storeId },
        );
      });
    } catch (error) {
      if (error instanceof ConflictException) {
        await this.audit.record({
          actor,
          storeId,
          action: 'store.staff.create',
          targetType: 'user',
          result: 'FAILURE',
          metadata: {
            role,
            email: normalizeEmail(dto.email),
            reason: 'email_in_use',
          },
          request,
        });
      }
      throw error;
    }
    await this.audit.record({
      actor,
      storeId,
      action: 'store.staff.create',
      targetType: 'user',
      targetId: user.id,
      metadata: { role, email: user.email },
      request,
    });
    return user;
  }

  /**
   * Grava a conta nova: e-mail normalizado e livre (inclusive na lixeira), senha só como hash.
   * repository: o da transação de quem chama (ex.: aceite de convite) ou o padrão.
   */
  async insertUser(
    repository: Repository<User>,
    account: NewAccount,
    membership: { role: UserRole; storeId: number | null },
    emailTakenMessage = EMAIL_TAKEN,
  ): Promise<User> {
    const email = normalizeEmail(account.email);
    if (await this.emailInUse(email, undefined, repository)) {
      throw new ConflictException(emailTakenMessage);
    }

    const entity = repository.create({
      name: account.name,
      email,
      phone: account.phone ?? null,
      ...(account.avatar ? { avatar: account.avatar } : {}),
      role: membership.role,
      store_id: membership.storeId,
      platform_role: null,
      password_hash: await bcrypt.hash(account.password, SALT_ROUNDS),
    });

    try {
      return await repository.save(entity);
    } catch (error) {
      // Corrida entre dois cadastros com o mesmo e-mail: a constraint UNIQUE do banco decide
      if (isUniqueViolation(error)) {
        throw new ConflictException(emailTakenMessage);
      }
      throw error;
    }
  }

  /**
   * Alguma conta (inclusive na lixeira) usa o e-mail, sem diferenciar maiúsculas? Também conta como em
   * uso o endereço ANTIGO de uma troca recente de outra conta, enquanto o "Não fui eu" dela está no
   * prazo (7 dias): vale para cadastro, convites, aceite, autoatendimento e equipe.
   */
  async emailInUse(
    email: string,
    ignoreId?: number,
    repository: Repository<User> = this.usersRepository,
  ): Promise<boolean> {
    const taken = await repository.exists({
      where: {
        email: emailEquals(email),
        ...(ignoreId !== undefined ? { id: Not(ignoreId) } : {}),
      },
      withDeleted: true,
    });
    return (
      taken || this.emailTokens.isReserved(email, ignoreId, repository.manager)
    );
  }

  /**
   * 409 se o e-mail tem um convite de troca do responsável (make_owner) pendente NESTA loja: a equipe
   * (ADMIN) não ocupa o e-mail do convidado para tornar o convite inaceitável. Só a própria loja (que já
   * vê o convite na lista): nada é revelado sobre convites de outras lojas.
   */
  private async assertNoPendingOwnerInvitation(
    storeId: number,
    email: string,
  ): Promise<void> {
    const pending = await this.invitations.exists({
      where: {
        store_id: storeId,
        email,
        make_owner: true,
        accepted_at: IsNull(),
        revoked_at: IsNull(),
        expires_at: MoreThan(new Date()),
      },
    });
    if (pending) throw new ConflictException(OWNER_INVITATION_EMAIL_MESSAGE);
  }

  // ---------------------------------------------------------------------------
  // Própria conta
  // ---------------------------------------------------------------------------

  /** Conta ativa (fora da lixeira) pelo id. */
  async findAccount(userId: number): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException(USER_NOT_FOUND);
    return user;
  }

  /**
   * Edição da própria conta (o perfil de acesso não muda por aqui). Trocar o e-mail ou a senha
   * encerra as sessões abertas (token_version + 1): o controller devolve um token novo para quem
   * fez a troca continuar conectado.
   *
   * Reautenticação: com "current_password", a senha atual é conferida (errada → 400). Ela é
   * OBRIGATÓRIA para as contas da plataforma; para as demais continua opcional enquanto o app
   * mobile (fora do escopo) troca e-mail e senha sem enviá-la. Falhas (senha atual errada, e-mail
   * já em uso) contam no limite CREDENTIALS_CHANGE por conta e por IP, e o 409 fica na auditoria.
   */
  async updateSelf(
    actor: Operator,
    dto: UpdateUserDto,
    request?: Request | null,
    uploadedAvatar?: string,
  ): Promise<{ user: User; sessionsRevoked: boolean }> {
    const user = await this.findAccount(actor.id);
    const attempt = this.credentialsAttempt(dto, user, request);
    let failed = false;
    try {
      if (attempt) await this.checkCurrentPassword(user, dto.current_password);
      const changes = await this.changesFrom(dto, user, uploadedAvatar);
      return await this.applySelfChanges(actor, user, changes, request);
    } catch (error) {
      failed = isFailedCredentialsAttempt(error);
      if (error instanceof ConflictException) {
        await this.audit.record({
          actor,
          storeId: user.store_id,
          action: 'account.credentials.change',
          targetType: 'user',
          targetId: user.id,
          result: 'FAILURE',
          metadata: {
            reason: emailConflictReason(error),
            email: dto.email ? normalizeEmail(dto.email) : null,
          },
          request,
        });
      }
      throw error;
    } finally {
      // Sucesso (ou erro que não é uma tentativa errada): a reserva não conta como falha
      if (!failed) attempt?.();
    }
  }

  /**
   * Troca de credenciais pedida (e-mail diferente ou senha nova)? Reserva a vaga no limite
   * CREDENTIALS_CHANGE (conta e IP) e devolve a função que a desfaz; null sem troca de credenciais.
   */
  private credentialsAttempt(
    dto: UpdateUserDto,
    user: User,
    request?: Request | null,
  ): RateLimitRelease | null {
    const emailChange =
      dto.email !== undefined &&
      normalizeEmail(dto.email) !== normalizeEmail(user.email);
    if (!emailChange && !dto.password) return null;
    return this.reserveCredentialsAttempt(user.id, request);
  }

  /**
   * Reserva a vaga de uma troca das próprias credenciais no limite CREDENTIALS_CHANGE (conta e IP; 429
   * se já está no limite) e devolve a função que a desfaz (chame quando a tentativa NÃO falhou).
   * Usado também pelas rotas /account (troca de senha e de e-mail com a senha atual).
   */
  reserveCredentialsAttempt(
    userId: number,
    request?: Request | null,
  ): RateLimitRelease {
    const releaseAccount = this.rateLimit.take(
      'CREDENTIALS_CHANGE',
      `user:${userId}`,
    );
    try {
      const releaseIp = this.rateLimit.take(
        'CREDENTIALS_CHANGE',
        `ip:${clientIpKey(request)}`,
      );
      return () => {
        releaseAccount();
        releaseIp();
      };
    } catch (error) {
      releaseAccount();
      throw error;
    }
  }

  /** A senha confere com a da conta? (lê o hash só para esta comparação) */
  async passwordMatches(userId: number, password: string): Promise<boolean> {
    const stored = await this.usersRepository.findOne({
      where: { id: userId },
      select: { id: true, password_hash: true },
    });
    return (
      !!stored?.password_hash &&
      (await bcrypt.compare(password, stored.password_hash))
    );
  }

  /**
   * Confere a senha atual antes de trocar e-mail ou senha: enviada → precisa conferir (400);
   * ausente → recusada só nas contas da plataforma (as demais aguardam o app mobile enviá-la).
   */
  private async checkCurrentPassword(
    user: User,
    current: string | undefined,
  ): Promise<void> {
    if (!current) {
      if (user.platform_role) {
        throw new BadRequestException(CURRENT_PASSWORD_REQUIRED_MESSAGE);
      }
      return;
    }
    if (!(await this.passwordMatches(user.id, current))) {
      throw new BadRequestException(CURRENT_PASSWORD_WRONG_MESSAGE);
    }
  }

  /**
   * Grava a edição da própria conta. Troca de e-mail pela rota antiga (compat: imediata, sem
   * confirmação), numa transação só: email_verified_at volta para null, os pedidos de troca e de
   * verificação em aberto são cancelados, os links de redefinição pendentes vencem e nascem o "Não fui
   * eu" (REVERT, reserva o endereço antigo por 7 dias) e a verificação do endereço novo. Depois do
   * commit saem os avisos: endereço antigo (com o "Não fui eu"), endereço novo (verificação) e senha
   * alterada, quando houver.
   */
  private async applySelfChanges(
    actor: Operator,
    user: User,
    changes: {
      data: QueryDeepPartialEntity<User>;
      fields: string[];
      credentials: boolean;
    },
    request?: Request | null,
  ): Promise<{ user: User; sessionsRevoked: boolean }> {
    const { data, fields, credentials } = changes;
    const emailChanged = fields.includes('email');
    const passwordChanged = fields.includes('password');
    const oldEmail = normalizeEmail(user.email);
    const newEmail =
      typeof data.email === 'string' ? data.email : normalizeEmail(user.email);
    const now = new Date();
    let links: { revert: string; verify: string } | null = null;

    if (Object.keys(data).length > 0) {
      const previousAvatar = user.avatar;
      if (credentials) data.token_version = NEXT_TOKEN_VERSION;
      if (emailChanged) data.email_verified_at = null;
      links = await this.writing(() =>
        this.usersRepository.manager.transaction(async (manager) => {
          assertAffected(
            await manager
              .getRepository(User)
              .update(accountCriteria(user), data),
          );
          if (!credentials) return null;
          // Link de redefinição enviado à caixa antiga não pode redefinir a senha depois da troca
          await expirePendingResetLinks(manager, user.id, now);
          await this.emailTokens.revokeOpen(
            user.id,
            emailChanged
              ? [
                  AccountEmailTokenPurpose.CHANGE,
                  AccountEmailTokenPurpose.VERIFY,
                ]
              : [AccountEmailTokenPurpose.CHANGE],
            manager,
            now,
          );
          if (!emailChanged) return null;
          const ip = requestMeta(request).ip;
          const revert = await this.emailTokens.issue(
            {
              userId: user.id,
              purpose: AccountEmailTokenPurpose.REVERT,
              email: oldEmail,
              previousEmail: newEmail,
              ip,
              now,
            },
            manager,
          );
          const verify = await this.emailTokens.issue(
            {
              userId: user.id,
              purpose: AccountEmailTokenPurpose.VERIFY,
              email: newEmail,
              ip,
              now,
            },
            manager,
          );
          return { revert: revert.token, verify: verify.token };
        }),
      );
      await this.discardReplacedAvatar(user.id, previousAvatar, data);
    }
    if (credentials) {
      await this.audit.record({
        actor,
        storeId: user.store_id,
        action: 'account.credentials.change',
        targetType: 'user',
        targetId: user.id,
        metadata: { fields, ...(links ? { revert_link: true } : {}) },
        request,
      });
      // Avisos em segundo plano (nunca lançam): o titular fica sabendo pelo endereço que tinha
      if (links) {
        void this.notices.emailChanged(user, {
          oldEmail,
          newEmail,
          revertToken: links.revert,
          changedAt: now,
        });
        void this.notices.verification(user, newEmail, links.verify);
      }
      if (passwordChanged) {
        void this.notices.passwordChanged(user, oldEmail, { changedAt: now });
      }
    }
    return {
      user: await this.findAccount(actor.id),
      sessionsRevoked: credentials,
    };
  }

  /** A própria conta vai para a lixeira (o ADMIN e o superadmin são barrados na política). */
  async removeSelf(
    actor: Operator,
    request?: Request | null,
  ): Promise<{ message: string }> {
    const user = await this.findAccount(actor.id);
    await this.keepingAnAdmin(user, null, (users) => this.trash(users, user));
    await this.expireResetLinks(user.id);
    await this.audit.record({
      actor,
      storeId: user.store_id,
      action: 'account.delete',
      targetType: 'user',
      targetId: user.id,
      request,
    });
    return { message: 'Usuário removido.' };
  }

  // ---------------------------------------------------------------------------
  // Equipe da loja (storeId SEMPRE do usuário autenticado, validado antes)
  // ---------------------------------------------------------------------------

  async findTeam(storeId: number): Promise<User[]> {
    return this.usersRepository.find({
      where: teamScope(storeId),
      order: { created_at: 'DESC', id: 'DESC' },
    });
  }

  async findTrash(storeId: number): Promise<User[]> {
    return this.usersRepository.find({
      withDeleted: true,
      where: { ...teamScope(storeId), deleted_at: Not(IsNull()) },
      order: { deleted_at: 'DESC', id: 'DESC' },
    });
  }

  /**
   * Membro da equipe da loja. Cliente, equipe de outra loja, conta da plataforma ou inexistente
   * → 404 uniforme (nunca revela que a conta existe).
   */
  async findTeamMember(
    id: number,
    storeId: number,
    options: { withDeleted?: boolean } = {},
  ): Promise<User> {
    const user = await this.usersRepository.findOne({
      where: { id, ...teamScope(storeId) },
      withDeleted: options.withDeleted ?? false,
    });
    if (!user) throw new NotFoundException(USER_NOT_FOUND);
    return user;
  }

  /**
   * ADMIN editando um membro da equipe da própria loja. Perfil só entre perfis da equipe; troca de
   * perfil, e-mail ou senha encerra as sessões do membro. A loja não pode ficar sem ADMIN.
   * O responsável pela loja (stores.owner_user_id) não tem e-mail, senha nem perfil alterados pela
   * equipe (403). Trocar o e-mail de um membro conta no limite TEAM_WRITE da loja; e-mail já usado
   * → 409, registrado na auditoria. Quem deixa de ser ADMIN tem os convites pendentes cancelados.
   */
  async updateTeamMember(
    id: number,
    storeId: number,
    dto: UpdateUserDto,
    actor: Operator,
    request?: Request | null,
    uploadedAvatar?: string,
  ): Promise<User> {
    const target = await this.findTeamMember(id, storeId);
    if (dto.role !== undefined && !isStaffRole(dto.role)) {
      throw new BadRequestException(STAFF_ROLE_REQUIRED_MESSAGE);
    }
    const previousRole = target.role;
    const previousEmail = normalizeEmail(target.email);
    const nextRole = dto.role ?? previousRole;
    const roleChanged = nextRole !== previousRole;
    const emailChange =
      dto.email !== undefined &&
      normalizeEmail(dto.email) !== normalizeEmail(target.email);
    if (
      (emailChange || dto.password || roleChanged) &&
      (await this.isStoreOwner(target))
    ) {
      throw new ForbiddenException(OWNER_CREDENTIALS_MESSAGE);
    }
    if (emailChange)
      this.rateLimit.consume('TEAM_WRITE', teamWriteKey(storeId));

    let changes: Awaited<ReturnType<UsersService['changesFrom']>>;
    try {
      changes = await this.changesFrom(dto, target, uploadedAvatar);
    } catch (error) {
      if (error instanceof ConflictException) {
        await this.audit.record({
          actor,
          storeId,
          action: 'store.staff.update',
          targetType: 'user',
          targetId: id,
          result: 'FAILURE',
          metadata: {
            reason: emailConflictReason(error),
            email: normalizeEmail(dto.email ?? ''),
          },
          request,
        });
      }
      throw error;
    }
    const { data, fields, credentials } = changes;
    if (roleChanged) {
      data.role = nextRole;
      fields.push('role');
    }
    const memberEmailChanged = fields.includes('email');
    const memberPasswordChanged = fields.includes('password');

    if (Object.keys(data).length > 0) {
      const previousAvatar = target.avatar;
      if (credentials || roleChanged) data.token_version = NEXT_TOKEN_VERSION;
      // E-mail definido pelo ADMIN: o endereço novo ainda não foi confirmado pelo membro
      if (memberEmailChanged) data.email_verified_at = null;
      await this.writing(() =>
        this.keepingAnAdmin(target, nextRole, async (users) =>
          assertAffected(
            await users.update(
              { id, store_id: storeId, deleted_at: IsNull() },
              data,
            ),
          ),
        ),
      );
      // Quem pediu um link antes de o ADMIN trocar e-mail/senha não volta a entrar por ele
      if (credentials) await this.expireResetLinks(target.id);
      if (credentials) {
        await this.notifyMemberCredentials(target, {
          oldEmail: previousEmail,
          newEmail: memberEmailChanged ? (data.email as string) : null,
          password: memberPasswordChanged,
          request,
        });
      }
      await this.discardReplacedAvatar(target.id, previousAvatar, data);
      if (previousRole === UserRole.ADMIN && nextRole !== UserRole.ADMIN) {
        await this.revokeInvitationsFrom(
          target.id,
          actor,
          request,
          'inviter_demoted',
        );
      }
      await this.audit.record({
        actor,
        storeId,
        action: 'store.staff.update',
        targetType: 'user',
        targetId: id,
        metadata: {
          fields,
          ...(roleChanged
            ? { role_from: previousRole, role_to: nextRole }
            : {}),
          sessions_revoked: credentials || roleChanged,
        },
        request,
      });
    }
    return this.findTeamMember(id, storeId);
  }

  /** ADMIN mandando um membro da equipe da própria loja para a lixeira. */
  async removeTeamMember(
    id: number,
    storeId: number,
    actor: Operator,
    request?: Request | null,
  ): Promise<{ message: string }> {
    const target = await this.findTeamMember(id, storeId);
    if (await this.isStoreOwner(target)) {
      throw new ForbiddenException(OWNER_DELETE_MESSAGE);
    }
    await this.keepingAnAdmin(target, null, (users) =>
      this.trash(users, target),
    );
    await this.expireResetLinks(target.id);
    await this.revokeInvitationsFrom(
      target.id,
      actor,
      request,
      'inviter_removed',
    );
    await this.audit.record({
      actor,
      storeId,
      action: 'store.staff.delete',
      targetType: 'user',
      targetId: id,
      metadata: { role: target.role },
      request,
    });
    return { message: 'Usuário removido.' };
  }

  /** Restaura da lixeira um membro da equipe da própria loja (volta a contar no limite do plano). */
  async restore(
    id: number,
    storeId: number,
    actor: Operator,
    request?: Request | null,
  ): Promise<User> {
    const target = await this.findTeamMember(id, storeId, {
      withDeleted: true,
    });
    if (target.deleted_at) {
      // Limite de equipe rígido: trava por loja e nova contagem na transação da restauração
      await this.usersRepository.manager.transaction(async (manager) => {
        await this.planLimits.lockAndAssert(manager, storeId, 'staff_users');
        await manager.getRepository(User).restore({ id, store_id: storeId });
      });
      await this.audit.record({
        actor,
        storeId,
        action: 'store.staff.restore',
        targetType: 'user',
        targetId: id,
        request,
      });
    }
    return this.findTeamMember(id, storeId);
  }

  /**
   * Exclusão definitiva de um membro da equipe que JÁ está na lixeira. Contas com pedidos não podem
   * ser apagadas (o histórico precisa delas).
   */
  async purge(
    id: number,
    storeId: number,
    actor: Operator,
    request?: Request | null,
  ): Promise<{ message: string }> {
    const target = await this.findTeamMember(id, storeId, {
      withDeleted: true,
    });
    if (!target.deleted_at) {
      throw new BadRequestException(
        'Mova o usuário para a lixeira antes de excluí-lo definitivamente.',
      );
    }
    if (await this.isStoreOwner(target)) {
      throw new ForbiddenException(OWNER_DELETE_MESSAGE);
    }

    try {
      await this.keepingAnAdmin(target, null, async (users) =>
        assertAffected(
          await users.delete({
            id,
            store_id: storeId,
            deleted_at: Not(IsNull()),
          }),
        ),
      );
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new ConflictException(
          'Não é possível excluir definitivamente: o usuário possui pedidos vinculados.',
        );
      }
      throw error;
    }
    await this.audit.record({
      actor,
      storeId,
      action: 'store.staff.purge',
      targetType: 'user',
      targetId: id,
      metadata: { email: target.email, role: target.role },
      request,
    });
    return { message: 'Usuário excluído definitivamente.' };
  }

  // ---------------------------------------------------------------------------
  // Superpainel: bloqueio e sessões (somente SUPER_ADMIN; tudo auditado)
  // ---------------------------------------------------------------------------

  /** Bloqueia a conta: o login é recusado e as sessões abertas caem na hora. */
  async block(
    userId: number,
    reason: string | null | undefined,
    actor: Operator,
    request?: Request | null,
  ): Promise<User> {
    this.assertPlatformOperator(actor);
    if (userId === actor.id) {
      throw new BadRequestException('Você não pode bloquear a própria conta.');
    }
    const user = await this.findAccount(userId);
    const text = reason?.trim().slice(0, 300) || null;
    assertAffected(
      await this.usersRepository.update(
        { ...accountCriteria(user), deleted_at: IsNull() },
        {
          blocked_at: new Date(),
          blocked_reason: text,
          token_version: NEXT_TOKEN_VERSION,
        },
      ),
    );
    // Convites que a conta bloqueada criou deixam de valer (ela não volta como outra conta)
    // Um link pendente redefiniria a senha e voltaria a valer no desbloqueio
    await this.expireResetLinks(userId);
    // Pedidos de troca e de verificação do e-mail em aberto também caem. O "Não fui eu" (REVERT) fica:
    // o dono do endereço antigo ainda pode recuperá-lo (a conta continua bloqueada)
    await this.emailTokens.revokeOpen(userId, [
      AccountEmailTokenPurpose.CHANGE,
      AccountEmailTokenPurpose.VERIFY,
    ]);
    await this.revokeInvitationsFrom(userId, actor, request, 'inviter_blocked');
    await this.audit.record({
      actor,
      storeId: user.store_id,
      action: 'user.block',
      targetType: 'user',
      targetId: userId,
      metadata: { email: user.email, reason: text },
      request,
    });
    return this.findAccount(userId);
  }

  async unblock(
    userId: number,
    actor: Operator,
    request?: Request | null,
  ): Promise<User> {
    this.assertPlatformOperator(actor);
    const user = await this.findAccount(userId);
    assertAffected(
      await this.usersRepository.update(
        { ...accountCriteria(user), deleted_at: IsNull() },
        {
          blocked_at: null,
          blocked_reason: null,
          token_version: NEXT_TOKEN_VERSION,
        },
      ),
    );
    await this.audit.record({
      actor,
      storeId: user.store_id,
      action: 'user.unblock',
      targetType: 'user',
      targetId: userId,
      metadata: { email: user.email },
      request,
    });
    return this.findAccount(userId);
  }

  /**
   * Encerra todas as sessões da conta (token_version + 1). A própria pessoa ("sair de todos os
   * dispositivos") ou o superadmin.
   */
  async revokeSessions(
    userId: number,
    actor: Operator,
    request?: Request | null,
  ): Promise<void> {
    const self = userId === actor.id;
    if (!self) this.assertPlatformOperator(actor);
    const user = await this.findAccount(userId);
    assertAffected(
      await this.usersRepository.update(
        { ...accountCriteria(user), deleted_at: IsNull() },
        { token_version: NEXT_TOKEN_VERSION },
      ),
    );
    // "Sair de todos os aparelhos" também tira o acesso de quem tem um link de redefinição pendente
    await this.expireResetLinks(userId);
    await this.audit.record({
      actor,
      storeId: user.store_id,
      action: self ? 'auth.logout_all' : 'user.revoke_sessions',
      targetType: 'user',
      targetId: userId,
      request,
    });
  }

  // ---------------------------------------------------------------------------
  // Internos
  // ---------------------------------------------------------------------------

  private assertPlatformOperator(actor: Operator): void {
    if (!isSuperAdmin(actor)) {
      throw new ForbiddenException(
        'Área exclusiva da administração da plataforma.',
      );
    }
  }

  /** A conta é o responsável pela loja dela (stores.owner_user_id, definido pelo superpainel)? */
  private async isStoreOwner(
    user: Pick<User, 'id' | 'store_id'>,
  ): Promise<boolean> {
    if (user.store_id === null || user.store_id === undefined) return false;
    const store = await this.stores.findOne({
      where: { id: user.store_id },
      select: { id: true, owner_user_id: true },
    });
    return store?.owner_user_id === user.id;
  }

  /**
   * Foto trocada: apaga o arquivo anterior quando ele é da PRÓPRIA conta (prefixo u<id>-). Arquivos
   * sem dono, de outra conta ou de uma loja nunca são apagados por aqui.
   */
  private async discardReplacedAvatar(
    userId: number,
    previousAvatar: string | null | undefined,
    data: QueryDeepPartialEntity<User>,
  ): Promise<void> {
    if (data.avatar === undefined || data.avatar === previousAvatar) return;
    await removeOwnedUpload(previousAvatar, userFilePrefix(userId));
  }

  /**
   * Cancela os convites pendentes (no prazo) criados pela conta que perdeu o direito de convidar
   * (rebaixada, na lixeira ou bloqueada) e audita cada um. O aceite também confere quem convidou,
   * então isto deixa o estado explícito na lista de convites (REVOKED em vez de PENDING).
   */
  private async revokeInvitationsFrom(
    inviterId: number,
    actor: Operator,
    request: Request | null | undefined,
    reason: InviterRevokeReason,
  ): Promise<void> {
    const now = new Date();
    const pending = await this.invitations.find({
      where: {
        invited_by_user_id: inviterId,
        accepted_at: IsNull(),
        revoked_at: IsNull(),
        expires_at: MoreThan(now),
      },
      select: { id: true, store_id: true, email: true, role: true },
    });
    if (!pending.length) return;
    await this.invitations.update(
      {
        id: In(pending.map((invitation) => invitation.id)),
        accepted_at: IsNull(),
        revoked_at: IsNull(),
      },
      { revoked_at: now },
    );
    for (const invitation of pending) {
      await this.audit.record({
        actor,
        storeId: invitation.store_id,
        action: 'invitation.revoke',
        targetType: 'invitation',
        targetId: invitation.id,
        metadata: {
          email: invitation.email,
          role: invitation.role,
          reason,
          inviter_user_id: inviterId,
        },
        request,
      });
    }
  }

  /**
   * Campos do cadastro que mudam (nome, telefone, foto, e-mail e senha). credentials = o e-mail
   * mudou de verdade (não só a caixa) ou uma senha nova foi enviada. Nunca inclui o perfil.
   * uploadedAvatar: caminho gerado pelo upload desta requisição; o "avatar" em texto só aceita os
   * ícones prontos ou o valor atual (400 para URLs externas e arquivos de outro dono).
   */
  private async changesFrom(
    dto: UpdateUserDto,
    target: User,
    uploadedAvatar?: string,
  ): Promise<{
    data: QueryDeepPartialEntity<User>;
    fields: string[];
    credentials: boolean;
  }> {
    const data: QueryDeepPartialEntity<User> = {};
    const fields: string[] = [];
    let credentials = false;

    if (dto.name !== undefined) {
      data.name = dto.name;
      fields.push('name');
    }
    // null (o DTO converte texto vazio em null) remove o telefone
    if (dto.phone !== undefined) {
      data.phone = dto.phone;
      fields.push('phone');
    }
    // Sem avatar (undefined) mantém a foto atual
    assertAvatarChoice(dto.avatar, target.avatar);
    const avatar = uploadedAvatar ?? dto.avatar;
    if (avatar !== undefined && avatar !== target.avatar) {
      data.avatar = avatar;
      fields.push('avatar');
    }

    if (dto.email !== undefined) {
      const email = normalizeEmail(dto.email);
      if (email !== normalizeEmail(target.email)) {
        if (await this.emailInUse(email, target.id)) {
          throw new ConflictException(EMAIL_TAKEN);
        }
        // Equipe de loja (a própria conta do ADMIN ou um membro): não ocupa o e-mail do novo responsável
        if (isStaffRole(target.role) && typeof target.store_id === 'number') {
          await this.assertNoPendingOwnerInvitation(target.store_id, email);
        }
        credentials = true;
        fields.push('email');
      }
      // Mesma conta com outra caixa: só normaliza o que está gravado
      if (email !== target.email) data.email = email;
    }

    // Nova senha é sempre gravada como hash
    if (dto.password) {
      data.password_hash = await bcrypt.hash(dto.password, SALT_ROUNDS);
      credentials = true;
      fields.push('password');
    }

    return { data, fields, credentials };
  }

  /**
   * ADMIN trocou o e-mail ou a senha de um membro (compat): os pedidos de troca/verificação do membro em
   * aberto caem; com e-mail novo, nasce a verificação dele. Avisos em segundo plano, sem "desfazer"
   * (quem decide é a loja): ao endereço que o membro tinha e, com e-mail novo, a verificação.
   */
  private async notifyMemberCredentials(
    target: User,
    change: {
      oldEmail: string;
      newEmail: string | null;
      password: boolean;
      request?: Request | null;
    },
  ): Promise<void> {
    const now = new Date();
    const oldEmail = change.oldEmail;
    await this.emailTokens.revokeOpen(
      target.id,
      change.newEmail
        ? [AccountEmailTokenPurpose.CHANGE, AccountEmailTokenPurpose.VERIFY]
        : [AccountEmailTokenPurpose.CHANGE],
      undefined,
      now,
    );
    if (change.newEmail) {
      const newEmail = change.newEmail;
      const { token } = await this.emailTokens.issue({
        userId: target.id,
        purpose: AccountEmailTokenPurpose.VERIFY,
        email: newEmail,
        ip: requestMeta(change.request).ip,
        now,
      });
      void this.notices.emailChanged(target, {
        oldEmail,
        newEmail,
        revertToken: null,
        byStoreAdmin: true,
        changedAt: now,
      });
      void this.notices.verification(target, newEmail, token);
    }
    if (change.password) {
      void this.notices.passwordChanged(target, oldEmail, {
        byStoreAdmin: true,
        changedAt: now,
      });
    }
  }

  /** Vence os links de redefinição de senha pendentes da conta (ver expirePendingResetLinks). */
  private expireResetLinks(userId: number): Promise<void> {
    return expirePendingResetLinks(this.usersRepository.manager, userId);
  }

  /** Converte a corrida de e-mail repetido (UNIQUE do banco) em 409. */
  private async writing<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(EMAIL_TAKEN);
      throw error;
    }
  }

  /** Lixeira: encerra as sessões e marca deleted_at, numa escrita só (critério composto id + loja). */
  private async trash(users: Repository<User>, target: User): Promise<void> {
    assertAffected(
      await users.update(
        { ...accountCriteria(target), deleted_at: IsNull() },
        { deleted_at: new Date(), token_version: NEXT_TOKEN_VERSION },
      ),
    );
  }

  /**
   * Executa a alteração garantindo que a loja do alvo continue com pelo menos um ADMIN ativo.
   * Quando a operação tira um ADMIN do grupo (rebaixamento, lixeira ou exclusão definitiva), só os
   * ADMINs DAQUELA loja ficam travados (SELECT ... ORDER BY id FOR UPDATE, sempre na mesma ordem
   * para não haver deadlock) até o fim da transação: dois administradores excluindo um ao outro ao
   * mesmo tempo não deixam a loja sem ADMIN, e outras lojas não esperam.
   */
  private async keepingAnAdmin<T>(
    target: User,
    nextRole: UserRole | null,
    action: (users: Repository<User>) => Promise<T>,
  ): Promise<T> {
    if (!removesActiveAdmin(target, nextRole) || target.store_id === null) {
      return action(this.usersRepository);
    }

    return this.usersRepository.manager.transaction(async (manager) => {
      const users = manager.getRepository(User);
      const admins = await users
        .createQueryBuilder('u')
        .select('u.id')
        .where('u.store_id = :storeId', { storeId: target.store_id })
        .andWhere('u.role = :role', { role: UserRole.ADMIN })
        .andWhere('u.blocked_at IS NULL')
        .orderBy('u.id', 'ASC')
        .setLock('pessimistic_write')
        .getMany(); // a lixeira (deleted_at) fica de fora automaticamente
      assertKeepsAnAdmin(
        target,
        nextRole,
        admins.map((admin) => admin.id),
      );
      return action(users);
    });
  }
}
