import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { UsersService } from '../users/users.service';
import { PlatformRole, UserRole } from '../users/entities/user.entity';
import { SupportSession } from '../platform/entities/support-session.entity';
import { jwtSecret } from '../config/jwt';
import { AuthUser, JwtPayload } from './auth-user';
import { AuthSessionsService } from './auth-sessions.service';
import { AuthSession, AuthSessionKind } from './entities/auth-session.entity';
import { legacyTokenAccepted } from './legacy-token';

export const INVALID_SESSION_MESSAGE =
  'Sessão inválida ou expirada. Faça login novamente.';
export const BLOCKED_ACCOUNT_MESSAGE =
  'Esta conta está bloqueada. Fale com o suporte da plataforma.';
export const SUPPORT_SESSION_ENDED_MESSAGE =
  'A sessão de suporte terminou ou expirou. Inicie outra pelo superpainel.';

/** Formato do "jti" emitido pela API (UUID): outro formato nem chega ao banco. */
const JTI_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly usersService: UsersService,
    @InjectRepository(SupportSession)
    private readonly supportSessions: Repository<SupportSession>,
    // Sempre presente no AuthModule. Sem ele (montagens parciais em testes), token com "jti" → 401
    @Optional() private readonly authSessions?: AuthSessionsService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // Algoritmo fixo: tokens com outro "alg" (inclusive "none") são recusados
      algorithms: ['HS256'],
      // Mesmo segredo usado na assinatura (AuthModule) — fonte única em config/jwt.ts
      secretOrKey: jwtSecret(),
    });
  }

  /**
   * Recarrega o usuário a cada requisição:
   * - conta inexistente, excluída (lixeira) ou bloqueada → 401, mesmo com token ainda válido;
   * - token de uma versão de sessão antiga (senha redefinida, "encerrar sessões", bloqueio) → 401;
   * - token com "jti": a sessão dele (auth_sessions) precisa existir, ser da conta, não estar encerrada
   *   (logout, revogação) nem vencida → senão 401. UMA consulta pelo índice único do jti, que já traz a
   *   sessão de suporte. O jti identifica a SESSÃO, não o token: na sessão do site em cookie, todos os
   *   tokens de acesso renovados da família levam o mesmo jti (logout e revogação valem para todos).
   *   Token sem "jti" (emitido antes das sessões) só vale na janela de transição
   *   (JWT_LEGACY_ISSUED_BEFORE; em produção, sem ela, nenhum vale): ver legacyTokenAccepted;
   * - perfil, loja e papel global devolvidos são os ATUAIS do banco (mudanças valem na hora).
   * O contexto de loja da equipe vem daqui, nunca de cabeçalho, corpo ou URL enviados pelo cliente.
   */
  async validate(payload: Partial<JwtPayload>): Promise<AuthUser> {
    const legacy = payload?.jti === undefined || payload?.jti === null;
    // Token sem "jti" só na janela de transição (ver legacyTokenAccepted), antes de consultar o banco
    if (legacy && !legacyTokenAccepted(payload ?? {})) {
      throw new UnauthorizedException(INVALID_SESSION_MESSAGE);
    }
    const id = Number(payload?.sub);
    const user =
      Number.isInteger(id) && id > 0
        ? await this.usersService.findActiveById(id)
        : null;

    if (!user || (payload.tv ?? 0) !== (user.token_version ?? 0)) {
      throw new UnauthorizedException(INVALID_SESSION_MESSAGE);
    }
    if (user.blocked_at) {
      throw new UnauthorizedException(BLOCKED_ACCOUNT_MESSAGE);
    }

    const base: AuthUser = {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      storeId: user.store_id ?? null,
      platformRole: user.platform_role ?? null,
      supportSession: null,
    };
    const support = payload.sid !== undefined && payload.sid !== null;

    if (legacy) {
      return support
        ? this.supportSessionUser(base, Number(payload.sid))
        : base;
    }

    const session = await this.registeredSession(payload.jti, base, support);
    if (!support) {
      if (session.kind !== AuthSessionKind.USER) {
        throw new UnauthorizedException(INVALID_SESSION_MESSAGE);
      }
      return { ...base, authSessionId: session.id };
    }
    if (
      session.kind !== AuthSessionKind.SUPPORT ||
      session.support_session_id !== Number(payload.sid)
    ) {
      throw new UnauthorizedException(SUPPORT_SESSION_ENDED_MESSAGE);
    }
    return this.supportSessionUser(base, Number(payload.sid), session);
  }

  /** Sessão aberta do token (auth_sessions) — da própria conta, sem revogação e no prazo. */
  private async registeredSession(
    jti: unknown,
    user: AuthUser,
    support: boolean,
  ): Promise<AuthSession> {
    const message = support
      ? SUPPORT_SESSION_ENDED_MESSAGE
      : INVALID_SESSION_MESSAGE;
    if (
      typeof jti !== 'string' ||
      !JTI_PATTERN.test(jti) ||
      !this.authSessions
    ) {
      throw new UnauthorizedException(INVALID_SESSION_MESSAGE);
    }
    const session = await this.authSessions.findForToken(jti);
    if (
      !session ||
      session.user_id !== user.id ||
      session.revoked_at ||
      new Date(session.expires_at).getTime() <= Date.now()
    ) {
      throw new UnauthorizedException(message);
    }
    return session;
  }

  /**
   * Token de acesso assistido: só vale enquanto a sessão estiver aberta e dentro do prazo, e só para
   * um superadmin. Ele age como ADMIN da loja da sessão, SOMENTE LEITURA (o StoreStaffGuard recusa
   * qualquer alteração) e sem acesso ao superpainel. Com "jti", a sessão de suporte já veio com a sessão
   * do token (nenhuma consulta a mais); sem "jti" (token antigo), é lida aqui.
   */
  private async supportSessionUser(
    user: AuthUser,
    sessionId: number,
    authSession?: AuthSession,
  ): Promise<AuthUser> {
    if (
      user.platformRole !== PlatformRole.SUPER_ADMIN ||
      !Number.isInteger(sessionId) ||
      sessionId < 1
    ) {
      throw new UnauthorizedException(INVALID_SESSION_MESSAGE);
    }
    const session = authSession
      ? this.openSupportSession(authSession.support_session, user.id)
      : await this.supportSessions.findOne({
          where: {
            id: sessionId,
            platform_user_id: user.id,
            ended_at: IsNull(),
            expires_at: MoreThan(new Date()),
          },
        });
    if (!session) {
      throw new UnauthorizedException(SUPPORT_SESSION_ENDED_MESSAGE);
    }
    return {
      ...user,
      role: UserRole.ADMIN,
      storeId: session.store_id,
      platformRole: null,
      supportSession: {
        id: session.id,
        storeId: session.store_id,
        expiresAt: session.expires_at,
      },
      ...(authSession ? { authSessionId: authSession.id } : {}),
    };
  }

  /** A sessão de suporte carregada junto com a sessão do token, se ainda aberta e do mesmo superadmin. */
  private openSupportSession(
    session: SupportSession | null | undefined,
    userId: number,
  ): SupportSession | null {
    if (
      !session ||
      session.platform_user_id !== userId ||
      session.ended_at ||
      new Date(session.expires_at).getTime() <= Date.now()
    ) {
      return null;
    }
    return session;
  }
}
