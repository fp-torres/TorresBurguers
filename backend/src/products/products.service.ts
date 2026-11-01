import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DeepPartial,
  DeleteResult,
  In,
  IsNull,
  Not,
  Repository,
} from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { PlanLimitsService } from '../billing/plan-limits.service';
import {
  isCheckViolation,
  isForeignKeyViolation,
} from '../common/database-errors';
import { omitUndefined } from '../common/transforms';
import {
  removeOwnedUpload,
  uploadedFilename,
} from '../common/uploads/owned-files';
import {
  isAllowedStoreImageRef,
  isStoreFile,
  storeFilePrefix,
} from '../common/uploads/store-files';
import { Store } from '../store/entities/store.entity';
import { CreateAddonDto } from './dto/create-addon.dto';
import {
  CreateProductDto,
  INVALID_IMAGE_REF_MESSAGE,
} from './dto/create-product.dto';
import { UpdateAddonDto } from './dto/update-addon.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { Addon } from './entities/addon.entity';
import { Product } from './entities/product.entity';

export const PRODUCT_NOT_FOUND_MESSAGE = 'Produto não encontrado.';
export const PRODUCT_NOT_IN_TRASH_MESSAGE =
  'Produto não encontrado na lixeira.';
export const ADDON_NOT_FOUND_MESSAGE = 'Adicional não encontrado.';

const PRODUCT_IN_ORDERS_MESSAGE =
  'Este produto aparece em pedidos e não pode ser excluído permanentemente. Mantenha-o na lixeira para preservar o histórico de vendas.';

/**
 * Cardápio (produtos e adicionais) POR LOJA. Todo método recebe o storeId já validado (loja da
 * equipe pelo StoreStaffGuard ou da vitrine pelo PublicStoreGuard) e o usa em todas as consultas e
 * escritas. Registro de outra loja responde exatamente como um inexistente (mesmo 404/400).
 */
