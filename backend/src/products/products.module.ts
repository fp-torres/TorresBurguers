import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { AddonsController } from './addons.controller'; // <--- IMPORT
import { Product } from './entities/product.entity';
import { Addon } from './entities/addon.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Product, Addon]) 
  ],
  controllers: [ProductsController, AddonsController], // <--- REGISTRO
  providers: [ProductsService],
  exports: [ProductsService]
})
export class ProductsModule {}