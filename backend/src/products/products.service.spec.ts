import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { In, IsNull, Not, QueryFailedError, Repository } from 'typeorm';
import type { PlanLimitsService } from '../billing/plan-limits.service';
import { INVALID_IMAGE_REF_MESSAGE } from './dto/create-product.dto';
import { Addon } from './entities/addon.entity';
import { Product, ProductCategory } from './entities/product.entity';
import { Store } from '../store/entities/store.entity';
import { ProductsService } from './products.service';

const STORE = 7;
const OTHER_STORE = 8;

const pgError = (code: string) =>
  new QueryFailedError(
    'SQL',
    [],
    Object.assign(new Error(`erro ${code}`), { code }),
  );

interface FakeQueryBuilder {
  withDeleted: jest.Mock<FakeQueryBuilder, []>;
  innerJoin: jest.Mock<FakeQueryBuilder, [string, string]>;
  where: jest.Mock<FakeQueryBuilder, [string, object]>;
  andWhere: jest.Mock<FakeQueryBuilder, [string, object]>;
  getExists: jest.Mock<Promise<boolean>, []>;
}

/** Repositórios falsos: só o que o serviço usa, com o where de cada chamada registrado. */
function setup() {
  const existing = {
    id: 1,
    store_id: STORE,
    name: 'X-Burger',
    description: '',
    price: '30.00',
    promotion_price: '35.00', // dado antigo inconsistente
    image: '1770667391414-269457043.jpg', // imagem antiga, sem prefixo da loja
    category: ProductCategory.BURGER,
    allowed_addons: [],
  } as unknown as Product;

  let inOrders = false;
  // QueryBuilder encadeável (cada método devolve o próprio builder)
  const qb = {} as FakeQueryBuilder;
  Object.assign(qb, {
    withDeleted: jest.fn(() => qb),
    innerJoin: jest.fn(() => qb),
    where: jest.fn(() => qb),
    andWhere: jest.fn(() => qb),
    getExists: jest.fn(() => Promise.resolve(inOrders)),
  });
  const tx = {
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
    save: jest.fn((_target: unknown, entity: unknown) =>
      Promise.resolve(entity),
    ),
  };
  const products = {
    create: jest.fn((data: Partial<Product>) => ({ ...data }) as Product),
    save: jest.fn((product: Product) =>
      Promise.resolve({ ...product, id: product.id ?? 1 }),
    ),
    find: jest.fn(() => Promise.resolve([])),
    findOne: jest.fn(() => Promise.resolve({ ...existing })),
    exists: jest.fn(() => Promise.resolve(true)),
    delete: jest.fn(() => Promise.resolve({ affected: 1 })),
    softDelete: jest.fn(() => Promise.resolve({ affected: 1 })),
    restore: jest.fn(() => Promise.resolve({ affected: 1 })),
    createQueryBuilder: jest.fn(() => qb),
    manager: {
      transaction: jest.fn((work: (manager: typeof tx) => Promise<unknown>) =>
        work(tx),
      ),
    },
  };
  const addons = {
    create: jest.fn((data: Partial<Addon>) => ({ ...data }) as Addon),
    save: jest.fn((addon: Addon) =>
      Promise.resolve({ ...addon, id: addon.id ?? 3 }),
    ),
    find: jest.fn(() => Promise.resolve([])),
    findBy: jest.fn(() =>
      Promise.resolve([{ id: 1, store_id: STORE } as Addon]),
    ),
    findOneBy: jest.fn(() =>
      Promise.resolve({
        id: 3,
        store_id: STORE,
        name: 'Bacon',
        image: 'bacon-antigo.png',
      } as Addon),
    ),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
    softDelete: jest.fn(() => Promise.resolve({ affected: 1 })),
  };
  // withinLimit: confere (assertWithinLimit) e grava com o manager da transação (aqui, os mesmos mocks)
  const limitTx = {
    getRepository: jest.fn((entity: unknown) =>
      entity === Product ? products : undefined,
    ),
  };
  const planLimits = {
    assertWithinLimit: jest.fn<Promise<void>, [number, string]>(() =>
      Promise.resolve(),
    ),
    withinLimit: jest.fn(
      async (
        storeId: number,
        key: string,
        work: (manager: typeof limitTx) => Promise<unknown>,
      ) => {
        await planLimits.assertWithinLimit(storeId, key);
        return work(limitTx);
      },
    ),
  };
  const service = new ProductsService(
    products as unknown as Repository<Product>,
    addons as unknown as Repository<Addon>,
    planLimits as unknown as PlanLimitsService,
  );
  return {
    service,
    products,
    addons,
    tx,
    qb,
    planLimits,
    setInOrders: (value: boolean) => (inOrders = value),
  };
}

