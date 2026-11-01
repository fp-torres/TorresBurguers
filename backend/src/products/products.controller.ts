import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedRequest } from '../auth/auth-user';
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
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsService } from './products.service';

/**
 * Cardápio de uma loja. Rotas antigas (/products, usadas pelo app mobile) e por loja
 * (/stores/:storeSlug/products):
 * - leitura pública: a loja do slug; sem slug, a loja da equipe autenticada ou a loja padrão;
 * - gestão (ADMIN): sempre a loja do próprio usuário — slug de outra loja → 403 (StoreStaffGuard).
 */
@ApiTags('products')
@Controller(['products', 'stores/:storeSlug/products'])
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly audit: AuditService,
  ) {}

  // --- Leitura pública (cardápio) ---

  // Inclui indisponíveis (o front filtra); nunca itens da lixeira
  @Get()
  @PublicStoreRoute()
  findAll(@PublicStore() store: TenantContext) {
    return this.productsService.findAll(store.storeId);
  }

  // Rota literal antes de ':id'
  @Get('trash')
  @StaffRoute(UserRole.ADMIN)
  findDeleted(@CurrentTenant() tenant: TenantContext) {
    return this.productsService.findDeleted(tenant.storeId);
  }

  @Get(':id')
  @PublicStoreRoute()
  findOne(
    @PublicStore() store: TenantContext,
    @Param('id', ParseIdPipe) id: number,
  ) {
    return this.productsService.findOne(store.storeId, id);
  }

  // --- Gestão do cardápio (somente ADMIN da própria loja) ---

  @Post()
  @StaffRoute(UserRole.ADMIN)
  @ApiConsumes('multipart/form-data', 'application/json')
  @UseInterceptors(ImageFileInterceptor('file'))
  create(
    @CurrentTenant() tenant: TenantContext,
    @Body() createProductDto: CreateProductDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    // Imagem otimizada (.webp, com o prefixo da loja) só depois do corpo validado;
    // o produto guarda só o nome do arquivo
    return withOptimizedImage(
      file,
      (image) => {
        if (image) createProductDto.image = image;
        return this.productsService.create(tenant.storeId, createProductDto);
      },
      { prefix: storeFilePrefix(tenant.storeId) },
    );
  }

  @Patch(':id')
  @StaffRoute(UserRole.ADMIN)
  @ApiConsumes('multipart/form-data', 'application/json')
  @UseInterceptors(ImageFileInterceptor('file'))
  update(
    @CurrentTenant() tenant: TenantContext,
    @Param('id', ParseIdPipe) id: number,
    @Body() updateProductDto: UpdateProductDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return withOptimizedImage(
      file,
      (image) => {
        if (image) updateProductDto.image = image;
        return this.productsService.update(
          tenant.storeId,
          id,
          updateProductDto,
        );
      },
      { prefix: storeFilePrefix(tenant.storeId) },
    );
  }

  @Patch(':id/restore')
  @StaffRoute(UserRole.ADMIN)
  restore(
    @CurrentTenant() tenant: TenantContext,
    @Param('id', ParseIdPipe) id: number,
  ) {
    return this.productsService.restore(tenant.storeId, id);
  }

  // Soft delete (vai para a lixeira)
  @Delete(':id')
  @StaffRoute(UserRole.ADMIN)
  remove(
    @CurrentTenant() tenant: TenantContext,
    @Param('id', ParseIdPipe) id: number,
  ) {
    return this.productsService.remove(tenant.storeId, id);
  }

  // Exclusão definitiva (409 se o produto aparece em pedidos). Irreversível: fica na auditoria.
  @Delete(':id/permanent')
  @StaffRoute(UserRole.ADMIN)
  async removePermanent(
    @CurrentTenant() tenant: TenantContext,
    @Param('id', ParseIdPipe) id: number,
    @Req() req: AuthenticatedRequest,
  ) {
    const result = await this.productsService.removePermanent(
      tenant.storeId,
      id,
    );
    await this.audit.record({
      actor: req.user,
      storeId: tenant.storeId,
      action: 'catalog.product.delete_permanent',
      targetType: 'product',
      targetId: id,
      request: req,
    });
    return result;
  }
}
