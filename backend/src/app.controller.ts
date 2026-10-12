import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { AppService } from './app.service';
import type { HealthStatus } from './app.service';

@ApiTags('Saúde')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('health')
  @ApiOkResponse({
    description: 'API no ar',
    schema: {
      example: { status: 'ok', name: 'Nome do sistema', version: '1.0.0' },
    },
  })
  getHealth(): HealthStatus {
    return this.appService.getHealth();
  }
}
