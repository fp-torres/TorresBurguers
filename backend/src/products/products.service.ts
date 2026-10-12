import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, In, IsNull, Not, Repository } from 'typeorm';
import { isForeignKeyViolation } from '../common/database-errors';
import { omitUndefined } from '../common/transforms';
import { CreateAddonDto } from './dto/create-addon.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateAddonDto } from './dto/update-addon.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { Addon } from './entities/addon.entity';
import { Product } from './entities/product.entity';

const PRODUCT_IN_ORDERS_MESSAGE =
  'Este produto aparece em pedidos e não pode ser excluído permanentemente. Mantenha-o na lixeira para preservar o histórico de vendas.';

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    @InjectRepository(Addon)
    private readonly addonRepository: Repository<Addon>,
  ) {}

  // --- PRODUTOS ---

  async create(dto: CreateProductDto) {
    const { allowed_addons_ids, ...fields } = dto;

    const product = this.productRepository.create({
      ...omitUndefined(fields),
      description: fields.description ?? '',
    } as DeepPartial<Product>);

    if (allowed_addons_ids) {
      product.allowed_addons = await this.findAddonsByIds(allowed_addons_ids);
    }
    this.assertPromotionPrice(product);

    const saved = await this.productRepository.save(product);
    return this.findOne(saved.id);
  }

  /** Cardápio: produtos fora da lixeira (inclusive indisponíveis), com os adicionais permitidos. */
  findAll() {
    return this.productRepository.find({
      relations: { allowed_addons: true },
      order: {
        created_at: 'DESC',
        allowed_addons: { category: 'ASC', name: 'ASC' },
      },
    });
  }

  /** Lixeira: apenas produtos excluídos (soft delete). */
  findDeleted() {
    return this.productRepository.find({
      withDeleted: true,
      where: { deleted_at: Not(IsNull()) },
      relations: { allowed_addons: true },
      order: { deleted_at: 'DESC' },
    });
  }

  async findOne(id: number) {
    const product = await this.productRepository.findOne({
      where: { id },
      relations: { allowed_addons: true },
      order: { allowed_addons: { category: 'ASC', name: 'ASC' } },
    });
    if (!product) throw new NotFoundException('Produto não encontrado.');
    return product;
  }

  async update(id: number, dto: UpdateProductDto) {
    const product = await this.findOne(id);
    const { allowed_addons_ids, ...fields } = dto;
    const changes = omitUndefined(fields);

    this.productRepository.merge(product, changes as DeepPartial<Product>);

    // Lista enviada (mesmo vazia) substitui os adicionais permitidos
    if (allowed_addons_ids !== undefined) {
      product.allowed_addons = await this.findAddonsByIds(allowed_addons_ids);
    }
    if ('price' in changes || 'promotion_price' in changes) {
      this.assertPromotionPrice(product);
    }

    await this.productRepository.save(product);
    return this.findOne(id);
  }

  // Soft delete: o produto vai para a lixeira e some do cardápio
  async remove(id: number) {
    const exists = await this.productRepository.exists({ where: { id } });
    if (!exists) throw new NotFoundException('Produto não encontrado.');
    await this.productRepository.softDelete(id);
    return { message: 'Produto movido para a lixeira.' };
  }

  async restore(id: number) {
    const inTrash = await this.productRepository.exists({
      where: { id, deleted_at: Not(IsNull()) },
      withDeleted: true,
    });
    if (!inTrash) {
      throw new NotFoundException('Produto não encontrado na lixeira.');
    }
    await this.productRepository.restore(id);
    return this.findOne(id);
  }

  // Exclusão permanente: só para produtos que nunca foram vendidos
  async removePermanent(id: number) {
    const exists = await this.productRepository.exists({
      where: { id },
      withDeleted: true,
    });
    if (!exists) throw new NotFoundException('Produto não encontrado.');

    if (await this.isInOrders(id)) {
      throw new ConflictException(PRODUCT_IN_ORDERS_MESSAGE);
    }

    try {
      await this.productRepository.delete(id);
    } catch (error) {
      // Pedido criado entre a checagem e a exclusão
      if (isForeignKeyViolation(error)) {
        throw new ConflictException(PRODUCT_IN_ORDERS_MESSAGE);
      }
      throw error;
    }
    return { message: 'Produto excluído permanentemente.' };
  }

  private isInOrders(productId: number): Promise<boolean> {
    return this.productRepository
      .createQueryBuilder('product')
      .withDeleted()
      .innerJoin('product.items', 'item')
      .where('product.id = :productId', { productId })
      .getExists();
  }

  /** O preço promocional, quando existe, precisa ser menor que o preço normal. */
  private assertPromotionPrice(product: Product) {
    const promotion = product.promotion_price as number | string | null;
    if (promotion === null || promotion === undefined) return;

    if (Number(promotion) >= Number(product.price)) {
      throw new BadRequestException(
        'O preço promocional deve ser menor que o preço normal.',
      );
    }
  }

  private async findAddonsByIds(ids: number[]): Promise<Addon[]> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return [];

    const addons = await this.addonRepository.findBy({ id: In(uniqueIds) });
    const missing = uniqueIds.filter(
      (id) => !addons.some((addon) => addon.id === id),
    );
    if (missing.length) {
      throw new BadRequestException(
        `Adicional não encontrado: ${missing.join(', ')}.`,
      );
    }
    return addons;
  }

  // --- ADICIONAIS ---

  findAllAddons() {
    return this.addonRepository.find({
      order: { category: 'ASC', name: 'ASC' },
    });
  }

  async createAddon(dto: CreateAddonDto) {
    const addon = this.addonRepository.create(
      omitUndefined(dto) as DeepPartial<Addon>,
    );
    const saved = await this.addonRepository.save(addon);
    return this.findAddon(saved.id);
  }

  async updateAddon(id: number, dto: UpdateAddonDto) {
    const addon = await this.findAddon(id);
    // Corpo vazio: nada para alterar, devolve o adicional como está
    this.addonRepository.merge(addon, omitUndefined(dto) as DeepPartial<Addon>);
    await this.addonRepository.save(addon);
    return this.findAddon(id);
  }

  // Soft delete: some da lista de adicionais e dos produtos que o permitiam
  async deleteAddon(id: number) {
    await this.findAddon(id);
    await this.addonRepository.softDelete(id);
    return { message: 'Adicional excluído.' };
  }

  private async findAddon(id: number) {
    const addon = await this.addonRepository.findOneBy({ id });
    if (!addon) throw new NotFoundException('Adicional não encontrado.');
    return addon;
  }
}
