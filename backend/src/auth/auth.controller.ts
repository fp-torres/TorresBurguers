import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ParseIdPipe } from '../common/pipes/parse-id.pipe';
import type { AuthenticatedRequest } from './auth-user';
import { AuthSessionsService } from './auth-sessions.service';
import { AuthService } from './auth.service';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SessionListQueryDto } from './dto/session-list-query.dto';
import {
  FORGOT_PASSWORD_MESSAGE,
  PASSWORD_RESET_DONE_MESSAGE,
  PasswordResetService,
} from './password-reset.service';
import { AllowedInSupportSession } from './support-session-read-only.interceptor';
import { clearRefreshCookie, cookieRequestCheck } from './web-session-cookie';

/**
 * Logout pelo site em modo cookie (X-Auth-Transport: cookie, origem válida): a resposta também apaga o
 * cookie do refresh. Nunca no logout de uma sessão de suporte: o cookie é da sessão do superadmin, que
 * volta ao superpainel pelo refresh quando o suporte termina.
 */
function clearCookieOnLogout(req: AuthenticatedRequest, res: Response): void {
  if (req.user?.supportSession) return;
  if (cookieRequestCheck(req) === 'ok') clearRefreshCookie(res, req);
}

@ApiTags('Autenticação')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly passwordReset: PasswordResetService,
    private readonly sessions: AuthSessionsService,
  ) {}

  /** { access_token, user: SessionUser }. Limitado por falhas (IP + e-mail e IP). */
  @Post('login')
  login(@Body() loginDto: LoginDto, @Req() req: Request) {
    return this.authService.login(loginDto, req);
  }

  /** Sessão atual: SessionUser + support_session (acesso assistido do suporte, ou null). */
  @Get('me')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  me(@Req() req: AuthenticatedRequest) {
    return this.authService.me(req.user);
  }

  /**
   * Sai desta sessão: o token desta requisição deixa de valer (204). Com o token de uma sessão de suporte,
   * também encerra a sessão de suporte (vale mesmo sendo somente leitura).
   */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @AllowedInSupportSession()
  async logout(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.sessions.logout(req.user, req);
    clearCookieOnLogout(req, res);
  }

  /** Sai de todos os dispositivos: todos os tokens da conta deixam de valer (inclusive este). */
  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  async logoutAll(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.authService.logoutAll(req.user, req);
    clearCookieOnLogout(req, res);
  }

  /** Sessões ativas da própria conta: { items, total, page, pageSize }, a atual primeiro. */
  @Get('sessions')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  listSessions(
    @Query() query: SessionListQueryDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.sessions.list(req.user, query);
  }

  /** Encerra uma sessão da própria conta (204); de outra conta ou inexistente → 404. */
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  async revokeSession(
    @Param('id', ParseIdPipe) id: number,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    await this.sessions.revoke(req.user, id, req);
  }

  /** Sempre 202 com a mesma mensagem: não revela se o e-mail tem conta. */
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    this.passwordReset.requestReset(dto.email, req);
    return { message: FORGOT_PASSWORD_MESSAGE };
  }

  /** Confere o link antes de mostrar o formulário: { email_masked, expires_at } ou 404. */
  @Get('reset-password/:token')
  inspectReset(@Param('token') token: string, @Req() req: Request) {
    return this.passwordReset.inspect(token, req);
  }

  /** Grava a nova senha e encerra todas as sessões da conta. */
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    await this.passwordReset.reset(dto.token, dto.password, req);
    return { message: PASSWORD_RESET_DONE_MESSAGE };
  }
}
