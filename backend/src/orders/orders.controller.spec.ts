import { BadRequestException } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AuthGuard } from '@nestjs/passport';
import type { AuthUser } from '../auth/auth-user';
import { ROLES_KEY } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import {
  PublicStoreGuard,
  REQUIRE_SELLABLE_STORE_KEY,
  STORE_CAPABILITY_KEY,
  StoreStaffGuard,
} from '../tenancy/guards';
import type { TenantContext } from '../tenancy/tenant-context';
import { UserRole } from '../users/entities/user.entity';
import { ClientOnlyGuard } from './client-only.guard';
import { OrdersController } from './orders.controller';
import type { OrdersService } from './orders.service';

type Handler = keyof OrdersController;

const handler = (name: Handler) =>
  (OrdersController.prototype as unknown as Record<Handler, object>)[name];
const meta = <T>(key: string, name: Handler): T | undefined =>
  Reflect.getMetadata(key, handler(name)) as T | undefined;
const guardsOf = (name: Handler) =>
  meta<unknown[]>(GUARDS_METADATA, name) ?? [];
const pathOf = (name: Handler) => meta<string>(PATH_METADATA, name);

const STAFF_HANDLERS: Handler[] = [
  'getDrivers',
  'getCharts',
  'getSummary',
  'getReports',
  'findAll',
  'getNearbyOrders',
  'assignDriver',
  'updateStatus',
];

