import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { withOptimizedImage } from '../common/pipes/optimize-image.pipe';
import { ParseIdPipe } from '../common/pipes/parse-id.pipe';
import { ImageFileInterceptor } from '../common/uploads/image-upload';
import { UserRole } from '../users/entities/user.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsService } from './products.service';

@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  // --- Leitura pública (cardápio) ---

  @Get()
  findAll() {
    return this.productsService.findAll();
  }

  // Rota literal antes de ':id'
  @Get('trash')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  findDeleted() {
    return this.productsService.findDeleted();
  }

  @Get(':id')
  findOne(@Param('id', ParseIdPipe) id: number) {
    return this.productsService.findOne(id);
  }

  // --- Gestão do cardápio (somente ADMIN) ---

  @Post()
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data', 'application/json')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @UseInterceptors(ImageFileInterceptor('file'))
  create(
    @Body() createProductDto: CreateProductDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    // Imagem otimizada (.webp) só depois do corpo validado; o produto guarda só o nome do arquivo
    return withOptimizedImage(file, (image) => {
      if (image) createProductDto.image = image;
      return this.productsService.create(createProductDto);
    });
  }

  @Patch(':id')
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data', 'application/json')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @UseInterceptors(ImageFileInterceptor('file'))
  update(
    @Param('id', ParseIdPipe) id: number,
    @Body() updateProductDto: UpdateProductDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return withOptimizedImage(file, (image) => {
      if (image) updateProductDto.image = image;
      return this.productsService.update(id, updateProductDto);
    });
  }

  @Patch(':id/restore')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  restore(@Param('id', ParseIdPipe) id: number) {
    return this.productsService.restore(id);
  }

  // Soft delete (vai para a lixeira)
  @Delete(':id')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  remove(@Param('id', ParseIdPipe) id: number) {
    return this.productsService.remove(id);
  }

  // Exclusão definitiva (409 se o produto aparece em pedidos)
  @Delete(':id/permanent')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  removePermanent(@Param('id', ParseIdPipe) id: number) {
    return this.productsService.removePermanent(id);
  }
}
