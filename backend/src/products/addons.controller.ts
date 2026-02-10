import { Controller, Get, Post, Body } from '@nestjs/common';
import { ProductsService } from './products.service';
import { Addon } from './entities/addon.entity';

@Controller('addons')
export class AddonsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  findAll() {
    return this.productsService.findAllAddons();
  }

  @Post()
  create(@Body() createAddonDto: { name: string; price: number; description?: string }) {
    return this.productsService.createAddon(createAddonDto);
  }
}