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

  // ... (MÉTODOS DE PRODUTO MANTIDOS IGUAIS) ...

  async create(createProductDto: CreateProductDto) {
    const product = this.productRepository.create(createProductDto);
    if (createProductDto.allowed_addons_ids?.length) {
      product.allowed_addons = await this.addonRepository.findBy({ id: In(createProductDto.allowed_addons_ids) });
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
    return this.productRepository.findOne({ where: { id }, relations: ['allowed_addons'] });
  }

  async update(id: number, updateProductDto: UpdateProductDto) {
    const product = await this.findOne(id);
    if (!product) throw new NotFoundException('Produto não encontrado');

    // Remove undefined
    Object.keys(updateProductDto).forEach(key => updateProductDto[key] === undefined && delete updateProductDto[key]);

    this.productRepository.merge(product, updateProductDto);

    if (updateProductDto.allowed_addons_ids) {
      product.allowed_addons = await this.addonRepository.findBy({ id: In(updateProductDto.allowed_addons_ids) });
    }

    return this.productRepository.save(product);
  }

  async remove(id: number) {
    return await this.productRepository.update(id, { available: false });
  }

  async removePermanent(id: number) {
    try {
      return await this.productRepository.delete(id);
    } catch (error) {
      return await this.productRepository.update(id, { available: false });
    }
  }

  // --- MÉTODOS DE ADICIONAIS (NOVOS E ATUALIZADOS) ---

  findAllAddons() { 
    return this.addonRepository.find({ order: { category: 'ASC', name: 'ASC' } }); 
  }

  createAddon(data: any) { 
    return this.addonRepository.save(this.addonRepository.create(data)); 
  }

  async updateAddon(id: number, data: any) {
    await this.addonRepository.update(id, data);
    return this.addonRepository.findOneBy({ id });
  }

  async deleteAddon(id: number) {
    return this.addonRepository.delete(id);
  }
}