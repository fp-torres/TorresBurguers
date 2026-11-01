import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { PromotionsService } from './promotions.service';
import {
  PromotionsController,
  StorePromotionsController,
} from './promotions.controller';

@Module({
  imports: [CacheModule.register()],
  controllers: [PromotionsController, StorePromotionsController],
  providers: [PromotionsService],
})
export class PromotionsModule {}
