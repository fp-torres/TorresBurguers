import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from '../products/entities/product.entity';
import { User } from '../users/entities/user.entity';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';

@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);
  
  // Caminho absoluto para a pasta uploads na raiz do projeto
  private readonly uploadPath = path.resolve(process.cwd(), 'uploads');

  constructor(
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async optimizeEverything() {
    this.logger.log('--- Iniciando otimização em massa ---');
    this.logger.log(`Pasta alvo: ${this.uploadPath}`);

    let count = 0;

    // 1. Otimizar Imagens de Produtos
    const products = await this.productRepository.find(); // CORRIGIDO: Adicionado 'this.'
    for (const product of products) {
      if (product.image && !product.image.endsWith('.webp')) {
        const newFilename = await this.compressFile(product.image);
        if (newFilename) {
          product.image = newFilename;
          await this.productRepository.save(product); // Já estava correto
          this.logger.log(`Produto ${product.id} [${product.name}] -> WebP`);
          count++;
        }
      }
    }

    // 2. Otimizar Avatares de Usuários
    const users = await this.userRepository.find(); // CORRIGIDO: Adicionado 'this.'
    for (const user of users) {
      // Remove o prefixo /uploads/ se existir para processar apenas o nome do arquivo
      const avatarName = user.avatar?.replace('/uploads/', '');
      
      if (avatarName && !avatarName.endsWith('.webp') && !avatarName.startsWith('http')) {
        const newFilename = await this.compressFile(avatarName);
        if (newFilename) {
          user.avatar = `/uploads/${newFilename}`;
          await this.userRepository.save(user); // Já estava correto
          this.logger.log(`Avatar Usuário ${user.id} [${user.name}] -> WebP`);
          count++;
        }
      }
    }

    return { 
      message: 'Otimização concluída!',
      itemsProcessed: count 
    };
  }

  private async compressFile(filename: string): Promise<string | null> {
    const oldPath = path.join(this.uploadPath, filename);
    
    // Gera novo nome: original-123456789.webp
    const newFilename = `${path.parse(filename).name}-${Date.now()}.webp`;
    const newPath = path.join(this.uploadPath, newFilename);

    if (!fs.existsSync(oldPath)) {
      this.logger.warn(`Arquivo não encontrado no disco: ${filename}`);
      return null;
    }

    try {
      await sharp(oldPath)
        .resize({ width: 800, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(newPath);

      // Opcional: Descomente a linha abaixo se quiser deletar o arquivo pesado original
      // fs.unlinkSync(oldPath); 

      return newFilename;
    } catch (err) {
      this.logger.error(`Erro ao processar ${filename}: ${err.message}`);
      return null;
    }
  }
}