const newProduct = {
  name: 'Suco',
  price: 20,
  category: ProductCategory.DRINK,
};

describe('ProductsService — escopo por loja', () => {
  it('leituras sempre filtram pela loja (cardápio, lixeira, item e adicionais)', async () => {
    const { service, products, addons } = setup();

    await service.findAll(STORE);
    expect(products.find).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { store_id: STORE } }),
    );

    await service.findDeleted(STORE);
    expect(products.find).toHaveBeenLastCalledWith(
      expect.objectContaining({
        withDeleted: true,
        where: { store_id: STORE, deleted_at: Not(IsNull()) },
      }),
    );

    await service.findOne(STORE, 1);
    expect(products.findOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: 1, store_id: STORE } }),
    );

    await service.findAllAddons(STORE);
    expect(addons.find).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { store_id: STORE } }),
    );
  });

  it('produto de outra loja responde como inexistente (404 com a mesma mensagem)', async () => {
    const { service, products, tx } = setup();
    // O banco não acha o id 1 na loja 8 (ele é da loja 7)
    products.findOne.mockResolvedValue(null as unknown as Product);

    for (const call of [
      () => service.findOne(OTHER_STORE, 1),
      () => service.update(OTHER_STORE, 1, { name: 'Invasão' }),
    ]) {
      await expect(call()).rejects.toThrow(
        new NotFoundException('Produto não encontrado.'),
      );
    }
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('cadastro grava a loja do produto e respeita o limite de produtos do plano', async () => {
    const { service, products, planLimits } = setup();

    await service.create(STORE, newProduct);
    expect(planLimits.assertWithinLimit).toHaveBeenCalledWith(
      STORE,
      'products',
    );
    // Limite rígido: conferido e gravado na mesma transação (trava por loja no PlanLimitsService)
    expect(planLimits.withinLimit).toHaveBeenCalledWith(
      STORE,
      'products',
      expect.any(Function),
    );
    expect(products.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ store_id: STORE, description: '' }),
    );
    expect(products.findOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: 1, store_id: STORE } }),
    );

    planLimits.assertWithinLimit.mockRejectedValueOnce(
      new ForbiddenException('Limite do plano Básico atingido.'),
    );
    products.save.mockClear();
    await expect(service.create(STORE, newProduct)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(products.save).not.toHaveBeenCalled();
  });

  it('adicional de outra loja ou inexistente → 400 com os ids (mesma resposta)', async () => {
    const { service, addons, products } = setup();

    await expect(
      service.create(STORE, { ...newProduct, allowed_addons_ids: [1, 99, 99] }),
    ).rejects.toThrow(new BadRequestException('Adicional não encontrado: 99.'));
    // A busca dos adicionais já é restrita à loja do produto
    expect(addons.findBy).toHaveBeenLastCalledWith({
      id: expect.objectContaining({ type: 'in', value: [1, 99] }) as unknown,
      store_id: STORE,
    });

    // Adicional 1 pertence à loja 7: pela loja 8 ele "não existe"
    addons.findBy.mockResolvedValueOnce([]);
    await expect(
      service.update(OTHER_STORE, 1, { allowed_addons_ids: [1] }),
    ).rejects.toThrow(new BadRequestException('Adicional não encontrado: 1.'));
    expect(products.save).not.toHaveBeenCalled();
  });

  it('trigger entre lojas (check_violation) vira 400, nunca 500', async () => {
    const { service, products, tx } = setup();

    products.save.mockRejectedValueOnce(pgError('23514'));
    await expect(
      service.create(STORE, { ...newProduct, allowed_addons_ids: [1] }),
    ).rejects.toThrow(new BadRequestException('Adicional não encontrado.'));

    tx.save.mockRejectedValueOnce(pgError('23514'));
    await expect(
      service.update(STORE, 1, { allowed_addons_ids: [1] }),
    ).rejects.toThrow(new BadRequestException('Adicional não encontrado.'));

    // Outros erros do banco seguem como estão
    products.save.mockRejectedValueOnce(pgError('57014'));
    await expect(service.create(STORE, newProduct)).rejects.toBeInstanceOf(
      QueryFailedError,
    );
  });

  it('edição grava por critério composto (id + loja, fora da lixeira) e confere o affected', async () => {
    const { service, tx } = setup();

    await service.update(STORE, 1, { name: 'Novo nome' });
    expect(tx.update).toHaveBeenLastCalledWith(
      Product,
      { id: 1, store_id: STORE, deleted_at: IsNull() },
      { name: 'Novo nome' },
    );

    // Saiu do cardápio entre a leitura e a gravação
    tx.update.mockResolvedValueOnce({ affected: 0 });
    await expect(
      service.update(STORE, 1, { name: 'Outro' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lixeira, restauração e exclusão definitiva usam id + loja e conferem o affected', async () => {
    const { service, products, qb, planLimits } = setup();

    await service.remove(STORE, 1);
    expect(products.softDelete).toHaveBeenLastCalledWith({
      id: 1,
      store_id: STORE,
      deleted_at: IsNull(),
    });
    products.softDelete.mockResolvedValueOnce({ affected: 0 });
    await expect(service.remove(OTHER_STORE, 1)).rejects.toThrow(
      new NotFoundException('Produto não encontrado.'),
    );

    await service.restore(STORE, 1);
    const inTrash = { id: 1, store_id: STORE, deleted_at: Not(IsNull()) };
    expect(products.exists).toHaveBeenLastCalledWith({
      where: inTrash,
      withDeleted: true,
    });
    expect(planLimits.assertWithinLimit).toHaveBeenLastCalledWith(
      STORE,
      'products',
    );
    expect(planLimits.withinLimit).toHaveBeenLastCalledWith(
      STORE,
      'products',
      expect.any(Function),
    );
    expect(products.restore).toHaveBeenLastCalledWith(inTrash);
    products.restore.mockResolvedValueOnce({ affected: 0 });
    await expect(service.restore(STORE, 1)).rejects.toThrow(
      new NotFoundException('Produto não encontrado na lixeira.'),
    );

    await service.removePermanent(STORE, 1);
    expect(products.exists).toHaveBeenLastCalledWith({
      where: { id: 1, store_id: STORE },
      withDeleted: true,
    });
    expect(qb.andWhere).toHaveBeenLastCalledWith(
      'product.store_id = :storeId',
      { storeId: STORE },
    );
    expect(products.delete).toHaveBeenLastCalledWith({
      id: 1,
      store_id: STORE,
    });
    products.delete.mockResolvedValueOnce({ affected: 0 });
    await expect(service.removePermanent(STORE, 1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('restaurar da lixeira conta no limite do plano; fora da lixeira (ou de outra loja) → 404 antes do limite', async () => {
    const { service, products, planLimits } = setup();

    products.exists.mockResolvedValueOnce(false);
    await expect(service.restore(OTHER_STORE, 1)).rejects.toThrow(
      new NotFoundException('Produto não encontrado na lixeira.'),
    );
    expect(planLimits.assertWithinLimit).not.toHaveBeenCalled();

    planLimits.assertWithinLimit.mockRejectedValueOnce(
      new ForbiddenException('Limite do plano Básico atingido.'),
    );
    await expect(service.restore(STORE, 1)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(products.restore).not.toHaveBeenCalled();
  });
});

describe('ProductsService — referência de imagem (campo "image")', () => {
  it('cadastro: aceita arquivo da própria loja e URL https://', async () => {
    const { service, products } = setup();
    for (const image of [
      's7-compressed-1760000000000-ab12cd34.webp',
      'https://cdn.exemplo.com/fotos/suco.png',
      null,
    ]) {
      await service.create(STORE, { ...newProduct, image });
      expect(products.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ image }),
      );
    }
  });

  it('cadastro: recusa arquivo de outra loja, sem dono e http:// (400, nada é gravado)', async () => {
    const { service, products, planLimits } = setup();
    for (const image of [
      's8-compressed-1760000000000-ab12cd34.webp', // outra loja
      's77-compressed-1.webp', // prefixo parecido, outra loja
      'compressed-1760000000000-ab12cd34.webp', // sem dono
      'http://cdn.exemplo.com/suco.png',
      'https://',
    ]) {
      await expect(
        service.create(STORE, { ...newProduct, image }),
      ).rejects.toThrow(new BadRequestException(INVALID_IMAGE_REF_MESSAGE));
    }
    expect(products.save).not.toHaveBeenCalled();
    expect(planLimits.assertWithinLimit).not.toHaveBeenCalled();
  });

  it('edição: a imagem atual (antiga, sem prefixo) pode ser reenviada; outra sem dono não', async () => {
    const { service, tx } = setup();

    await service.update(STORE, 1, {
      image: '1770667391414-269457043.jpg',
      name: 'Mesmo',
    });
    expect(tx.update).toHaveBeenLastCalledWith(
      Product,
      expect.anything(),
      expect.objectContaining({ image: '1770667391414-269457043.jpg' }),
    );

    tx.update.mockClear();
    await expect(
      service.update(STORE, 1, { image: '1770647524177-865206816.webp' }),
    ).rejects.toThrow(new BadRequestException(INVALID_IMAGE_REF_MESSAGE));
    await expect(
      service.update(STORE, 1, { image: 's8-compressed-1.webp' }),
    ).rejects.toThrow(new BadRequestException(INVALID_IMAGE_REF_MESSAGE));
    expect(tx.update).not.toHaveBeenCalled();

    // null remove a imagem
    await service.update(STORE, 1, { image: null });
    expect(tx.update).toHaveBeenLastCalledWith(Product, expect.anything(), {
      image: null,
    });
  });

  it('adicionais seguem a mesma regra', async () => {
    const { service, addons } = setup();

    await service.createAddon(STORE, {
      name: 'Bacon',
      price: 4,
      image: 's7-compressed-1.webp',
    });
    expect(addons.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        store_id: STORE,
        image: 's7-compressed-1.webp',
      }),
    );

    await expect(
      service.createAddon(STORE, {
        name: 'Bacon',
        price: 4,
        image: 's8-compressed-1.webp',
      }),
    ).rejects.toThrow(new BadRequestException(INVALID_IMAGE_REF_MESSAGE));

    // Imagem atual do adicional (antiga) pode voltar no PATCH; a de outra loja não
    await expect(
      service.updateAddon(STORE, 3, { image: 'bacon-antigo.png' }),
    ).resolves.toBeDefined();
    await expect(
      service.updateAddon(STORE, 3, { image: 's8-x.webp' }),
    ).rejects.toThrow(new BadRequestException(INVALID_IMAGE_REF_MESSAGE));
  });
});

describe('ProductsService — regras do cardápio', () => {
  it('preço promocional precisa ser menor que o preço normal', async () => {
    const { service, products } = setup();
    await expect(
      service.create(STORE, { ...newProduct, promotion_price: 25 }),
    ).rejects.toThrow(
      new BadRequestException(
        'O preço promocional deve ser menor que o preço normal.',
      ),
    );
    expect(products.save).not.toHaveBeenCalled();

    await service.create(STORE, { ...newProduct, promotion_price: 15 });
    expect(products.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: '', promotion_price: 15 }),
    );
  });

  it('PATCH só de disponibilidade não esbarra em promoção antiga; lista vazia limpa os adicionais', async () => {
    const { service, tx } = setup();

    await expect(
      service.update(STORE, 1, { available: false }),
    ).resolves.toBeDefined();

    await service.update(STORE, 1, { allowed_addons_ids: [] });
    expect(tx.save).toHaveBeenLastCalledWith(Product, {
      id: 1,
      allowed_addons: [],
    });

    // Preço novo conferido contra a promoção gravada (35)
    await expect(
      service.update(STORE, 1, { price: 40 }),
    ).resolves.toBeDefined();
    await expect(
      service.update(STORE, 1, { price: 10 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('PATCH vazio não grava nada e devolve o produto', async () => {
    const { service, tx, products } = setup();
    await expect(service.update(STORE, 1, {})).resolves.toMatchObject({
      id: 1,
    });
    expect(products.manager.transaction).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('exclusão permanente: 404 se não existe, 409 se o produto está em pedidos', async () => {
    const { service, products, setInOrders } = setup();

    products.exists.mockResolvedValueOnce(false);
    await expect(service.removePermanent(STORE, 9)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    setInOrders(true);
    await expect(service.removePermanent(STORE, 1)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(products.delete).not.toHaveBeenCalled();

    setInOrders(false);
    products.delete.mockRejectedValueOnce(pgError('23503'));
    await expect(service.removePermanent(STORE, 1)).rejects.toBeInstanceOf(
      ConflictException,
    );

    await expect(service.removePermanent(STORE, 1)).resolves.toEqual({
      message: 'Produto excluído permanentemente.',
    });
  });

  it('adicionais: PATCH vazio não grava; id de outra loja ou desconhecido → 404', async () => {
    const { service, addons } = setup();

    await expect(service.updateAddon(STORE, 3, {})).resolves.toMatchObject({
      id: 3,
    });
    expect(addons.update).not.toHaveBeenCalled();
    expect(addons.findOneBy).toHaveBeenLastCalledWith({
      id: 3,
      store_id: STORE,
    });

    await service.updateAddon(STORE, 3, { name: 'Bacon duplo' });
    expect(addons.update).toHaveBeenLastCalledWith(
      { id: 3, store_id: STORE, deleted_at: IsNull() },
      { name: 'Bacon duplo' },
    );

    addons.findOneBy.mockResolvedValueOnce(null as unknown as Addon);
    await expect(
      service.updateAddon(OTHER_STORE, 3, { name: 'X' }),
    ).rejects.toThrow(new NotFoundException('Adicional não encontrado.'));

    addons.update.mockResolvedValueOnce({ affected: 0 });
    await expect(
      service.updateAddon(STORE, 3, { name: 'Y' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('adicionais: cadastro grava a loja; exclusão por id + loja (404 se não afetou nada)', async () => {
    const { service, addons } = setup();

    await service.createAddon(STORE, { name: 'Cheddar', price: 3 });
    expect(addons.create).toHaveBeenLastCalledWith({
      name: 'Cheddar',
      price: 3,
      store_id: STORE,
    });

    await expect(service.deleteAddon(STORE, 3)).resolves.toEqual({
      message: 'Adicional excluído.',
    });
    expect(addons.softDelete).toHaveBeenLastCalledWith({
      id: 3,
      store_id: STORE,
      deleted_at: IsNull(),
    });

    addons.softDelete.mockResolvedValueOnce({ affected: 0 });
    await expect(service.deleteAddon(OTHER_STORE, 3)).rejects.toThrow(
      new NotFoundException('Adicional não encontrado.'),
    );
  });
});

describe('ProductsService — arquivo da imagem substituída', () => {
  const originalEnv = { ...process.env };
  let uploads: string;

  beforeEach(() => {
    uploads = mkdtempSync(join(tmpdir(), 'products-service-uploads-'));
    process.env = { ...originalEnv, UPLOADS_DIR: uploads };
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(uploads, { recursive: true, force: true });
  });

  /** Grava um arquivo em /uploads e devolve o caminho completo. */
  function upload(name: string): string {
    const file = join(uploads, name);
    writeFileSync(file, 'img');
    return file;
  }

  /** Serviço em que "o arquivo ainda é usado?" responde por entidade (produto, adicional, logo). */
  function withUsage(
    inUse: { product?: boolean; addon?: boolean; logo?: boolean } = {},
  ) {
    const ctx = setup();
    const exists = jest.fn((entity: unknown) =>
      Promise.resolve(
        (entity === Product && !!inUse.product) ||
          (entity === Addon && !!inUse.addon) ||
          (entity === Store && !!inUse.logo),
      ),
    );
    Object.assign(ctx.products.manager, { exists });
    return { ...ctx, exists };
  }

  const productWith = (image: string | null) =>
    ({
      id: 1,
      store_id: STORE,
      name: 'X-Burger',
      price: '30.00',
      promotion_price: null,
      image,
      allowed_addons: [],
    }) as unknown as Product;

  it('produto: a imagem enviada pela loja trocada ou removida tem o arquivo anterior apagado', async () => {
    const ctx = withUsage();
    const previous = upload('s7-compressed-1.webp');
    const next = upload('s7-compressed-2.webp');
    ctx.products.findOne.mockResolvedValueOnce(
      productWith('s7-compressed-1.webp'),
    );

    await ctx.service.update(STORE, 1, { image: 's7-compressed-2.webp' });
    expect(existsSync(previous)).toBe(false);
    expect(existsSync(next)).toBe(true);
    // Uso conferido em produtos e adicionais (inclusive na lixeira) e nos logos, nos dois formatos gravados
    const refs = In(['s7-compressed-1.webp', '/uploads/s7-compressed-1.webp']);
    expect(ctx.exists).toHaveBeenCalledWith(Product, {
      where: { image: refs },
      withDeleted: true,
    });
    expect(ctx.exists).toHaveBeenCalledWith(Addon, {
      where: { image: refs },
      withDeleted: true,
    });
    expect(ctx.exists).toHaveBeenCalledWith(Store, { where: { logo: refs } });

    // Imagem removida (null): o arquivo também sai
    ctx.products.findOne.mockResolvedValueOnce(
      productWith('s7-compressed-2.webp'),
    );
    await ctx.service.update(STORE, 1, { image: null });
    expect(existsSync(next)).toBe(false);
  });

  it('produto: arquivo ainda usado por outro produto, adicional ou logo continua no disco', async () => {
    for (const inUse of [{ product: true }, { addon: true }, { logo: true }]) {
      const ctx = withUsage(inUse);
      const previous = upload('s7-compartilhada.webp');
      ctx.products.findOne.mockResolvedValueOnce(
        productWith('s7-compartilhada.webp'),
      );
      await ctx.service.update(STORE, 1, { image: 's7-nova.webp' });
      expect(existsSync(previous)).toBe(true);
    }
  });

  it('produto: imagem antiga sem prefixo, de outra loja, externa, igual ou não enviada → nada é apagado nem consultado', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['1770667391414-269457043.jpg', { image: 's7-nova.webp' }],
      ['s8-de-outra-loja.webp', { image: 's7-nova.webp' }],
      ['https://cdn.exemplo.com/foto.webp', { image: 's7-nova.webp' }],
      ['s7-mesma.webp', { image: 's7-mesma.webp' }],
      ['s7-mesma.webp', { name: 'Outro nome' }],
    ];
    for (const [current, dto] of cases) {
      const ctx = withUsage();
      const file = /^https:/.test(current) ? null : upload(current);
      ctx.products.findOne.mockResolvedValueOnce(productWith(current));
      await ctx.service.update(STORE, 1, dto);
      if (file) expect(existsSync(file)).toBe(true);
      expect(ctx.exists).not.toHaveBeenCalled();
    }
  });

  it('falha ao conferir o uso do arquivo não derruba a edição já gravada (o arquivo fica; aviso no log)', async () => {
    const ctx = withUsage();
    ctx.exists.mockRejectedValue(new Error('banco fora do ar'));
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const previous = upload('s7-compressed-9.webp');
    ctx.products.findOne.mockResolvedValueOnce(
      productWith('s7-compressed-9.webp'),
    );

    await expect(
      ctx.service.update(STORE, 1, { image: 's7-compressed-10.webp' }),
    ).resolves.toBeDefined();
    expect(existsSync(previous)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('s7-compressed-9.webp'),
    );
    warn.mockRestore();
  });

  it('adicional: mesma regra (arquivo da loja sem outro uso é apagado; em uso, fica)', async () => {
    const ctx = withUsage();
    const previous = upload('s7-bacon-1.webp');
    ctx.addons.findOneBy.mockResolvedValueOnce({
      id: 3,
      store_id: STORE,
      name: 'Bacon',
      image: 's7-bacon-1.webp',
    } as Addon);
    await ctx.service.updateAddon(STORE, 3, { image: 's7-bacon-2.webp' });
    expect(existsSync(previous)).toBe(false);

    const shared = withUsage({ product: true });
    const kept = upload('s7-bacon-3.webp');
    shared.addons.findOneBy.mockResolvedValueOnce({
      id: 3,
      store_id: STORE,
      name: 'Bacon',
      image: 's7-bacon-3.webp',
    } as Addon);
    await shared.service.updateAddon(STORE, 3, { image: 's7-bacon-4.webp' });
    expect(existsSync(kept)).toBe(true);
  });
});
