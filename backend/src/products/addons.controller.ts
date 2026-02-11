import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe } from '@nestjs/common';
import { ProductsService } from './products.service';

@Controller('addons')
export class AddonsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  findAll() {
    return this.productsService.findAllAddons();
  }

  @Post()
  create(@Body() body: { name: string; price: number; category?: string }) {
    return this.productsService.createAddon(body);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number, 
    @Body() body: { name?: string; price?: number; category?: string }
  ) {
    return this.productsService.updateAddon(id, body);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.productsService.deleteAddon(id);
  }
}