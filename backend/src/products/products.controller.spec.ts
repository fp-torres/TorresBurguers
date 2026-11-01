import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  INestApplication,
  NotFoundException,
  Type,
  UnauthorizedException,
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
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth-user';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { PublicStoreGuard, StoreStaffGuard, TenantService } from '../tenancy';
import { UserRole } from '../users/entities/user.entity';
import { AddonsController } from './addons.controller';
import { INVALID_IMAGE_REF_MESSAGE } from './dto/create-product.dto';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

// PNG 1x1 válido
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

/** Lojas do teste: a 3 é a loja padrão das rotas antigas. */
const STORES = {
  1: { id: 1, slug: 'loja-a', time_zone: 'America/Sao_Paulo' },
  2: { id: 2, slug: 'loja-b', time_zone: 'America/Manaus' },
  3: { id: 3, slug: 'padrao', time_zone: 'America/Sao_Paulo' },
} as const;
type StoreId = keyof typeof STORES;

const context = (id: StoreId) => ({
  storeId: id,
  store: STORES[id],
  subscription: null,
  access: { canSell: true, publicVisible: true },
});

/** TenantService falso com as mesmas regras de resolução (slug, loja da equipe, loja padrão). */
const tenants = {
  contextForStoreId: jest.fn((id: StoreId) => Promise.resolve(context(id))),
  publicContext: jest.fn((slug?: string | null) => {
    if (slug === undefined || slug === null) return Promise.resolve(context(3));
    const store = Object.values(STORES).find((item) => item.slug === slug);
    return store
      ? Promise.resolve(context(store.id))
      : Promise.reject(new NotFoundException('Loja não encontrada.'));
  }),
  staffContext: jest.fn((user: AuthUser) =>
    user.storeId && user.role !== UserRole.CLIENT
      ? Promise.resolve(context(user.storeId as StoreId))
      : Promise.reject(
          new ForbiddenException(
            'Esta área é exclusiva da equipe de uma loja.',
          ),
        ),
  ),
  assertCanSell: jest.fn(),
  // Equipe nas rotas antigas: leitura liberada nas lojas do teste (a regra fica em guards.spec.ts)
  assertCapability: jest.fn(),
};

const user = (role: UserRole, storeId: number | null): AuthUser => ({
  id: 100 + (storeId ?? 0),
  email: `${role.toLowerCase()}@teste.com`,
  name: role,
  role,
  storeId,
  platformRole: null,
});
const ADMIN_A = user(UserRole.ADMIN, 1);
const EMPLOYEE_A = user(UserRole.EMPLOYEE, 1);
const CLIENT = user(UserRole.CLIENT, null);

