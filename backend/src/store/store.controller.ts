import { Controller, Get, Patch, Body, UseGuards } from '@nestjs/common';
import { StoreService } from './store.service';
import { UpdateStoreDto } from './dto/update-store.dto';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('store')
export class StoreController {
  constructor(private readonly storeService: StoreService) {}

  @Get('status')
  getStatus() {
    return this.storeService.getStatus();
  }

  @Patch('status')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN') 
  toggleStatus(@Body() updateStoreDto: UpdateStoreDto) {
    return this.storeService.toggleStatus(updateStoreDto);
  }
}