import type { Request } from 'express';
import { PlatformRole, UserRole } from '../users/entities/user.entity';

/** Conteúdo do JWT emitido no login. */
export interface JwtPayload {
  sub: number;
  email: string;
  role: UserRole;
  name: string;
  /** Versão das sessões do usuário (users.token_version). Tokens antigos sem "tv" valem como 0. */
  tv?: number;
  /** Sessão de acesso assistido do suporte (somente leitura, temporária). */
  sid?: number;
  /**
   * Sessão do token (auth_sessions.jti, UUID): o token só vale enquanto a sessão estiver aberta.
   * Tokens emitidos antes das sessões não têm "jti" e só valem na janela de transição
   * (JWT_LEGACY_ISSUED_BEFORE, ver auth/legacy-token.ts).
   */
  jti?: string;
  /** Emissão e expiração (segundos), preenchidas pelo jsonwebtoken ao assinar. */
  iat?: number;
  exp?: number;
}

/** Sessão de suporte ativa: o superadmin vê o painel de UMA loja, só para leitura. */
export interface SupportSessionRef {
  id: number;
  storeId: number;
  expiresAt: Date;
}

/** req.user nas rotas autenticadas — recarregado do banco a cada requisição (perfil sempre atual). */
export interface AuthUser {
  id: number;
  email: string;
  role: UserRole;
  name: string;
  /** Loja da equipe (null para clientes e para a equipe da plataforma). Vem SEMPRE do banco. */
  storeId: number | null;
  /** Papel global na plataforma (null = nenhum). */
  platformRole: PlatformRole | null;
  /** Presente só nos tokens de acesso assistido do suporte. */
  supportSession?: SupportSessionRef | null;
  /** Sessão do token atual (auth_sessions.id); ausente nos tokens antigos, sem "jti". */
  authSessionId?: number | null;
}

export type AuthenticatedRequest = Request & { user: AuthUser };

/** Rotas com OptionalJwtAuthGuard: req.user é null quando não há token válido. */
export type OptionalAuthRequest = Request & { user?: AuthUser | null };

export function isSuperAdmin(
  user?: Pick<AuthUser, 'platformRole' | 'supportSession'> | null,
): boolean {
  return (
    user?.platformRole === PlatformRole.SUPER_ADMIN && !user.supportSession
  );
}
