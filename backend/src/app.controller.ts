import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { AppService } from './app.service';
import type { HealthStatus } from './app.service';

@ApiTags('Saúde')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /** Pública e sem token: só { status: 'ok' } (sem nome nem versão do sistema). */
  @Get('health')
  @ApiOkResponse({
    description: 'API no ar',
    schema: { example: { status: 'ok' } },
  })
  getHealth(): HealthStatus {
    return this.appService.getHealth();
  }
}
