import type { Request } from 'express';
import { UserRole } from '../users/entities/user.entity';

/** Conteúdo do JWT emitido no login. */
export interface JwtPayload {
  sub: number;
  email: string;
  role: UserRole;
  name: string;
}

/** req.user nas rotas autenticadas — recarregado do banco a cada requisição (perfil sempre atual). */
export interface AuthUser {
  id: number;
  email: string;
  role: UserRole;
  name: string;
}

export type AuthenticatedRequest = Request & { user: AuthUser };

/** Rotas com OptionalJwtAuthGuard: req.user é null quando não há token válido. */
export type OptionalAuthRequest = Request & { user?: AuthUser | null };
