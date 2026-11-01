import {
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Autenticação opcional: não bloqueia a requisição por falta de login.
 * Com um token válido preenche req.user (igual ao AuthGuard('jwt'));
 * sem token, ou com token inválido/expirado/revogado, segue como anônimo (req.user = null).
 * Erros inesperados (ex.: banco fora do ar ao recarregar o usuário) NÃO viram anônimo: sobem como erro.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser = unknown>(err: unknown, user: unknown): TUser {
    if (err && !(err instanceof UnauthorizedException)) {
      throw err instanceof Error
        ? err
        : new InternalServerErrorException('Falha ao validar a sessão.');
    }
    return (err || !user ? null : user) as TUser;
  }
}
