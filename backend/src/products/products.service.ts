import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { Product } from './entities/product.entity';
import { Addon } from './entities/addon.entity';

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private productRepository: Repository<Product>,
    
    @InjectRepository(Addon)
    private addonRepository: Repository<Addon>,
  ) {}

  // --- PRODUTOS ---

  async create(createProductDto: CreateProductDto) {
    const product = this.productRepository.create(createProductDto);

    // Vincula os adicionais se houver IDs
    if (createProductDto.allowed_addons_ids && createProductDto.allowed_addons_ids.length > 0) {
      const addons = await this.addonRepository.findBy({
        id: In(createProductDto.allowed_addons_ids),
      });
      product.allowed_addons = addons;
    }

    return this.productRepository.save(product);
  }

  findAll() {
    return this.productRepository.find({
      relations: ['allowed_addons'], 
      order: { created_at: 'DESC' }
    });
  }

  findOne(id: number) {
    return this.productRepository.findOne({ 
      where: { id },
      relations: ['allowed_addons'] 
    });
  }

  async update(id: number, updateProductDto: UpdateProductDto) {
    const product = await this.findOne(id);
    if (!product) throw new NotFoundException('Produto não encontrado');

    Object.assign(product, updateProductDto);

    if (updateProductDto.allowed_addons_ids) {
      const addons = await this.addonRepository.findBy({
        id: In(updateProductDto.allowed_addons_ids),
      });
      product.allowed_addons = addons;
    }

    return this.productRepository.save(product);
  }

  async remove(id: number) {
    try {
      return await this.productRepository.delete(id);
    } catch (error) {
      return await this.productRepository.update(id, { available: false });
    }
  }

  // --- ADICIONAIS (Novos Métodos) ---

  findAllAddons() {
    return this.addonRepository.find({ order: { name: 'ASC' } });
  }

  createAddon(data: { name: string; price: number; description?: string }) {
    const addon = this.addonRepository.create(data);
    return this.addonRepository.save(addon);
  }
}