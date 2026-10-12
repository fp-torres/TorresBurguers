import {
  INestApplication,
  NotFoundException,
  Type,
  ValidationPipe,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthGuard } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { RolesGuard } from '../auth/roles.guard';
import { AddonsController } from './addons.controller';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

// PNG 1x1 válido
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

/** Metadado gravado pelos decorators no método do controller. */
const metadataOf = (key: string, controller: Type, method: string): unknown =>
  Reflect.getMetadata(
    key,
    (controller.prototype as Record<string, object>)[method],
  );

const bodyOf = (res: request.Response) =>
  res.body as { message?: string | string[]; image?: string };

describe('ProductsController / AddonsController (HTTP)', () => {
  let app: INestApplication<App>;
  let server: App;
  let uploads: string;
  const service = {
    findAll: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue({ id: 1 }),
    create: jest
      .fn()
      .mockImplementation((dto: unknown) => Promise.resolve(dto)),
    update: jest
      .fn()
      .mockImplementation((_id: number, dto: unknown) => Promise.resolve(dto)),
    createAddon: jest
      .fn()
      .mockImplementation((dto: unknown) => Promise.resolve(dto)),
    updateAddon: jest
      .fn()
      .mockImplementation((_id: number, dto: unknown) => Promise.resolve(dto)),
  };

  beforeAll(async () => {
    uploads = mkdtempSync(join(tmpdir(), 'uploads-spec-'));
    process.env.UPLOADS_DIR = uploads;

    const moduleRef = await Test.createTestingModule({
      controllers: [ProductsController, AddonsController],
      providers: [{ provide: ProductsService, useValue: service }],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    // Mesma configuração do ValidationPipe global da API
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.UPLOADS_DIR;
    rmSync(uploads, { recursive: true, force: true });
  });

  beforeEach(() => jest.clearAllMocks());

  it('escritas do cardápio exigem JWT + perfil ADMIN; leituras são públicas', () => {
    const adminOnly: [Type, string][] = [
      [ProductsController, 'create'],
      [ProductsController, 'update'],
      [ProductsController, 'remove'],
      [ProductsController, 'restore'],
      [ProductsController, 'removePermanent'],
      [ProductsController, 'findDeleted'],
      [AddonsController, 'create'],
      [AddonsController, 'update'],
      [AddonsController, 'remove'],
    ];
    for (const [controller, method] of adminOnly) {
      expect(metadataOf('roles', controller, method)).toEqual(['ADMIN']);
      expect(metadataOf(GUARDS_METADATA, controller, method)).toContain(
        RolesGuard,
      );
    }
    expect(
      metadataOf(GUARDS_METADATA, ProductsController, 'findAll'),
    ).toBeUndefined();
    expect(
      metadataOf(GUARDS_METADATA, AddonsController, 'findAll'),
    ).toBeUndefined();
  });

  it('converte o FormData do painel (campo único de adicional, preço em texto, booleano)', async () => {
    await request(server)
      .post('/products')
      .field('name', ' X-Bacon da Casa ')
      .field('description', 'Pão, carne e bacon')
      .field('price', '25.9')
      .field('category', 'Hambúrgueres')
      .field('available', 'true')
      .field('ingredients', 'Pão')
      .field('allowed_addons_ids', '12')
      .expect(201);

    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'X-Bacon da Casa',
        price: 25.9,
        category: 'hamburgueres',
        available: true,
        ingredients: ['Pão'],
        allowed_addons_ids: [12],
      }),
    );
  });

  it('aceita JSON com available: true (antes era salvo como false)', async () => {
    await request(server)
      .post('/products')
      .send({ name: 'Suco', price: 8, category: 'bebidas', available: true })
      .expect(201);
    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({ available: true, price: 8 }),
    );
  });

  it('recusa corpo inválido com 400 e uma mensagem por campo', async () => {
    const res = await request(server)
      .post('/products')
      .send({ name: '', price: -1, category: 'pizza' })
      .expect(400);
    expect(bodyOf(res).message).toEqual([
      'O nome do produto é obrigatório.',
      'O preço não pode ser negativo.',
      expect.stringContaining('Categoria inválida'),
    ]);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('recusa campos fora do DTO (sem atribuição em massa)', async () => {
    const res = await request(server)
      .patch('/products/1')
      .send({ id: 2, name: 'Outro' })
      .expect(400);
    expect(bodyOf(res).message).toContain('property id should not exist');
  });

  it('PATCH parcial: só o que foi enviado; null proibido em obrigatórios, permitido para limpar promoção', async () => {
    await request(server)
      .patch('/products/1')
      .field('available', 'false')
      .field('promotion_price', '')
      .expect(200);
    expect(service.update).toHaveBeenCalledWith(1, {
      available: false,
      promotion_price: null,
    });

    await request(server).patch('/products/1').send({ name: null }).expect(400);
  });

  it('preço promocional vazio, 0 ou negativo = sem promoção (null); acima do limite → 400', async () => {
    for (const promotion_price of [0, -5, '0', '0,00', '']) {
      service.create.mockClear();
      await request(server)
        .post('/products')
        .send({ name: 'Suco', price: 8, category: 'bebidas', promotion_price })
        .expect(201);
      expect(service.create).toHaveBeenCalledWith(
        expect.objectContaining({ price: 8, promotion_price: null }),
      );
    }

    await request(server)
      .patch('/products/1')
      .field('promotion_price', '0')
      .expect(200);
    expect(service.update).toHaveBeenCalledWith(1, { promotion_price: null });

    await request(server)
      .post('/products')
      .send({
        name: 'Suco',
        price: 8,
        category: 'bebidas',
        promotion_price: 7.5,
      })
      .expect(201);
    expect(service.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ promotion_price: 7.5 }),
    );

    const tooHigh = await request(server)
      .post('/products')
      .send({ name: 'Caro', price: 1_000_000, category: 'bebidas' })
      .expect(400);
    expect(bodyOf(tooHigh).message).toEqual([
      'Preço acima do limite permitido.',
    ]);
  });

  it('salva a imagem enviada como .webp na pasta de uploads', async () => {
    const res = await request(server)
      .post('/products')
      .field('name', 'Com foto')
      .field('price', '10')
      .field('category', 'bebidas')
      .attach('file', PNG, { filename: 'foto.png', contentType: 'image/png' })
      .expect(201);

    const image = bodyOf(res).image ?? '';
    expect(image).toMatch(/^compressed-.+\.webp$/);
    expect(existsSync(join(uploads, image))).toBe(true);
  });

  it('recusa imagem acima de 5 MB e arquivos que não são JPG/PNG/WebP com 400', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
    const tooBig = await request(server)
      .post('/products')
      .field('name', 'Grande')
      .attach('file', big, { filename: 'grande.png', contentType: 'image/png' })
      .expect(400);
    expect(bodyOf(tooBig).message).toBe(
      'Imagem muito grande. O tamanho máximo é 5 MB.',
    );

    const fake = await request(server)
      .post('/products')
      .field('name', 'Falsa')
      .field('price', '10')
      .field('category', 'bebidas')
      .attach('file', Buffer.from('não sou imagem'), {
        filename: 'falsa.png',
        contentType: 'image/png',
      })
      .expect(400);
    expect(bodyOf(fake).message).toContain('Formato de imagem inválido');
  });

  it('não deixa imagem órfã quando o formulário é inválido ou o cadastro falha', async () => {
    const before = readdirSync(uploads).length;

    await request(server)
      .post('/products')
      .field('name', 'Sem preço')
      .attach('file', PNG, { filename: 'foto.png', contentType: 'image/png' })
      .expect(400);

    service.update.mockRejectedValueOnce(
      new NotFoundException('Produto não encontrado.'),
    );
    await request(server)
      .patch('/products/999')
      .field('name', 'Novo nome')
      .attach('file', PNG, { filename: 'foto.png', contentType: 'image/png' })
      .expect(404);

    expect(readdirSync(uploads).length).toBe(before);
  });

  it('ids fora do intervalo do banco viram 400 (e não 500)', async () => {
    await request(server).get('/products/abc').expect(400);
    await request(server).get('/products/99999999999').expect(400);
    await request(server).get('/products/7').expect(200);
    expect(service.findOne).toHaveBeenCalledWith(7);

    // Ids no corpo também
    const inBody = await request(server)
      .patch('/products/7')
      .send({ allowed_addons_ids: [1, 99_999_999_999] })
      .expect(400);
    expect(bodyOf(inBody).message).toEqual(['Id inválido.']);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('adicionais: valida preço e normaliza categoria; PATCH vazio não quebra', async () => {
    const negative = await request(server)
      .post('/addons')
      .send({ name: 'Bacon', price: -1 })
      .expect(400);
    expect(bodyOf(negative).message).toEqual([
      'O preço do adicional não pode ser negativo.',
    ]);

    await request(server)
      .post('/addons')
      .send({ name: 'Bacon', price: '4,50', category: 'Bebidas' })
      .expect(201);
    expect(service.createAddon).toHaveBeenCalledWith({
      name: 'Bacon',
      price: 4.5,
      category: 'bebidas',
    });

    await request(server).patch('/addons/3').send({}).expect(200);
    expect(service.updateAddon).toHaveBeenCalledWith(3, {});
  });
});
