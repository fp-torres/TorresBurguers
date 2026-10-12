import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { promises as fs } from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { Repository } from 'typeorm';
import { uploadsDir } from '../config/paths';
import { Product } from '../products/entities/product.entity';
import { User } from '../users/entities/user.entity';

const isExternalUrl = (value: string) => /^https?:\/\//i.test(value);

@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  /**
   * Converte para WebP as imagens de produtos e avatares que ainda não foram otimizadas
   * (inclusive itens na lixeira). Os arquivos originais são mantidos em disco.
   */
  async optimizeEverything() {
    const dir = uploadsDir();
    this.logger.log(`Otimizando imagens em ${dir}`);
    let count = 0;

    // 1. Imagens de produtos (o banco guarda só o nome do arquivo)
    const products = await this.productRepository.find({
      withDeleted: true,
      select: { id: true, name: true, image: true },
    });
    for (const product of products) {
      const image = product.image;
      if (!image || image.endsWith('.webp') || isExternalUrl(image)) continue;

      const newFilename = await this.compressFile(dir, image);
      if (!newFilename) continue;

      await this.productRepository.update(product.id, { image: newFilename });
      this.logger.log(`Produto ${product.id} [${product.name}] → WebP`);
      count++;
    }

    // 2. Avatares de usuários (o banco guarda "/uploads/<arquivo>" ou uma URL externa)
    const users = await this.userRepository.find({
      withDeleted: true,
      select: { id: true, avatar: true },
    });
    for (const user of users) {
      const avatar = user.avatar?.replace(/^\/?uploads\//, '');
      if (!avatar || avatar.endsWith('.webp') || isExternalUrl(avatar))
        continue;

      const newFilename = await this.compressFile(dir, avatar);
      if (!newFilename) continue;

      await this.userRepository.update(user.id, {
        avatar: `/uploads/${newFilename}`,
      });
      this.logger.log(`Avatar do usuário ${user.id} → WebP`);
      count++;
    }

    return {
      message: 'Otimização concluída!',
      itemsProcessed: count,
    };
  }

  private async compressFile(
    dir: string,
    filename: string,
  ): Promise<string | null> {
    // basename impede caminhos fora da pasta de uploads (ex.: "../arquivo")
    const safeName = path.basename(filename);
    const source = path.join(dir, safeName);

    try {
      await fs.access(source);
    } catch {
      this.logger.warn(`Arquivo não encontrado no disco: ${safeName}`);
      return null;
    }

    // Novo nome: <original>-<timestamp>.webp
    const newFilename = `${path.parse(safeName).name}-${Date.now()}.webp`;

    try {
      await sharp(source)
        .rotate()
        .resize({ width: 800, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(path.join(dir, newFilename));
      return newFilename;
    } catch (error) {
      this.logger.error(
        `Erro ao processar ${safeName}: ${(error as Error).message}`,
      );
      return null;
    }
  }
}
