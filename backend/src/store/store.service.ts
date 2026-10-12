import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { omitUndefined } from '../common/transforms';
import { UpdateStoreDto } from './dto/update-store.dto';
import { StoreConfig } from './entities/store-config.entity';

@Injectable()
export class StoreService implements OnModuleInit {
  private readonly logger = new Logger(StoreService.name);

  constructor(
    @InjectRepository(StoreConfig)
    private readonly storeRepository: Repository<StoreConfig>,
  ) {}

  // Garante a configuração da loja já na subida da API
  async onModuleInit() {
    try {
      await this.getStatus();
    } catch (error) {
      this.logger.warn(
        `Não foi possível preparar a configuração da loja: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Status atual da loja: { id, is_open, opening_message, closing_message }.
   * Se ainda não houver configuração, cria a padrão (loja aberta).
   */
  async getStatus(): Promise<StoreConfig> {
    const [config] = await this.storeRepository.find({
      order: { id: 'ASC' },
      take: 1,
    });
    if (config) return config;

    const created = await this.storeRepository.save(
      this.storeRepository.create({
        is_open: true,
        opening_message: null,
        closing_message: null,
      }),
    );
    this.logger.log('Configuração da loja criada (loja aberta).');
    return created;
  }

  /** Abre/fecha a loja e atualiza as mensagens da vitrine. Corpo vazio não altera nada. */
  async updateStatus(dto: UpdateStoreDto): Promise<StoreConfig> {
    const config = await this.getStatus();
    this.storeRepository.merge(config, omitUndefined(dto));
    return this.storeRepository.save(config);
  }

  async isOpen(): Promise<boolean> {
    const config = await this.getStatus();
    return config.is_open;
  }
}
