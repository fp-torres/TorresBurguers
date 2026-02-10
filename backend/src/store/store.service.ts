import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StoreConfig } from './entities/store-config.entity';
import { UpdateStoreDto } from './dto/update-store.dto';

@Injectable()
export class StoreService implements OnModuleInit {
  constructor(
    @InjectRepository(StoreConfig)
    private storeRepository: Repository<StoreConfig>,
  ) {}

  async onModuleInit() {
    const config = await this.storeRepository.findOne({ where: { id: 1 } });
    if (!config) {
      await this.storeRepository.save({ id: 1, is_open: true });
      console.log('⚙️ Configuração da Loja criada (ID 1)');
    }
  }

  async getStatus() {
    return this.storeRepository.findOne({ where: { id: 1 } });
  }

  async toggleStatus(updateStoreDto: UpdateStoreDto) {
    const config = await this.storeRepository.findOne({ where: { id: 1 } });
    if (config) {
      this.storeRepository.merge(config, updateStoreDto);
      return this.storeRepository.save(config);
    }
  }

  async isOpen(): Promise<boolean> {
    const config = await this.storeRepository.findOne({ where: { id: 1 } });
    return config ? config.is_open : false;
  }
}