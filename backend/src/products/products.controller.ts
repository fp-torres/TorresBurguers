import { 
  Controller, Get, Post, Body, Patch, Param, Delete, 
  UseGuards, UseInterceptors, UploadedFile, ParseIntPipe 
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';

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
  @UseInterceptors(FileInterceptor('file', {
    storage: diskStorage({
      destination: './uploads',
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        const ext = extname(file.originalname);
        cb(null, `product-${uniqueSuffix}${ext}`);
      },
    }),
  }))
  create(
    @Body() createProductDto: any, 
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (file) createProductDto.image = file.filename;
    
    // Conversões manuais de segurança para FormData
    if (createProductDto.price) createProductDto.price = parseFloat(createProductDto.price);
    if (createProductDto.available) createProductDto.available = createProductDto.available === 'true'; // <--- GARANTIA

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
  @UseInterceptors(FileInterceptor('file', {
    storage: diskStorage({
      destination: './uploads',
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        const ext = extname(file.originalname);
        cb(null, `product-${uniqueSuffix}${ext}`);
      },
    }),
  }))
  update(
    @Param('id', ParseIntPipe) id: number, 
    @Body() updateProductDto: any,
    @UploadedFile() file?: Express.Multer.File
  ) {
    if (file) updateProductDto.image = file.filename;
    
    // Conversões manuais de segurança para FormData
    if (updateProductDto.price) updateProductDto.price = parseFloat(updateProductDto.price);
    
    // Correção Crítica: Conversão de 'true'/'false' string para boolean
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