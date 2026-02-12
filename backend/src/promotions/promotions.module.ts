import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { PromotionsService } from './promotions.service';
import { PromotionsController } from './promotions.controller';

@Module({
  imports: [CacheModule.register()],
  controllers: [PromotionsController],
  providers: [PromotionsService],
})
export class PromotionsModule {}