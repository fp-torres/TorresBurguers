import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  RefreshRejectedException,
  WebSessionService,
  type WebRefreshResult,
} from './web-session.service';
import {
  AUTH_TRANSPORT_HEADER,
  assertCookieRequest,
  clearRefreshCookie,
  DEV_REFRESH_COOKIE,
  SECURE_REFRESH_COOKIE,
  setRefreshCookie,
} from './web-session-cookie';

/**
 * Sessão do site em cookie (só o site usa; o app mobile e as integrações seguem com Bearer). As duas rotas
 * exigem X-Auth-Transport: cookie, Origin de uma origem de credencial (quando vem) e Sec-Fetch-Site
 * diferente de cross-site (quando vem); senão 403. Nunca usam o cabeçalho Authorization.
 */
@ApiTags('Autenticação')
@ApiCookieAuth(SECURE_REFRESH_COOKIE)
@ApiHeader({
  name: AUTH_TRANSPORT_HEADER,
  required: true,
  description: `Sempre "cookie". O refresh vai no cookie HttpOnly ${SECURE_REFRESH_COOKIE} (em http de desenvolvimento, ${DEV_REFRESH_COOKIE}).`,
})
@Controller('auth/web')
export class WebSessionController {
  constructor(private readonly webSessions: WebSessionService) {}

  /**
   * Renova a sessão: 200 { access_token, expires_in, user, session_transport: 'cookie' } com o mesmo jti e o
   * cookie rotacionado (o refresh anterior, dentro da tolerância, renova sem Set-Cookie). 401 (cookie
   * apagado): sem cookie, inválido, sessão encerrada ou vencida, conta bloqueada/excluída ou reuso. 403:
   * cabeçalho, origem ou site inválidos. 409: superadmin com uma sessão de suporte aberta a partir desta
   * sessão (o cookie fica). 429: limite REFRESH por IP.
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Renova a sessão do site pelo cookie HttpOnly' })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WebRefreshResult> {
    assertCookieRequest(req);
    try {
      const outcome = await this.webSessions.refresh(req);
      if (outcome.rotated) {
        setRefreshCookie(
          res,
          req,
          outcome.rotated.token,
          outcome.rotated.expiresAt,
        );
      }
      res.setHeader('Cache-Control', 'no-store');
      return outcome.body;
    } catch (error) {
      if (error instanceof RefreshRejectedException) {
        clearRefreshCookie(res, req);
      }
      throw error;
    }
  }

  /**
   * Sai da sessão do site: sempre 204, apagando o cookie. Com um cookie conhecido, a sessão é encerrada
   * (auth.logout, via cookie). Não encerra a sessão de suporte (ela sai por POST /auth/logout com o token
   * de suporte).
   */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Encerra a sessão do site (cookie)' })
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    assertCookieRequest(req);
    try {
      await this.webSessions.logout(req);
    } finally {
      clearRefreshCookie(res, req);
    }
  }
}
