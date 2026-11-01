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
  StartSupportSessionDto,
  SupportSessionListQueryDto,
} from './dto/support-sessions.dto';
import { SupportSessionsService } from './support-sessions.service';

/**
 * Superpainel › Sessões de suporte: acesso assistido, temporário, SOMENTE LEITURA e auditado ao painel
 * de uma loja. O token devolvido vale só para o painel da loja (a JwtStrategy o trata como ADMIN somente
 * leitura); o superpainel continua exigindo o token normal do superadmin, inclusive para encerrar.
 */
@ApiTags('Superpainel — sessões de suporte')
@Controller('platform')
@PlatformRoute()
export class PlatformSupportSessionsController {
  constructor(private readonly sessions: SupportSessionsService) {}

  /** { access_token, expires_at, session } — expira em platform_settings.support_session_minutes. */
  @Post('stores/:id/support-sessions')
  start(
    @Param('id', ParseIdPipe) storeId: number,
    @Body() dto: StartSupportSessionDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.sessions.start(storeId, dto.reason, req.user, req);
  }

  @Get('support-sessions')
  list(@Query() query: SupportSessionListQueryDto) {
    return this.sessions.list(query);
  }

  /** Encerra a sessão: o token dela deixa de valer na hora (idempotente). */
  @Post('support-sessions/:id/end')
  @HttpCode(HttpStatus.OK)
  end(@Param('id', ParseIdPipe) id: number, @Req() req: AuthenticatedRequest) {
    return this.sessions.end(id, req.user, req);
  }
}
