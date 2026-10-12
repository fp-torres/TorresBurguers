import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Autenticação opcional: nunca bloqueia a requisição.
 * Com um token válido preenche req.user (igual ao AuthGuard('jwt'));
 * sem token, ou com token inválido/expirado, segue como anônimo (req.user = null).
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser = unknown>(err: unknown, user: unknown): TUser {
    return (err || !user ? null : user) as TUser;
  }
}