@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    @InjectRepository(Addon)
    private readonly addonRepository: Repository<Addon>,
    private readonly planLimits: PlanLimitsService,
  ) {}

  // --- PRODUTOS ---

  async create(storeId: number, dto: CreateProductDto) {
    const { allowed_addons_ids, ...fields } = dto;
    this.assertImageRef(storeId, fields.image);

    const product = this.productRepository.create({
      ...omitUndefined(fields),
      description: fields.description ?? '',
      store_id: storeId,
    } as DeepPartial<Product>);
    this.assertPromotionPrice(product);

    if (allowed_addons_ids) {
      product.allowed_addons = await this.findAddonsByIds(
        storeId,
        allowed_addons_ids,
      );
    }

    // Limite de produtos do plano conferido e gravado na mesma transação, com trava por loja: uma rajada
    // de cadastros simultâneos não passa do limite
    const saved = await this.persistCatalog(() =>
      this.planLimits.withinLimit(storeId, 'products', (manager) =>
        manager.getRepository(Product).save(product),
      ),
    );
    return this.findOne(storeId, saved.id);
  }

  /** Cardápio da loja: produtos fora da lixeira (inclusive indisponíveis), com os adicionais permitidos. */
  findAll(storeId: number) {
    return this.productRepository.find({
      where: { store_id: storeId },
      relations: { allowed_addons: true },
      order: {
        created_at: 'DESC',
        allowed_addons: { category: 'ASC', name: 'ASC' },
      },
    });
  }

  /** Lixeira da loja: apenas produtos excluídos (soft delete). */
  findDeleted(storeId: number) {
    return this.productRepository.find({
      withDeleted: true,
      where: { store_id: storeId, deleted_at: Not(IsNull()) },
      relations: { allowed_addons: true },
      order: { deleted_at: 'DESC' },
    });
  }

  /** Produto da loja fora da lixeira. De outra loja ou inexistente → o mesmo 404. */
  async findOne(storeId: number, id: number) {
    const product = await this.productRepository.findOne({
      where: { id, store_id: storeId },
      relations: { allowed_addons: true },
      order: { allowed_addons: { category: 'ASC', name: 'ASC' } },
    });
    if (!product) throw new NotFoundException(PRODUCT_NOT_FOUND_MESSAGE);
    return product;
  }

  async update(storeId: number, id: number, dto: UpdateProductDto) {
    const product = await this.findOne(storeId, id);
    const { allowed_addons_ids, ...fields } = dto;
    const changes = omitUndefined(fields);

    // A imagem que o produto já tinha (inclusive antiga, sem prefixo da loja) pode ser reenviada
    this.assertImageRef(storeId, changes.image, product.image);
    if ('price' in changes || 'promotion_price' in changes) {
      this.assertPromotionPrice({ ...product, ...changes });
    }
    const addons =
      allowed_addons_ids === undefined
        ? undefined
        : await this.findAddonsByIds(storeId, allowed_addons_ids);

    // Corpo vazio: nada para gravar, devolve o produto como está
    if (Object.keys(changes).length === 0 && !addons) return product;

    await this.persistCatalog(() =>
      this.productRepository.manager.transaction(async (manager) => {
        // Critério composto (id + loja, fora da lixeira): sem o affected, o produto saiu do
        // cardápio entre a leitura e a gravação
        const result = await manager.update(
          Product,
          { id, store_id: storeId, deleted_at: IsNull() },
          changes as QueryDeepPartialEntity<Product>,
        );
        if (!result.affected) {
          throw new NotFoundException(PRODUCT_NOT_FOUND_MESSAGE);
        }
        // Lista enviada (mesmo vazia) substitui os adicionais permitidos; com a linha do produto
        // já travada pelo UPDATE acima, o save só troca os vínculos (sem cascade nos adicionais)
        if (addons) {
          await manager.save(Product, { id, allowed_addons: addons });
        }
      }),
    );
    await this.removeReplacedImage(storeId, product.image, changes.image);
    return this.findOne(storeId, id);
  }

  // Soft delete: o produto vai para a lixeira e some do cardápio
  async remove(storeId: number, id: number) {
    const result = await this.productRepository.softDelete({
      id,
      store_id: storeId,
      deleted_at: IsNull(),
    });
    if (!result.affected) {
      throw new NotFoundException(PRODUCT_NOT_FOUND_MESSAGE);
    }
    return { message: 'Produto movido para a lixeira.' };
  }

  /** Volta para o cardápio: conta de novo no limite de produtos do plano. */
  async restore(storeId: number, id: number) {
    const inTrash = { id, store_id: storeId, deleted_at: Not(IsNull()) };
    // Conferido antes do limite só para o 404 vir antes do 403; a gravação abaixo não depende disso
    const exists = await this.productRepository.exists({
      where: inTrash,
      withDeleted: true,
    });
    if (!exists) throw new NotFoundException(PRODUCT_NOT_IN_TRASH_MESSAGE);

    // Volta a contar no limite: conferido e gravado na mesma transação (trava por loja)
    const result = await this.planLimits.withinLimit(
      storeId,
      'products',
      (manager) => manager.getRepository(Product).restore(inTrash),
    );
    if (!result.affected) {
      throw new NotFoundException(PRODUCT_NOT_IN_TRASH_MESSAGE);
    }
    return this.findOne(storeId, id);
  }

  // Exclusão permanente: só para produtos que nunca foram vendidos
  async removePermanent(storeId: number, id: number) {
    const exists = await this.productRepository.exists({
      where: { id, store_id: storeId },
      withDeleted: true,
    });
    if (!exists) throw new NotFoundException(PRODUCT_NOT_FOUND_MESSAGE);

    if (await this.isInOrders(storeId, id)) {
      throw new ConflictException(PRODUCT_IN_ORDERS_MESSAGE);
    }

    let result: DeleteResult;
    try {
      result = await this.productRepository.delete({ id, store_id: storeId });
    } catch (error) {
      // Pedido criado entre a checagem e a exclusão
      if (isForeignKeyViolation(error)) {
        throw new ConflictException(PRODUCT_IN_ORDERS_MESSAGE);
      }
      throw error;
    }
    if (!result.affected) {
      throw new NotFoundException(PRODUCT_NOT_FOUND_MESSAGE);
    }
    return { message: 'Produto excluído permanentemente.' };
  }

  private isInOrders(storeId: number, productId: number): Promise<boolean> {
    return this.productRepository
      .createQueryBuilder('product')
      .withDeleted()
      .innerJoin('product.items', 'item')
      .where('product.id = :productId', { productId })
      .andWhere('product.store_id = :storeId', { storeId })
      .getExists();
  }

  /** O preço promocional, quando existe, precisa ser menor que o preço normal. */
  private assertPromotionPrice(values: {
    price?: number | string | null;
    promotion_price?: number | string | null;
  }) {
    const promotion = values.promotion_price;
    if (promotion === null || promotion === undefined) return;

    if (Number(promotion) >= Number(values.price)) {
      throw new BadRequestException(
        'O preço promocional deve ser menor que o preço normal.',
      );
    }
  }

  /**
   * Imagem informada como texto (campo "image"): só arquivo enviado pela própria loja, URL https://
   * ou o valor que o registro já tinha. Arquivo de outra loja, sem dono ou http:// → 400.
   * Ausente (undefined) não muda nada; null remove a imagem.
   */
  private assertImageRef(
    storeId: number,
    image: string | null | undefined,
    current?: string | null,
  ) {
    if (image === undefined || image === null) return;
    if (!isAllowedStoreImageRef(image, storeId, current)) {
      throw new BadRequestException(INVALID_IMAGE_REF_MESSAGE);
    }
  }

  /**
   * Depois de trocar (ou tirar) a imagem de um produto ou adicional: apaga o arquivo anterior quando ele
   * foi enviado por ESTA loja (prefixo s<storeId>-) e nenhum outro cadastro o usa — produto ou adicional
   * (inclusive na lixeira, que pode voltar ao cardápio) nem o logo de uma loja. Imagem antiga sem o
   * prefixo, URL externa e arquivo ainda referenciado ficam. Melhor esforço: nunca lança — a edição já
   * foi gravada, e um erro aqui faria o upload apagar a imagem NOVA (withOptimizedImage); fica o aviso no log.
   */
  private async removeReplacedImage(
    storeId: number,
    previous: string | null | undefined,
    next: string | null | undefined,
  ): Promise<void> {
    if (next === undefined || !previous || previous === next) return;
    const filename = uploadedFilename(previous);
    if (!filename || !isStoreFile(filename, storeId)) return;

    try {
      const refs = In([filename, `/uploads/${filename}`]);
      const manager = this.productRepository.manager;
      const [inProducts, inAddons, inLogos] = await Promise.all([
        manager.exists(Product, { where: { image: refs }, withDeleted: true }),
        manager.exists(Addon, { where: { image: refs }, withDeleted: true }),
        manager.exists(Store, { where: { logo: refs } }),
      ]);
      if (inProducts || inAddons || inLogos) return;
      await removeOwnedUpload(filename, storeFilePrefix(storeId));
    } catch (error) {
      this.logger.warn(
        `Loja #${storeId}: a imagem substituída (${filename}) não foi apagada: ${(error as Error)?.message}`,
      );
    }
  }

  /**
   * Gravação do cardápio que pode esbarrar nas triggers entre lojas (check_violation, ex.: adicional
   * de outra loja num produto). A API já filtra pela loja antes; se o banco ainda assim recusar, a
   * resposta é a mesma de um adicional inexistente (400), nunca um 500.
   */
  private async persistCatalog<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (isCheckViolation(error)) {
        throw new BadRequestException(ADDON_NOT_FOUND_MESSAGE);
      }
      throw error;
    }
  }

  /** Adicionais da loja pelos ids. Inexistente, na lixeira ou de outra loja → 400 com os ids. */
  private async findAddonsByIds(
    storeId: number,
    ids: number[],
  ): Promise<Addon[]> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return [];

    const addons = await this.addonRepository.findBy({
      id: In(uniqueIds),
      store_id: storeId,
    });
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

  /** Adicionais da loja fora da lixeira (cardápio e painel). */
  findAllAddons(storeId: number) {
    return this.addonRepository.find({
      where: { store_id: storeId },
      order: { category: 'ASC', name: 'ASC' },
    });
  }

  async createAddon(storeId: number, dto: CreateAddonDto) {
    this.assertImageRef(storeId, dto.image);
    const addon = this.addonRepository.create({
      ...omitUndefined(dto),
      store_id: storeId,
    } as DeepPartial<Addon>);
    const saved = await this.addonRepository.save(addon);
    return this.findAddon(storeId, saved.id);
  }

  async updateAddon(storeId: number, id: number, dto: UpdateAddonDto) {
    const addon = await this.findAddon(storeId, id);
    const changes = omitUndefined(dto);
    this.assertImageRef(storeId, changes.image, addon.image);

    // Corpo vazio: nada para alterar, devolve o adicional como está
    if (Object.keys(changes).length === 0) return addon;

    const result = await this.addonRepository.update(
      { id, store_id: storeId, deleted_at: IsNull() },
      changes as QueryDeepPartialEntity<Addon>,
    );
    if (!result.affected) throw new NotFoundException(ADDON_NOT_FOUND_MESSAGE);
    await this.removeReplacedImage(storeId, addon.image, changes.image);
    return this.findAddon(storeId, id);
  }

  // Soft delete: some da lista de adicionais e dos produtos que o permitiam
  async deleteAddon(storeId: number, id: number) {
    const result = await this.addonRepository.softDelete({
      id,
      store_id: storeId,
      deleted_at: IsNull(),
    });
    if (!result.affected) throw new NotFoundException(ADDON_NOT_FOUND_MESSAGE);
    return { message: 'Adicional excluído.' };
  }

  /** Adicional da loja fora da lixeira. De outra loja ou inexistente → o mesmo 404. */
  private async findAddon(storeId: number, id: number) {
    const addon = await this.addonRepository.findOneBy({
      id,
      store_id: storeId,
    });
    if (!addon) throw new NotFoundException(ADDON_NOT_FOUND_MESSAGE);
    return addon;
  }
}
