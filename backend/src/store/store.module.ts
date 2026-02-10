import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StoreService } from './store.service';
import { StoreController } from './store.controller';
import { StoreConfig } from './entities/store-config.entity';

@Module({
  imports: [TypeOrmModule.forFeature([StoreConfig])],
  controllers: [StoreController],
  providers: [StoreService],
  exports: [StoreService], 
})
export class StoreModule {}