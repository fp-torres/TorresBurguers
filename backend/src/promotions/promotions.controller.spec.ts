import { INestApplication, NotFoundException, Type } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { PublicStoreGuard, TenantService } from '../tenancy';
import {
  PromotionsController,
  StorePromotionsController,
} from './promotions.controller';
import { PromotionsService } from './promotions.service';

const STORE = { id: 4, slug: 'loja-norte', time_zone: 'America/Manaus' };

/** Método do controller (onde os decorators gravam os metadados). */
const handlerOf = (controller: Type, method: string): object =>
  (controller.prototype as Record<string, object>)[method];

describe('Banner (HTTP)', () => {
  let app: INestApplication<App>;
  let server: App;
  const banner = { type: 'promo', title: 'Sextou! 🎉', message: 'Sugestão' };
  const service = {
    getBanner: jest.fn().mockResolvedValue(banner),
    getStoreBanner: jest.fn().mockResolvedValue(banner),
  };
  const tenants = {
    publicContext: jest.fn((slug?: string | null) =>
      slug === STORE.slug
        ? Promise.resolve({
            storeId: STORE.id,
            store: STORE,
            subscription: null,
            access: { canSell: true, publicVisible: true },
          })
        : Promise.reject(new NotFoundException('Loja não encontrada.')),
    ),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PromotionsController, StorePromotionsController],
      providers: [
        { provide: PromotionsService, useValue: service },
        { provide: TenantService, useValue: tenants },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('rotas antigas continuam globais (sem loja), com a mesma resposta', async () => {
    for (const path of ['/promotions/banner', '/promotions/football']) {
      await request(server).get(path).expect(200, banner);
    }
    expect(service.getBanner).toHaveBeenCalledTimes(2);
    expect(tenants.publicContext).not.toHaveBeenCalled();
    expect(
      Reflect.getMetadata(
        GUARDS_METADATA,
        handlerOf(PromotionsController, 'getBanner'),
      ),
    ).toBeUndefined();
  });

  it('/stores/:storeSlug/promotions/banner usa a loja do slug (id e fuso)', async () => {
    expect(
      Reflect.getMetadata(
        GUARDS_METADATA,
        handlerOf(StorePromotionsController, 'getBanner'),
      ),
    ).toEqual([PublicStoreGuard]);

    await request(server)
      .get('/stores/loja-norte/promotions/banner')
      .expect(200, banner);
    expect(tenants.publicContext).toHaveBeenCalledWith('loja-norte');
    expect(service.getStoreBanner).toHaveBeenCalledWith({
      id: 4,
      time_zone: 'America/Manaus',
    });

    const missing = await request(server)
      .get('/stores/nao-existe/promotions/banner')
      .expect(404);
    expect((missing.body as { message: string }).message).toBe(
      'Loja não encontrada.',
    );
    expect(service.getStoreBanner).toHaveBeenCalledTimes(1);
  });
});