/** Sessão do teste vai no cabeçalho x-test-user (no lugar do JWT). */
const as = (session: AuthUser) => ({
  'x-test-user': JSON.stringify(session),
});
function sessionFrom(context: ExecutionContext): AuthUser | null {
  const req = context
    .switchToHttp()
    .getRequest<{ headers: Record<string, string>; user?: unknown }>();
  const raw = req.headers['x-test-user'];
  req.user = raw ? (JSON.parse(raw) as AuthUser) : null;
  return req.user as AuthUser | null;
}
const requiredAuth: CanActivate = {
  canActivate: (context) => {
    if (!sessionFrom(context)) throw new UnauthorizedException();
    return true;
  },
};
const optionalAuth: CanActivate = {
  canActivate: (context) => {
    sessionFrom(context);
    return true;
  },
};

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
  const echo = jest.fn((...args: unknown[]) =>
    Promise.resolve(args[args.length - 1]),
  );
  const service = {
    findAll: jest.fn().mockResolvedValue([]),
    findDeleted: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue({ id: 1 }),
    create: echo,
    update: jest.fn((...args: unknown[]) => Promise.resolve(args[2])),
    restore: jest.fn().mockResolvedValue({ id: 1 }),
    remove: jest
      .fn()
      .mockResolvedValue({ message: 'Produto movido para a lixeira.' }),
    removePermanent: jest
      .fn()
      .mockResolvedValue({ message: 'Produto excluído permanentemente.' }),
    findAllAddons: jest.fn().mockResolvedValue([]),
    createAddon: jest.fn((...args: unknown[]) => Promise.resolve(args[1])),
    updateAddon: jest.fn((...args: unknown[]) => Promise.resolve(args[2])),
    deleteAddon: jest
      .fn()
      .mockResolvedValue({ message: 'Adicional excluído.' }),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };

  beforeAll(async () => {
    uploads = mkdtempSync(join(tmpdir(), 'uploads-spec-'));
    process.env.UPLOADS_DIR = uploads;

    // Guards reais da loja (StoreStaffGuard, PublicStoreGuard, RolesGuard); só o JWT é simulado
    const moduleRef = await Test.createTestingModule({
      controllers: [ProductsController, AddonsController],
      providers: [
        { provide: ProductsService, useValue: service },
        { provide: TenantService, useValue: tenants },
        { provide: AuditService, useValue: audit },
      ],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useValue(requiredAuth)
      .overrideGuard(OptionalJwtAuthGuard)
      .useValue(optionalAuth)
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

  describe('acesso e loja de cada rota', () => {
    it('gestão exige equipe da loja + ADMIN; leituras usam a loja da vitrine', () => {
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
        expect(metadataOf(GUARDS_METADATA, controller, method)).toEqual(
          expect.arrayContaining([StoreStaffGuard, RolesGuard]),
        );
      }
      for (const [controller, method] of [
        [ProductsController, 'findAll'],
        [ProductsController, 'findOne'],
        [AddonsController, 'findAll'],
      ] as [Type, string][]) {
        expect(metadataOf(GUARDS_METADATA, controller, method)).toEqual([
          OptionalJwtAuthGuard,
          PublicStoreGuard,
        ]);
      }
    });

    it('rotas antigas: visitante e cliente veem a loja padrão; a equipe vê a própria loja', async () => {
      await request(server).get('/products').expect(200);
      expect(service.findAll).toHaveBeenLastCalledWith(3);

      await request(server).get('/products').set(as(CLIENT)).expect(200);
      expect(service.findAll).toHaveBeenLastCalledWith(3);

      await request(server).get('/products').set(as(EMPLOYEE_A)).expect(200);
      expect(service.findAll).toHaveBeenLastCalledWith(1);

      await request(server).get('/products/7').expect(200);
      expect(service.findOne).toHaveBeenLastCalledWith(3, 7);

      await request(server).get('/addons').set(as(ADMIN_A)).expect(200);
      expect(service.findAllAddons).toHaveBeenLastCalledWith(1);
    });

    it('com slug: sempre a loja do slug (o token não troca a loja); slug inexistente → 404', async () => {
      await request(server)
        .get('/stores/loja-b/products')
        .set(as(ADMIN_A))
        .expect(200);
      expect(service.findAll).toHaveBeenLastCalledWith(2);

      await request(server).get('/stores/loja-b/products/5').expect(200);
      expect(service.findOne).toHaveBeenLastCalledWith(2, 5);

      await request(server).get('/stores/loja-b/addons').expect(200);
      expect(service.findAllAddons).toHaveBeenLastCalledWith(2);

      const missing = await request(server)
        .get('/stores/nao-existe/products')
        .expect(404);
      expect(bodyOf(missing).message).toBe('Loja não encontrada.');
      expect(service.findAll).toHaveBeenCalledTimes(1);
    });

    it('gestão: anônimo 401, cliente e outros perfis 403, ADMIN grava na própria loja', async () => {
      const body = { name: 'Suco', price: 8, category: 'bebidas' };

      await request(server).post('/products').send(body).expect(401);
      await request(server)
        .post('/products')
        .set(as(CLIENT))
        .send(body)
        .expect(403);
      await request(server)
        .post('/products')
        .set(as(EMPLOYEE_A))
        .send(body)
        .expect(403);
      expect(service.create).not.toHaveBeenCalled();

      await request(server)
        .post('/products')
        .set(as(ADMIN_A))
        .send(body)
        .expect(201);
      expect(service.create).toHaveBeenLastCalledWith(
        1,
        expect.objectContaining({ name: 'Suco' }),
      );

      await request(server)
        .post('/stores/loja-a/products')
        .set(as(ADMIN_A))
        .send(body)
        .expect(201);
      expect(service.create).toHaveBeenLastCalledWith(
        1,
        expect.objectContaining({ name: 'Suco' }),
      );
    });

    it('slug de outra loja nas rotas de gestão → 403 e nada é gravado', async () => {
      const calls: [string, string][] = [
        ['post', '/stores/loja-b/products'],
        ['patch', '/stores/loja-b/products/1'],
        ['patch', '/stores/loja-b/products/1/restore'],
        ['delete', '/stores/loja-b/products/1'],
        ['delete', '/stores/loja-b/products/1/permanent'],
        ['get', '/stores/loja-b/products/trash'],
        ['post', '/stores/loja-b/addons'],
        ['patch', '/stores/loja-b/addons/3'],
        ['delete', '/stores/loja-b/addons/3'],
      ];
      for (const [method, path] of calls) {
        const req = request(server)[method as 'get'](path).set(as(ADMIN_A));
        const res = await (method === 'post' || method === 'patch'
          ? req.send({ name: 'X', price: 1, category: 'bebidas' })
          : req);
        expect({ path, status: res.status }).toEqual({ path, status: 403 });
      }
      for (const fn of Object.values(service)) {
        if (fn === service.findAll || fn === service.findOne) continue;
        expect(fn).not.toHaveBeenCalled();
      }
    });

    it('lixeira, restauração, exclusão e adicionais usam a loja do usuário', async () => {
      await request(server).get('/products/trash').set(as(ADMIN_A)).expect(200);
      expect(service.findDeleted).toHaveBeenLastCalledWith(1);

      await request(server)
        .patch('/products/4/restore')
        .set(as(ADMIN_A))
        .expect(200);
      expect(service.restore).toHaveBeenLastCalledWith(1, 4);

      await request(server).delete('/products/4').set(as(ADMIN_A)).expect(200);
      expect(service.remove).toHaveBeenLastCalledWith(1, 4);

      await request(server).delete('/addons/3').set(as(ADMIN_A)).expect(200);
      expect(service.deleteAddon).toHaveBeenLastCalledWith(1, 3);

      await request(server)
        .patch('/addons/3')
        .set(as(ADMIN_A))
        .send({})
        .expect(200);
      expect(service.updateAddon).toHaveBeenLastCalledWith(1, 3, {});
    });

    it('exclusão definitiva fica na auditoria da loja (só quando dá certo)', async () => {
      await request(server)
        .delete('/products/4/permanent')
        .set(as(ADMIN_A))
        .expect(200);
      expect(service.removePermanent).toHaveBeenLastCalledWith(1, 4);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'catalog.product.delete_permanent',
          storeId: 1,
          targetType: 'product',
          targetId: 4,
          actor: expect.objectContaining({ id: ADMIN_A.id }) as unknown,
        }),
      );

      audit.record.mockClear();
      service.removePermanent.mockRejectedValueOnce(
        new NotFoundException('Produto não encontrado.'),
      );
      await request(server)
        .delete('/products/99/permanent')
        .set(as(ADMIN_A))
        .expect(404);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('corpo e imagens', () => {
    it('converte o FormData do painel (campo único de adicional, preço em texto, booleano)', async () => {
      await request(server)
        .post('/products')
        .set(as(ADMIN_A))
        .field('name', ' X-Bacon da Casa ')
        .field('description', 'Pão, carne e bacon')
        .field('price', '25.9')
        .field('category', 'Hambúrgueres')
        .field('available', 'true')
        .field('ingredients', 'Pão')
        .field('allowed_addons_ids', '12')
        .expect(201);

      expect(service.create).toHaveBeenCalledWith(
        1,
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
        .set(as(ADMIN_A))
        .send({ name: 'Suco', price: 8, category: 'bebidas', available: true })
        .expect(201);
      expect(service.create).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ available: true, price: 8 }),
      );
    });

    it('recusa corpo inválido com 400 e uma mensagem por campo', async () => {
      const res = await request(server)
        .post('/products')
        .set(as(ADMIN_A))
        .send({ name: '', price: -1, category: 'pizza' })
        .expect(400);
      expect(bodyOf(res).message).toEqual([
        'O nome do produto é obrigatório.',
        'O preço não pode ser negativo.',
        expect.stringContaining('Categoria inválida'),
      ]);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('recusa campos fora do DTO (sem atribuição em massa, nem store_id)', async () => {
      const res = await request(server)
        .patch('/products/1')
        .set(as(ADMIN_A))
        .send({ id: 2, name: 'Outro' })
        .expect(400);
      expect(bodyOf(res).message).toContain('property id should not exist');

      const store = await request(server)
        .post('/products')
        .set(as(ADMIN_A))
        .send({ name: 'Suco', price: 8, category: 'bebidas', store_id: 2 })
        .expect(400);
      expect(bodyOf(store).message).toContain(
        'property store_id should not exist',
      );
      expect(service.update).not.toHaveBeenCalled();
      expect(service.create).not.toHaveBeenCalled();
    });

    it('PATCH parcial: só o que foi enviado; null proibido em obrigatórios, permitido para limpar promoção', async () => {
      await request(server)
        .patch('/products/1')
        .set(as(ADMIN_A))
        .field('available', 'false')
        .field('promotion_price', '')
        .expect(200);
      expect(service.update).toHaveBeenCalledWith(1, 1, {
        available: false,
        promotion_price: null,
      });

      await request(server)
        .patch('/products/1')
        .set(as(ADMIN_A))
        .send({ name: null })
        .expect(400);
    });

    it('preço promocional vazio, 0 ou negativo = sem promoção (null); acima do limite → 400', async () => {
      for (const promotion_price of [0, -5, '0', '0,00', '']) {
        service.create.mockClear();
        await request(server)
          .post('/products')
          .set(as(ADMIN_A))
          .send({
            name: 'Suco',
            price: 8,
            category: 'bebidas',
            promotion_price,
          })
          .expect(201);
        expect(service.create).toHaveBeenCalledWith(
          1,
          expect.objectContaining({ price: 8, promotion_price: null }),
        );
      }

      await request(server)
        .patch('/products/1')
        .set(as(ADMIN_A))
        .field('promotion_price', '0')
        .expect(200);
      expect(service.update).toHaveBeenCalledWith(1, 1, {
        promotion_price: null,
      });

      const tooHigh = await request(server)
        .post('/products')
        .set(as(ADMIN_A))
        .send({ name: 'Caro', price: 1_000_000, category: 'bebidas' })
        .expect(400);
      expect(bodyOf(tooHigh).message).toEqual([
        'Preço acima do limite permitido.',
      ]);
    });

    it('imagem como texto: http://, caminho e javascript: → 400; https:// passa para o serviço', async () => {
      for (const image of [
        'http://cdn.exemplo.com/suco.png',
        '../../etc/passwd',
        'javascript:alert(1)',
        'pasta/foto.webp',
      ]) {
        const res = await request(server)
          .post('/products')
          .set(as(ADMIN_A))
          .send({ name: 'Suco', price: 8, category: 'bebidas', image })
          .expect(400);
        expect(bodyOf(res).message).toEqual([INVALID_IMAGE_REF_MESSAGE]);
      }
      expect(service.create).not.toHaveBeenCalled();

      await request(server)
        .post('/products')
        .set(as(ADMIN_A))
        .send({
          name: 'Suco',
          price: 8,
          category: 'bebidas',
          image: '/uploads/s1-compressed-1.webp',
        })
        .expect(201);
      expect(service.create).toHaveBeenLastCalledWith(
        1,
        expect.objectContaining({ image: 's1-compressed-1.webp' }),
      );
    });

    it('salva a imagem enviada como .webp, com o prefixo da loja, na pasta de uploads', async () => {
      const res = await request(server)
        .post('/products')
        .set(as(ADMIN_A))
        .field('name', 'Com foto')
        .field('price', '10')
        .field('category', 'bebidas')
        .attach('file', PNG, { filename: 'foto.png', contentType: 'image/png' })
        .expect(201);

      const image = bodyOf(res).image ?? '';
      expect(image).toMatch(/^s1-compressed-.+\.webp$/);
      expect(existsSync(join(uploads, image))).toBe(true);

      // O arquivo enviado prevalece sobre o texto do campo "image"
      const patched = await request(server)
        .patch('/products/1')
        .set(as(ADMIN_A))
        .field('image', 'https://cdn.exemplo.com/x.png')
        .attach('file', PNG, { filename: 'foto.png', contentType: 'image/png' })
        .expect(200);
      expect(bodyOf(patched).image).toMatch(/^s1-compressed-.+\.webp$/);
    });

    it('adicional também aceita imagem no multipart (prefixo da loja)', async () => {
      const res = await request(server)
        .post('/addons')
        .set(as(ADMIN_A))
        .field('name', 'Bacon')
        .field('price', '4,50')
        .attach('file', PNG, {
          filename: 'bacon.png',
          contentType: 'image/png',
        })
        .expect(201);
      expect(service.createAddon).toHaveBeenLastCalledWith(
        1,
        expect.objectContaining({ name: 'Bacon', price: 4.5 }),
      );
      expect(bodyOf(res).image).toMatch(/^s1-compressed-.+\.webp$/);
    });

    it('recusa imagem acima de 5 MB e arquivos que não são JPG/PNG/WebP com 400', async () => {
      const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
      const tooBig = await request(server)
        .post('/products')
        .set(as(ADMIN_A))
        .field('name', 'Grande')
        .attach('file', big, {
          filename: 'grande.png',
          contentType: 'image/png',
        })
        .expect(400);
      expect(bodyOf(tooBig).message).toBe(
        'Imagem muito grande. O tamanho máximo é 5 MB.',
      );

      const fake = await request(server)
        .post('/products')
        .set(as(ADMIN_A))
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

    it('não deixa imagem órfã quando o formulário é inválido, o cadastro falha ou o acesso é negado', async () => {
      const before = readdirSync(uploads).length;

      await request(server)
        .post('/products')
        .set(as(ADMIN_A))
        .field('name', 'Sem preço')
        .attach('file', PNG, { filename: 'foto.png', contentType: 'image/png' })
        .expect(400);

      service.update.mockRejectedValueOnce(
        new NotFoundException('Produto não encontrado.'),
      );
      await request(server)
        .patch('/products/999')
        .set(as(ADMIN_A))
        .field('name', 'Novo nome')
        .attach('file', PNG, { filename: 'foto.png', contentType: 'image/png' })
        .expect(404);

      // Sem permissão: o upload nem é lido (guards antes do multer)
      await request(server)
        .post('/products')
        .set(as(EMPLOYEE_A))
        .field('name', 'X')
        .attach('file', PNG, { filename: 'foto.png', contentType: 'image/png' })
        .expect(403);

      expect(readdirSync(uploads).length).toBe(before);
    });

    it('ids fora do intervalo do banco viram 400 (e não 500)', async () => {
      await request(server).get('/products/abc').expect(400);
      await request(server).get('/products/99999999999').expect(400);
      await request(server).get('/products/7').expect(200);
      expect(service.findOne).toHaveBeenCalledWith(3, 7);

      // Ids no corpo também
      const inBody = await request(server)
        .patch('/products/7')
        .set(as(ADMIN_A))
        .send({ allowed_addons_ids: [1, 99_999_999_999] })
        .expect(400);
      expect(bodyOf(inBody).message).toEqual(['Id inválido.']);
      expect(service.update).not.toHaveBeenCalled();
    });

    it('adicionais: valida preço e normaliza categoria; PATCH vazio não quebra', async () => {
      const negative = await request(server)
        .post('/addons')
        .set(as(ADMIN_A))
        .send({ name: 'Bacon', price: -1 })
        .expect(400);
      expect(bodyOf(negative).message).toEqual([
        'O preço do adicional não pode ser negativo.',
      ]);

      await request(server)
        .post('/addons')
        .set(as(ADMIN_A))
        .send({ name: 'Bacon', price: '4,50', category: 'Bebidas' })
        .expect(201);
      expect(service.createAddon).toHaveBeenCalledWith(1, {
        name: 'Bacon',
        price: 4.5,
        category: 'bebidas',
      });

      await request(server)
        .patch('/addons/3')
        .set(as(ADMIN_A))
        .send({})
        .expect(200);
      expect(service.updateAddon).toHaveBeenCalledWith(1, 3, {});
    });
  });
});
