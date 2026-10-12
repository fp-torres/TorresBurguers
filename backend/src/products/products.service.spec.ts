import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { QueryFailedError, Repository } from 'typeorm';
import { Addon } from './entities/addon.entity';
import { Product, ProductCategory } from './entities/product.entity';
import { ProductsService } from './products.service';

describe('ProductsService (regras de negócio)', () => {
  const existing = {
    id: 1,
    name: 'X-Burger',
    description: '',
    price: '30.00',
    promotion_price: '35.00', // dado antigo inconsistente
    category: ProductCategory.BURGER,
    allowed_addons: [],
  } as unknown as Product;

  let inOrders = false;
  const products = {
    create: jest.fn((data: Partial<Product>) => ({ ...data }) as Product),
    merge: jest.fn((target: Product, changes: Partial<Product>) =>
      Object.assign(target, changes),
    ),
    save: jest.fn((product: Product) =>
      Promise.resolve({ ...product, id: product.id ?? 1 }),
    ),
    findOne: jest.fn(() => Promise.resolve({ ...existing })),
    exists: jest.fn(() => Promise.resolve(true)),
    delete: jest.fn(() => Promise.resolve({ affected: 1 })),
    createQueryBuilder: jest.fn(() => {
      const qb = {
        withDeleted: () => qb,
        innerJoin: () => qb,
        where: () => qb,
        getExists: () => Promise.resolve(inOrders),
      };
      return qb;
    }),
  };
  const addons = {
    findBy: jest.fn(() => Promise.resolve([{ id: 1 } as Addon])),
    findOneBy: jest.fn(() =>
      Promise.resolve({ id: 3, name: 'Bacon' } as Addon),
    ),
    merge: jest.fn((target: Addon, changes: Partial<Addon>) =>
      Object.assign(target, changes),
    ),
    save: jest.fn((addon: Addon) => Promise.resolve(addon)),
  };
  const service = new ProductsService(
    products as unknown as Repository<Product>,
    addons as unknown as Repository<Addon>,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    inOrders = false;
  });

  it('preço promocional precisa ser menor que o preço normal', async () => {
    await expect(
      service.create({
        name: 'A',
        price: 20,
        promotion_price: 25,
        category: ProductCategory.DRINK,
      }),
    ).rejects.toThrow(
      new BadRequestException(
        'O preço promocional deve ser menor que o preço normal.',
      ),
    );
    expect(products.save).not.toHaveBeenCalled();

    await service.create({
      name: 'A',
      price: 20,
      promotion_price: 15,
      category: ProductCategory.DRINK,
    });
    expect(products.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: '', promotion_price: 15 }),
    );
  });

  it('ids de adicionais inexistentes → 400 com os ids', async () => {
    await expect(
      service.create({
        name: 'A',
        price: 20,
        category: ProductCategory.DRINK,
        allowed_addons_ids: [1, 99, 99],
      }),
    ).rejects.toThrow(new BadRequestException('Adicional não encontrado: 99.'));
  });

  it('PATCH só de disponibilidade não esbarra em promoção antiga; lista vazia limpa os adicionais', async () => {
    await expect(
      service.update(1, { available: false }),
    ).resolves.toBeDefined();
    await service.update(1, { allowed_addons_ids: [] });
    expect(products.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowed_addons: [] }),
    );
    await expect(service.update(1, { price: 40 })).resolves.toBeDefined();
    await expect(service.update(1, { price: 10 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('exclusão permanente: 404 se não existe, 409 se o produto está em pedidos', async () => {
    products.exists.mockResolvedValueOnce(false);
    await expect(service.removePermanent(9)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    inOrders = true;
    await expect(service.removePermanent(1)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(products.delete).not.toHaveBeenCalled();

    inOrders = false;
    products.delete.mockRejectedValueOnce(
      new QueryFailedError(
        'DELETE',
        [],
        Object.assign(new Error('fk'), { code: '23503' }),
      ),
    );
    await expect(service.removePermanent(1)).rejects.toBeInstanceOf(
      ConflictException,
    );

    await expect(service.removePermanent(1)).resolves.toEqual({
      message: 'Produto excluído permanentemente.',
    });
  });

  it('adicionais: PATCH vazio não quebra; id desconhecido → 404', async () => {
    await expect(service.updateAddon(3, {})).resolves.toMatchObject({ id: 3 });
    addons.findOneBy.mockResolvedValueOnce(null as unknown as Addon);
    await expect(service.updateAddon(77, { name: 'X' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
