import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { ParseIdPipe } from '../common/pipes/parse-id.pipe';
import { UserRole } from '../users/entities/user.entity';
import { CreateAddonDto } from './dto/create-addon.dto';
import { UpdateAddonDto } from './dto/update-addon.dto';
import { ProductsService } from './products.service';

@ApiTags('addons')
@Controller('addons')
export class AddonsController {
  constructor(private readonly productsService: ProductsService) {}

  // Lista pública (fora da lixeira), usada no cardápio e no painel
  @Get()
  findAll() {
    return this.productsService.findAllAddons();
  }

  // --- Gestão (somente ADMIN) ---

  @Post()
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  create(@Body() createAddonDto: CreateAddonDto) {
    return this.productsService.createAddon(createAddonDto);
  }

  @Patch(':id')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  update(
    @Param('id', ParseIdPipe) id: number,
    @Body() updateAddonDto: UpdateAddonDto,
  ) {
    return this.productsService.updateAddon(id, updateAddonDto);
  }

  // Soft delete
  @Delete(':id')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  remove(@Param('id', ParseIdPipe) id: number) {
    return this.productsService.deleteAddon(id);
  }
}
