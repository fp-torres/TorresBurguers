import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth/auth-user';
import { ParseIdPipe } from '../common/pipes/parse-id.pipe';
import { PlatformRoute } from '../tenancy/decorators';
import {
  AuthEventsQueryDto,
  BlockUserDto,
  PlatformUserListQueryDto,
} from './dto/platform-users.dto';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformUsersService } from './platform-users.service';

/**
 * Superpainel › Usuários e acessos: contas de clientes, da equipe de todas as lojas e da plataforma.
 * Bloqueio, desbloqueio, encerramento de sessões e link de redefinição são auditados pelos serviços
 * de conta (user.block, user.unblock, user.revoke_sessions, user.password_reset_link).
 */
@ApiTags('Superpainel — usuários e acessos')
@Controller('platform')
@PlatformRoute()
export class PlatformUsersController {
  constructor(
    private readonly users: PlatformUsersService,
    private readonly auditLogs: PlatformAuditService,
  ) {}

  /**
   * ?search=&role=&store_id=&platform_role=&blocked=&include_deleted=&sort=&order=&page=&pageSize=
   * Leitura de dados pessoais: auditada (platform.users.list, com os filtros e a quantidade).
   */
  @Get('users')
  list(
    @Query() query: PlatformUserListQueryDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.users.list(query, req.user, req);
  }

  /** Conta (inclusive na lixeira) + recent_auth_events. Auditada (platform.users.view). */
  @Get('users/:id')
  detail(
    @Param('id', ParseIdPipe) id: number,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.users.detail(id, req.user, req);
  }

  /** Bloqueia (login recusado e sessões encerradas na hora). A própria conta não pode ser bloqueada. */
  @Post('users/:id/block')
  @HttpCode(HttpStatus.OK)
  block(
    @Param('id', ParseIdPipe) id: number,
    @Body() dto: BlockUserDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.users.block(id, dto.reason, req.user, req);
  }

  @Post('users/:id/unblock')
  @HttpCode(HttpStatus.OK)
  unblock(
    @Param('id', ParseIdPipe) id: number,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.users.unblock(id, req.user, req);
  }

  /** Encerra todas as sessões da conta (token_version + 1). */
  @Post('users/:id/revoke-sessions')
  @HttpCode(HttpStatus.OK)
  revokeSessions(
    @Param('id', ParseIdPipe) id: number,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.users.revokeSessions(id, req.user, req);
  }

  /**
   * { url, delivered, expires_at, message }. Com o SMTP configurado, o link vai só para o e-mail do
   * titular (url null); sem ele, o link de uso único aparece só nesta resposta. Conta da plataforma → 403.
   */
  @Post('users/:id/password-reset')
  @HttpCode(HttpStatus.OK)
  passwordReset(
    @Param('id', ParseIdPipe) id: number,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.users.passwordResetLink(id, req.user, req);
  }

  /** Auditoria de autenticação (ações auth.*): ?user_id=&email=&result=&from=&to=&page=&pageSize= */
  @Get('auth-events')
  authEvents(@Query() query: AuthEventsQueryDto) {
    return this.auditLogs.authEvents(query);
  }
}
