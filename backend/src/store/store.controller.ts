import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { UpdateStoreDto } from './dto/update-store.dto';
import { StoreService } from './store.service';

@ApiTags('store')
@Controller('store')
export class StoreController {
  constructor(private readonly storeService: StoreService) {}

  // Público: a vitrine (web e app) consulta se a loja está aberta
  @Get('status')
  getStatus() {
    return this.storeService.getStatus();
  }

  // Administrador ou atendente abre/fecha a loja e edita as mensagens
  @Patch('status')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.EMPLOYEE)
  updateStatus(@Body() updateStoreDto: UpdateStoreDto) {
    return this.storeService.updateStatus(updateStoreDto);
  }
}
