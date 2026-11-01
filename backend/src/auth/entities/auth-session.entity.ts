import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import { SupportSession } from '../../platform/entities/support-session.entity';
import { User } from '../../users/entities/user.entity';

/** Origem da sessão: conta comum (login, cadastro, convite, troca de credenciais) ou sessão de suporte. */
export enum AuthSessionKind {
  USER = 'USER',
  SUPPORT = 'SUPPORT',
}

/**
 * Como o token chega ao cliente: BEARER (o token de JWT_EXPIRES_IN no corpo, guardado pelo cliente: app
 * mobile, integrações, sessões de suporte e o site em modo bearer) ou COOKIE (sessão do site: token de
 * acesso curto em memória e o refresh num cookie HttpOnly, ver auth/web-session.service.ts).
 */
export enum AuthSessionTransport {
  BEARER = 'BEARER',
  COOKIE = 'COOKIE',
}

/**
 * Sessão de acesso: uma linha por token emitido, ligada a ele pela claim "jti". Um token com "jti" só vale
 * enquanto a linha existir, não estiver revogada (revoked_at) e não tiver expirado (expires_at = "exp" do
 * token). Tokens antigos, sem "jti", não têm linha e seguem as regras de antes até expirarem.
 *
 * - kind SUPPORT: token de uma sessão de suporte (claim "sid" = support_session_id), da conta do superadmin.
 * - token_version: a versão das sessões da conta (users.token_version) quando o token foi emitido; trocar a
 *   senha, bloquear ou "sair de todos os aparelhos" muda a versão da conta e a sessão deixa de ser ativa.
 * - Linhas expiradas, revogadas ou de uma versão antiga são apagadas quando a conta abre outra sessão.
 * - transport COOKIE: uma linha é uma FAMÍLIA de refresh (sessão do site). O jti não muda entre as
 *   renovações (o token de acesso novo leva o mesmo jti), então logout, "Sessões ativas" e DELETE
 *   /auth/sessions/:id valem para a família inteira. refresh_selector acha a linha; refresh_hash é o
 *   SHA-256 do validador atual e refresh_prev_hash o do anterior, aceito por AUTH_REFRESH_GRACE_SECONDS
 *   depois de refresh_rotated_at. expires_at é a validade absoluta (AUTH_SESSION_MAX_AGE).
 * - parent_session_id: na sessão de suporte, a sessão do superadmin que a abriu (o refresh dela fica
 *   suspenso enquanto o suporte estiver aberto).
 */
@Entity('auth_sessions')
@Check('CHK_auth_sessions_kind', `"kind" IN ('USER', 'SUPPORT')`)
@Check(
  'CHK_auth_sessions_support',
  `("kind" = 'SUPPORT') = ("support_session_id" IS NOT NULL)`,
)
@Check('CHK_auth_sessions_transport', `"transport" IN ('BEARER', 'COOKIE')`)
@Check(
  'CHK_auth_sessions_refresh',
  `("transport" = 'COOKIE') = ("refresh_selector" IS NOT NULL AND "refresh_hash" IS NOT NULL)`,
)
@Check(
  'CHK_auth_sessions_support_bearer',
  `"kind" <> 'SUPPORT' OR "transport" = 'BEARER'`,
)
@Index('UQ_auth_sessions_jti', ['jti'], { unique: true })
@Index('UQ_auth_sessions_refresh_selector', ['refresh_selector'], {
  unique: true,
  where: '"refresh_selector" IS NOT NULL',
})
@Index('IDX_auth_sessions_parent', ['parent_session_id'], {
  where: '"parent_session_id" IS NOT NULL',
})
@Index('IDX_auth_sessions_user_created', ['user_id', 'created_at'])
@Index('IDX_auth_sessions_support_session', ['support_session_id'])
@Index('IDX_auth_sessions_expires', ['expires_at'])
export class AuthSession {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_auth_sessions' })
  id: number;

  /** Claim "jti" do token (UUID v4). */
  @Column({ type: 'uuid' })
  jti: string;

  @Column({ type: 'int' })
  user_id: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_auth_sessions_user',
  })
  user?: Relation<User>;

  @Column({ type: 'varchar', length: 16, default: AuthSessionKind.USER })
  kind: AuthSessionKind;

  /** Sessão de suporte do token (só em kind SUPPORT). */
  @Column({ type: 'int', nullable: true })
  support_session_id: number | null;

  @ManyToOne(() => SupportSession, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'support_session_id',
    foreignKeyConstraintName: 'FK_auth_sessions_support_session',
  })
  support_session?: Relation<SupportSession> | null;

  @Column({ type: 'int', default: 0 })
  token_version: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @Column({ type: 'timestamptz' })
  expires_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revoked_at: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip: string | null;

  /** Navegador de quem abriu a sessão (cortado em 255 caracteres; a lista mostra só um resumo). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  user_agent: string | null;

  @Column({ type: 'varchar', length: 16, default: AuthSessionTransport.BEARER })
  transport: AuthSessionTransport;

  /** Seletor do refresh (só COOKIE): constante e secreto; o cookie é "v1.<seletor>.<validador>". */
  @Column({ type: 'varchar', length: 32, nullable: true })
  refresh_selector: string | null;

  /** SHA-256 (hex) do validador atual do refresh. */
  @Column({ type: 'char', length: 64, nullable: true })
  refresh_hash: string | null;

  /** SHA-256 do validador anterior: aceito por AUTH_REFRESH_GRACE_SECONDS depois da renovação. */
  @Column({ type: 'char', length: 64, nullable: true })
  refresh_prev_hash: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  refresh_rotated_at: Date | null;

  /** Quantas renovações a família já teve. */
  @Column({ type: 'int', default: 0 })
  refresh_generation: number;

  /** Sessão de suporte: a sessão do superadmin que a abriu (null nas demais; vira null se ela for apagada). */
  @Column({ type: 'int', nullable: true })
  parent_session_id: number | null;

  @ManyToOne(() => AuthSession, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'parent_session_id',
    foreignKeyConstraintName: 'FK_auth_sessions_parent',
  })
  parent_session?: Relation<AuthSession> | null;
}
