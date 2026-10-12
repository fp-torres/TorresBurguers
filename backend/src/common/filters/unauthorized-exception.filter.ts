import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import type { HttpServer } from '@nestjs/common';

/** Mensagem dos 401 de sessão: sem token, token inválido/expirado ou conta excluída. */
export const SESSION_EXPIRED_MESSAGE =
  'Sessão inválida ou expirada. Faça login novamente.';

export interface UnauthorizedBody {
  statusCode: 401;
  message: string;
  error: 'Unauthorized';
}

/**
 * Corpo padronizado dos 401: {statusCode, message, error}.
 * O 401 genérico do Passport (AuthGuard sem token ou com token inválido) chega como
 * {message: 'Unauthorized'}, sem o campo error e em inglês: vira a mensagem de sessão.
 * Mensagens próprias da API (ex.: "Email ou senha inválidos" no login) são mantidas.
 */
export function unauthorizedBody(
  exception: UnauthorizedException,
): UnauthorizedBody {
  const response = exception.getResponse();
  const message =
    typeof response === 'string'
      ? response
      : (response as { message?: unknown }).message;
  const custom =
    typeof message === 'string' &&
    message.trim() !== '' &&
    message !== 'Unauthorized';

  return {
    statusCode: HttpStatus.UNAUTHORIZED,
    message: custom ? message : SESSION_EXPIRED_MESSAGE,
    error: 'Unauthorized',
  };
}

/** Filtro global (registrado em setupApp): todo 401 sai no formato do contrato. */
@Catch(UnauthorizedException)
export class UnauthorizedExceptionFilter implements ExceptionFilter {
  constructor(private readonly httpAdapter: HttpServer) {}

  catch(exception: UnauthorizedException, host: ArgumentsHost): void {
    const response: unknown = host.switchToHttp().getResponse();
    if (this.httpAdapter.isHeadersSent(response)) return;
    this.httpAdapter.reply(
      response,
      unauthorizedBody(exception),
      HttpStatus.UNAUTHORIZED,
    );
  }
}
