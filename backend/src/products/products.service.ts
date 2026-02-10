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
    return this.productRepository.findOne({ 
      where: { id },
      relations: ['allowed_addons'] 
    });
  }

  async update(id: number, updateProductDto: UpdateProductDto) {
    const product = await this.findOne(id);
    if (!product) throw new NotFoundException('Produto não encontrado');

    // Limpa campos undefined para não sobrescrever
    Object.keys(updateProductDto).forEach(key => updateProductDto[key] === undefined && delete updateProductDto[key]);

    // Mescla dados
    this.productRepository.merge(product, updateProductDto);

    // Atualiza adicionais se necessário
    if (updateProductDto.allowed_addons_ids) {
      product.allowed_addons = await this.addonRepository.findBy({
        id: In(updateProductDto.allowed_addons_ids),
      });
    }

    return this.productRepository.save(product);
  }

  // Soft Delete: Apenas esconde
  async remove(id: number) {
    return await this.productRepository.update(id, { available: false });
  }

  // Hard Delete: Tenta apagar do banco
  async removePermanent(id: number) {
    try {
      // Tenta apagar fisicamente
      return await this.productRepository.delete(id);
    } catch (error) {
      // Se der erro (ex: tem pedidos vinculados), apenas desativa
      console.log(`Não foi possível excluir o produto ${id} (Vendas vinculadas). Arquivando.`);
      return await this.productRepository.update(id, { available: false });
    }
  }

  // --- ADICIONAIS ---
  findAllAddons() { return this.addonRepository.find({ order: { name: 'ASC' } }); }
  createAddon(data: any) { return this.addonRepository.save(this.addonRepository.create(data)); }
}