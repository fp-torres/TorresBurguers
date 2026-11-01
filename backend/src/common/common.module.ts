import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MaintenanceService } from './maintenance.service';
import {
  LegacyMaintenanceController,
  PlatformMaintenanceController,
} from './maintenance.controller';
import { MaintenanceJob } from './entities/maintenance-job.entity';
import { Addon } from '../products/entities/addon.entity';
import { Product } from '../products/entities/product.entity';
import { User } from '../users/entities/user.entity';

/**
 * Manutenção da plataforma (otimização das imagens de uploads em segundo plano, somente superadmin):
 * /platform/maintenance (superpainel) e a rota antiga /maintenance.
 * Guards do superpainel (TenancyModule) e auditoria (AuditModule) vêm de módulos globais.
 */
@Module({
  imports: [
    // Repositórios das tabelas cujas imagens a manutenção converte + as execuções (trava e histórico)
    TypeOrmModule.forFeature([Product, Addon, User, MaintenanceJob]),
  ],
  controllers: [PlatformMaintenanceController, LegacyMaintenanceController],
  providers: [MaintenanceService],
  exports: [MaintenanceService],
})
export class CommonModule {}
