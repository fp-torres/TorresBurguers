import { 
  Controller, Get, Post, Body, Patch, Param, Delete, 
  UseGuards, UseInterceptors, UploadedFile, ParseIntPipe 
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ProductsService } from './products.service';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { OptimizeImagePipe } from '../common/pipes/optimize-image.pipe'; // <--- IMPORT NOVO

@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get('trash')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  findDeleted() {
    return this.productsService.findDeleted();
  }

  @Patch(':id/restore')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  restore(@Param('id', ParseIntPipe) id: number) {
    return this.productsService.restore(id);
  }

  @Post()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  @UseInterceptors(FileInterceptor('file')) // <--- Removemos diskStorage (vai para memória)
  create(
    @Body() createProductDto: any, 
    @UploadedFile(OptimizeImagePipe) file?: Express.Multer.File, // <--- O Pipe processa aqui
  ) {
    if (file) createProductDto.image = file.filename; // O filename agora é o .webp gerado pelo Pipe
    
    // Conversões manuais de segurança para FormData
    if (createProductDto.price) createProductDto.price = parseFloat(createProductDto.price);
    if (createProductDto.available) createProductDto.available = createProductDto.available === 'true';

    return this.productsService.create(createProductDto);
  }

  @Get()
  findAll() {
    return this.productsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.productsService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  @UseInterceptors(FileInterceptor('file')) // <--- Removemos diskStorage
  update(
    @Param('id', ParseIntPipe) id: number, 
    @Body() updateProductDto: any,
    @UploadedFile(OptimizeImagePipe) file?: Express.Multer.File // <--- O Pipe processa aqui
  ) {
    if (file) updateProductDto.image = file.filename;
    
    // Conversões manuais
    if (updateProductDto.price) updateProductDto.price = parseFloat(updateProductDto.price);
    
    if (updateProductDto.available !== undefined) {
      updateProductDto.available = String(updateProductDto.available) === 'true';
    }

    return this.productsService.update(id, updateProductDto);
  }

  @Delete(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.productsService.remove(id); 
  }

  @Delete(':id/permanent')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  removePermanent(@Param('id', ParseIntPipe) id: number) {
    return this.productsService.removePermanent(id);
  }
}