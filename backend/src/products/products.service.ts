import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, IsNull, Not } from 'typeorm'; // <--- Importado IsNull e Not
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

  async create(createProductDto: CreateProductDto) {
    const product = this.productRepository.create(createProductDto);
    if (createProductDto.allowed_addons_ids?.length) {
      product.allowed_addons = await this.addonRepository.findBy({ id: In(createProductDto.allowed_addons_ids) });
    }
    return this.productRepository.save(product);
  }

  // Busca normais (sem excluídos)
  findAll() {
    return this.productRepository.find({
      relations: ['allowed_addons'], 
      order: { created_at: 'DESC' }
    });
  }

  // Busca APENAS os excluídos (Lixeira)
  findDeleted() {
    return this.productRepository.find({
      withDeleted: true,
      where: { deleted_at: Not(IsNull()) },
      relations: ['allowed_addons'],
      order: { deleted_at: 'DESC' }
    });
  }

  findOne(id: number) {
    return this.productRepository.findOne({ where: { id }, relations: ['allowed_addons'] });
  }

  async update(id: number, updateProductDto: UpdateProductDto) {
    const product = await this.findOne(id);
    if (!product) throw new NotFoundException('Produto não encontrado');

    Object.keys(updateProductDto).forEach(key => updateProductDto[key] === undefined && delete updateProductDto[key]);

    this.productRepository.merge(product, updateProductDto);

    if (updateProductDto.allowed_addons_ids) {
      product.allowed_addons = await this.addonRepository.findBy({ id: In(updateProductDto.allowed_addons_ids) });
    }

    return this.productRepository.save(product);
  }

  // Soft Delete (Envia para lixeira)
  async remove(id: number) {
    return await this.productRepository.softDelete(id);
  }

  // Restaurar da Lixeira
  async restore(id: number) {
    return await this.productRepository.restore(id);
  }

  // Exclusão Permanente (Do banco mesmo)
  async removePermanent(id: number) {
    return await this.productRepository.delete(id);
  }

  // --- ADICIONAIS ---

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
    return this.addonRepository.softDelete(id); // Agora usa Soft Delete
  }
}