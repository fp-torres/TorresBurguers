import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth/auth-user';
import { PlatformRoute } from '../tenancy/decorators';
import { UpdatePlatformSettingsDto } from './dto/platform-settings.dto';
import { SendTestEmailDto } from './dto/platform-test-email.dto';
import { PlatformSettingsService } from './platform-settings.service';

/**
 * Superpainel › Configurações globais (linha única de platform_settings) e e-mail de teste. Manutenção
 * de imagens: POST /platform/maintenance/optimize-images (MaintenanceController).
 */
@ApiTags('Superpainel — configurações')
@Controller('platform')
@PlatformRoute()
export class PlatformSettingsController {
  constructor(private readonly settings: PlatformSettingsService) {}

  /** Configurações + `mail` (driver de e-mail ativo e situação do SMTP, sem usuário nem senha). */
  @Get('settings')
  get() {
    return this.settings.get();
  }

  /** Só o que foi enviado e mudou (auditado: platform.settings.update). Resposta: configurações + warnings. */
  @Patch('settings')
  update(
    @Body() dto: UpdatePlatformSettingsDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.settings.update(dto, req.user, req);
  }

  /**
   * Envia um e-mail de teste pelo driver configurado (auditado: platform.settings.test_email; limitado
   * por operador). Falha do SMTP → 200 com `delivered: false` e o motivo em `error`.
   */
  @Post('settings/test-email')
  @HttpCode(HttpStatus.OK)
  sendTestEmail(
    @Body() dto: SendTestEmailDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.settings.sendTestEmail(dto, req.user, req);
  }
}
