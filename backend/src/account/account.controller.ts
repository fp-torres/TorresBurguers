import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/auth-user';
import { AccountSecurityService } from './account-security.service';
import {
  AccountLinkTokenDto,
  ChangePasswordDto,
  RequestEmailChangeDto,
  RevertEmailChangeDto,
} from './dto/account.dto';

/**
 * Segurança da própria conta (plano email-verification, fase 1a): troca de senha com a senha atual,
 * troca de e-mail confirmada no endereço novo, "Não fui eu" e verificação do e-mail.
 *
 * - Rotas com token (JWT): a sessão de suporte (somente leitura) só usa o GET; as que alteram dados
 *   respondem 403 pelo interceptor global (SupportSessionReadOnlyInterceptor).
 * - Rotas públicas dos links: GET só confere (verificadores de links dos e-mails abrem as URLs sozinhos);
 *   a ação exige o POST. Limite TOKEN_REDEEM por IP.
 * As rotas antigas (PATCH /users/:id, POST /users) continuam com o mesmo contrato para o app mobile.
 */
@ApiTags('Conta')
@Controller('account')
export class AccountController {
  constructor(private readonly account: AccountSecurityService) {}

  /** { email, email_verified, email_verified_at, email_change, account_security_mode } */
  @Get('security')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  security(@Req() req: AuthenticatedRequest) {
    return this.account.view(req.user);
  }

  /** { access_token, user }: senha nova; as outras sessões são encerradas. */
  @Post('password')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  changePassword(
    @Body() dto: ChangePasswordDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.account.changePassword(req.user, dto, req);
  }

  /** 202 { message, email_change }: a mesma resposta com o e-mail livre, em uso ou reservado. */
  @Post('email-change')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  requestEmailChange(
    @Body() dto: RequestEmailChangeDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.account.requestEmailChange(req.user, dto, req);
  }

  /** 204: cancela o pedido de troca em aberto (idempotente). */
  @Delete('email-change')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  async cancelEmailChange(@Req() req: AuthenticatedRequest): Promise<void> {
    await this.account.cancelEmailChange(req.user, req);
  }

  /** Público: { current_email_masked, new_email_masked, expires_at } ou 404. */
  @Get('email-change/:token')
  inspectEmailChange(@Param('token') token: string, @Req() req: Request) {
    return this.account.inspectEmailChange(token, req);
  }

  /** Público: { message, email }; 404 link inválido; 409 e-mail tomado por outra conta. */
  @Post('email-change/confirm')
  @HttpCode(HttpStatus.OK)
  confirmEmailChange(@Body() dto: AccountLinkTokenDto, @Req() req: Request) {
    return this.account.confirmEmailChange(dto.token, req);
  }

  /** Público ("Não fui eu"): { restored_email_masked, replaced_email_masked, expires_at } ou 404. */
  @Get('email-revert/:token')
  inspectRevert(@Param('token') token: string, @Req() req: Request) {
    return this.account.inspectRevert(token, req);
  }

  /** Público: { message, email_masked }: e-mail antigo de volta, senha nova, sessões encerradas. */
  @Post('email-revert')
  @HttpCode(HttpStatus.OK)
  revertEmailChange(@Body() dto: RevertEmailChangeDto, @Req() req: Request) {
    return this.account.revertEmailChange(dto.token, dto.password, req);
  }

  /** 202 { message } (link enviado) ou 200 { message, email_verified: true } (já confirmado). */
  @Post('email-verification')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  async requestVerification(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { status, body } = await this.account.requestVerification(
      req.user,
      req,
    );
    res.status(status);
    return body;
  }

  /** Público: { email_masked, expires_at } ou 404. */
  @Get('email-verification/:token')
  inspectVerification(@Param('token') token: string, @Req() req: Request) {
    return this.account.inspectVerification(token, req);
  }

  /** Público: { message, email_masked } ou 404. */
  @Post('email-verification/confirm')
  @HttpCode(HttpStatus.OK)
  confirmVerification(@Body() dto: AccountLinkTokenDto, @Req() req: Request) {
    return this.account.confirmVerification(dto.token, req);
  }
}