describe('OrdersController (rotas e guards)', () => {
  it('atende as rotas antigas (/orders) e as da loja (/stores/:storeSlug/orders), sempre com JWT', () => {
    expect(Reflect.getMetadata(PATH_METADATA, OrdersController)).toEqual([
      'orders',
      'stores/:storeSlug/orders',
    ]);
    expect(Reflect.getMetadata(GUARDS_METADATA, OrdersController)).toEqual([
      AuthGuard('jwt'),
    ]);
  });

  it.each(['quote', 'create'] as Handler[])(
    '%s: só clientes (checado ANTES de resolver a loja) e só em loja que vende',
    (name) => {
      // Guards de método rodam na ordem do array: ClientOnlyGuard primeiro (equipe → 403 claro)
      expect(guardsOf(name)).toEqual([ClientOnlyGuard, PublicStoreGuard]);
      expect(meta(REQUIRE_SELLABLE_STORE_KEY, name)).toBe(true);
      expect(guardsOf(name)).not.toContain(StoreStaffGuard);
    },
  );

  it('rotas da equipe: loja do usuário (StoreStaffGuard) antes dos perfis; mutações exigem "operate", leituras "read"', () => {
    for (const name of STAFF_HANDLERS) {
      expect(guardsOf(name)).toEqual([StoreStaffGuard, RolesGuard]);
    }
    expect(meta(STORE_CAPABILITY_KEY, 'assignDriver')).toBe('operate');
    expect(meta(STORE_CAPABILITY_KEY, 'updateStatus')).toBe('operate');
    for (const name of [
      'getDrivers',
      'getCharts',
      'getSummary',
      'getReports',
      'findAll',
      'getNearbyOrders',
    ] as Handler[]) {
      expect(meta(STORE_CAPABILITY_KEY, name)).toBe('read');
    }
  });

  it('perfis: dashboard e relatórios só ADMIN; logística ADMIN/EMPLOYEE; quadros toda a equipe', () => {
    for (const name of ['getCharts', 'getSummary', 'getReports'] as Handler[])
      expect(meta(ROLES_KEY, name)).toEqual(['ADMIN']);
    for (const name of [
      'getDrivers',
      'getNearbyOrders',
      'assignDriver',
    ] as Handler[])
      expect(meta(ROLES_KEY, name)).toEqual(['ADMIN', 'EMPLOYEE']);
    for (const name of ['findAll', 'updateStatus'] as Handler[])
      expect(meta(ROLES_KEY, name)).toEqual([
        'ADMIN',
        'EMPLOYEE',
        'KITCHEN',
        'COURIER',
      ]);
  });

  it('detalhe, cancelamento e Meus Pedidos atendem cliente e equipe: a loja é resolvida no serviço', () => {
    for (const name of ['findOne', 'cancel', 'findMyOrders'] as Handler[]) {
      expect(guardsOf(name)).toEqual([]);
    }
  });

  it('rotas literais vêm antes de ":id" (my-orders, drivers/list, charts, summary, reports)', () => {
    const order = Object.getOwnPropertyNames(OrdersController.prototype);
    const byId = order.indexOf('findOne');
    expect(pathOf('findOne')).toBe(':id');
    for (const name of [
      'findMyOrders',
      'getDrivers',
      'getCharts',
      'getSummary',
      'getReports',
    ] as Handler[]) {
      expect(order.indexOf(name)).toBeLessThan(byId);
    }
    expect(pathOf('getReports')).toBe('reports');
  });

  describe('repasse para o serviço', () => {
    const tenant = { storeId: 4, store: { slug: 'loja-4' } } as TenantContext;
    const admin = {
      id: 1,
      role: UserRole.ADMIN,
      storeId: 4,
    } as AuthUser;

    function setup() {
      const service = {
        findAll: jest.fn().mockResolvedValue([]),
        getReport: jest.fn().mockResolvedValue({}),
        getChartData: jest.fn().mockResolvedValue({}),
        cancel: jest.fn().mockResolvedValue({}),
        findOneFor: jest.fn().mockResolvedValue({}),
        findMyOrders: jest.fn().mockResolvedValue([]),
        updateStatus: jest.fn().mockResolvedValue({}),
      };
      const controller = new OrdersController(
        service as unknown as OrdersService,
      );
      return { controller, service };
    }

    it('a loja da equipe vem do contexto do guard (nunca do corpo/URL)', async () => {
      const { controller, service } = setup();
      const staffReq = { user: admin } as never;
      await controller.findAll(tenant, staffReq, 'active');
      expect(service.findAll).toHaveBeenCalledWith(4, admin, {
        scope: 'active',
        page: { skip: 0, take: 100 },
      });
      await controller.getReports(tenant, '2026-10-01', '2026-10-31');
      expect(service.getReport).toHaveBeenCalledWith(4, {
        from: '2026-10-01',
        to: '2026-10-31',
      });
      await controller.getCharts(tenant);
      expect(service.getChartData).toHaveBeenCalledWith(4);
      const req = { user: admin } as never;
      await controller.updateStatus(
        10,
        { status: 'PREPARING' } as never,
        req,
        tenant,
      );
      expect(service.updateStatus).toHaveBeenCalledWith(
        10,
        'PREPARING',
        admin,
        4,
        req,
      );
    });

    it('scope inválido → 400', () => {
      const { controller } = setup();
      expect(() =>
        controller.findAll(tenant, { user: admin } as never, 'todos'),
      ).toThrow(BadRequestException);
    });

    it('listas em páginas: ?page=&pageSize= (até 100; inválido → 400), sempre no formato de lista', async () => {
      const { controller, service } = setup();
      const req = { user: admin } as never;
      await controller.findAll(tenant, req, undefined, '3', '20');
      expect(service.findAll).toHaveBeenLastCalledWith(4, admin, {
        scope: 'all',
        page: { skip: 40, take: 20 },
      });
      await controller.findMyOrders(req, undefined, '2', undefined);
      expect(service.findMyOrders).toHaveBeenLastCalledWith(1, undefined, {
        skip: 100,
        take: 100,
      });
      for (const [page, size] of [
        ['0', undefined],
        [undefined, '101'],
        ['abc', undefined],
        [undefined, '0'],
        ['1.5', undefined],
        [['1', '2'], undefined],
        ['10001', undefined],
      ] as Array<[unknown, unknown]>) {
        expect(() =>
          controller.findAll(tenant, req, undefined, page, size),
        ).toThrow('Paginação inválida');
        expect(() =>
          controller.findMyOrders(req, undefined, page, size),
        ).toThrow('Paginação inválida');
      }
    });

    it('cliente/equipe: o :storeSlug da URL só restringe (o serviço confere a loja)', async () => {
      const { controller, service } = setup();
      const req = { user: admin } as never;
      await controller.cancel(10, req, 'loja-4');
      expect(service.cancel).toHaveBeenCalledWith(10, admin, {
        storeSlug: 'loja-4',
        request: req,
      });
      await controller.findOne(10, req, undefined);
      expect(service.findOneFor).toHaveBeenCalledWith(10, admin, undefined);
      await controller.findMyOrders(req, 'loja-4');
      expect(service.findMyOrders).toHaveBeenCalledWith(1, 'loja-4', {
        skip: 0,
        take: 100,
      });
    });
  });
});
