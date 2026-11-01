import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import { withOptimizedImage } from '../common/pipes/optimize-image.pipe';
import { ParseIdPipe } from '../common/pipes/parse-id.pipe';
import { ImageFileInterceptor } from '../common/uploads/image-upload';
import { storeFilePrefix } from '../common/uploads/store-files';
import {
  CurrentTenant,
  PublicStore,
  PublicStoreRoute,
  StaffRoute,
} from '../tenancy';
import type { TenantContext } from '../tenancy';
import { UserRole } from '../users/entities/user.entity';
import { CreateAddonDto } from './dto/create-addon.dto';
import { UpdateAddonDto } from './dto/update-addon.dto';
import { ProductsService } from './products.service';

/**
 * Adicionais de uma loja: rotas antigas (/addons) e por loja (/stores/:storeSlug/addons),
 * com as mesmas regras de loja do cardápio (ver ProductsController).
 */
@ApiTags('addons')
@Controller(['addons', 'stores/:storeSlug/addons'])
export class AddonsController {
  constructor(private readonly productsService: ProductsService) {}

  // Lista pública (fora da lixeira), usada no cardápio e no painel
  @Get()
  @PublicStoreRoute()
  findAll(@PublicStore() store: TenantContext) {
    return this.productsService.findAllAddons(store.storeId);
  }

  // --- Gestão (somente ADMIN da própria loja) ---

  @Post()
  @StaffRoute(UserRole.ADMIN)
  @ApiConsumes('application/json', 'multipart/form-data')
  @UseInterceptors(ImageFileInterceptor('file'))
  create(
    @CurrentTenant() tenant: TenantContext,
    @Body() createAddonDto: CreateAddonDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    // Imagem opcional (como no produto): .webp com o prefixo da loja, gravada depois da validação
    return withOptimizedImage(
      file,
      (image) => {
        if (image) createAddonDto.image = image;
        return this.productsService.createAddon(tenant.storeId, createAddonDto);
      },
      { prefix: storeFilePrefix(tenant.storeId) },
    );
  }

  @Patch(':id')
  @StaffRoute(UserRole.ADMIN)
  @ApiConsumes('application/json', 'multipart/form-data')
  @UseInterceptors(ImageFileInterceptor('file'))
  update(
    @CurrentTenant() tenant: TenantContext,
    @Param('id', ParseIdPipe) id: number,
    @Body() updateAddonDto: UpdateAddonDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return withOptimizedImage(
      file,
      (image) => {
        if (image) updateAddonDto.image = image;
        return this.productsService.updateAddon(
          tenant.storeId,
          id,
          updateAddonDto,
        );
      },
      { prefix: storeFilePrefix(tenant.storeId) },
    );
  }

  // Soft delete
  @Delete(':id')
  @StaffRoute(UserRole.ADMIN)
  remove(
    @CurrentTenant() tenant: TenantContext,
    @Param('id', ParseIdPipe) id: number,
  ) {
    return this.productsService.deleteAddon(tenant.storeId, id);
  }
}
