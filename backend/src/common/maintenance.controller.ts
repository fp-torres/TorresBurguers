import { Controller, Post, UseGuards } from '@nestjs/common';
import { MaintenanceService } from './maintenance.service';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('maintenance')
export class MaintenanceController {
  constructor(private readonly maintenanceService: MaintenanceService) {}

  @Post('optimize-images')
  // DICA: Se o erro 404 persistir ou der erro de Permissão, 
  // comente as duas linhas abaixo temporariamente para rodar o script.
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  async runOptimization() {
    return this.maintenanceService.optimizeEverything();
  }
}