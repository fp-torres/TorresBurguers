import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request as ExpressRequest } from 'express';
import type { AuthUser } from '../auth/auth-user';
import {
  CurrentTenant,
  PublicStore,
  PublicStoreRoute,
  RequireStoreCapability,
  StaffOnly,
} from '../tenancy/decorators';
import type { TenantContext } from '../tenancy/tenant-context';
import { OrdersService } from './orders.service';
import { CreateOrderDto, QuoteOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order.dto';
import { AssignDriverDto } from './dto/assign-driver.dto';
import { ClientOnlyGuard } from './client-only.guard';
import { ParseIdPipe } from '../common/pipes/parse-id.pipe';
import {
  ORDERS_PAGE_INVALID_MESSAGE,
  ORDER_MANAGER_ROLES,
  STAFF_ROLES,
  parseListPage,
  parseOrdersScope,
  type ListPage,
} from './order-rules';

type AuthRequest = ExpressRequest & { user: AuthUser };

/** ?page=&pageSize= das listas (inválido → 400). */
function listPageOrFail(rawPage: unknown, rawPageSize: unknown): ListPage {
  const page = parseListPage(rawPage, rawPageSize);
  if (!page) throw new BadRequestException(ORDERS_PAGE_INVALID_MESSAGE);
  return page;
}

/**
 * Pedidos. Duas formas de rota:
 * - /stores/:storeSlug/orders/...: vitrine de uma loja (orçamento e pedido nela);
 * - /orders/...: rotas antigas (app mobile) — compras na loja padrão; a equipe sempre na própria loja.
 * A loja da equipe vem do StoreStaffGuard (users.store_id); a da compra, do PublicStoreGuard.
 * Atenção à ordem: rotas literais antes de ":id", e os guards de método rodam de baixo para cima
 * na lista de decorators (o mais próximo do método roda primeiro).
 */
@ApiTags('Pedidos')
@ApiBearerAuth()
@Controller(['orders', 'stores/:storeSlug/orders'])
@UseGuards(AuthGuard('jwt'))
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  // --- CLIENTE ---

  // Orçamento calculado no servidor (subtotal, taxa de entrega, total, tempo estimado)
  @Post('quote')
  @HttpCode(200)
  @PublicStoreRoute({ sellable: true, auth: 'none' })
  @UseGuards(ClientOnlyGuard)
  quote(
    @Body() dto: QuoteOrderDto,
    @Request() req: AuthRequest,
    @PublicStore() store: TenantContext,
  ) {
    return this.ordersService.quote(dto, req.user, store);
  }

  @Post()
  @PublicStoreRoute({ sellable: true, auth: 'none' })
  @UseGuards(ClientOnlyGuard)
  create(
    @Body() dto: CreateOrderDto,
    @Request() req: AuthRequest,
    @PublicStore() store: TenantContext,
  ) {
    return this.ordersService.create(dto, req.user, store, req);
  }

  // Pedidos do próprio usuário em todas as lojas (com a loja de cada um), uma página por vez
  @Get('my-orders')
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, example: 20 })
  findMyOrders(
    @Request() req: AuthRequest,
    @Param('storeSlug') storeSlug?: string,
    @Query('page') rawPage?: unknown,
    @Query('pageSize') rawPageSize?: unknown,
  ) {
    return this.ordersService.findMyOrders(
      req.user.id,
      storeSlug,
      listPageOrFail(rawPage, rawPageSize),
    );
  }

  // --- LOGÍSTICA (Administrador e Atendente) ---

  @Get('drivers/list')
  @StaffOnly(...ORDER_MANAGER_ROLES)
  @RequireStoreCapability('read')
  getDrivers(@CurrentTenant() tenant: TenantContext) {
    return this.ordersService.getAvailableDrivers(tenant.storeId);
  }

  // --- DASHBOARD E RELATÓRIOS (somente Administrador) ---

  // Gráficos e relatórios exigem o recurso do plano "advanced_reports" (403 sem ele)
  @Get('charts')
  @StaffOnly('ADMIN')
  @RequireStoreCapability('read')
  getCharts(@CurrentTenant() tenant: TenantContext) {
    return this.ordersService.getChartData(tenant.storeId);
  }

  @Get('summary')
  @StaffOnly('ADMIN')
  @RequireStoreCapability('read')
  getSummary(@CurrentTenant() tenant: TenantContext) {
    return this.ordersService.getDashboardSummary(tenant.storeId);
  }

  @Get('reports')
  @StaffOnly('ADMIN')
  @RequireStoreCapability('read')
  @ApiQuery({ name: 'from', required: false, example: '2026-10-01' })
  @ApiQuery({ name: 'to', required: false, example: '2026-10-31' })
  getReports(
    @CurrentTenant() tenant: TenantContext,
    @Query('from') from?: unknown,
    @Query('to') to?: unknown,
  ) {
    return this.ordersService.getReport(tenant.storeId, { from, to });
  }

  // --- PEDIDOS (equipe) ---

  // ?scope=active (quadros da equipe): em andamento, finalizados nas últimas 24 h e estornos pendentes.
  // Sem scope: o histórico em páginas (?page=&pageSize=; padrão: os 100 mais recentes). Sempre só a
  // loja da equipe; cozinha e entregador recebem só os pedidos da própria etapa (com ou sem scope).
  @Get()
  @StaffOnly(...STAFF_ROLES)
  @RequireStoreCapability('read')
  @ApiQuery({ name: 'scope', required: false, enum: ['active'] })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, example: 50 })
  findAll(
    @CurrentTenant() tenant: TenantContext,
    @Request() req: AuthRequest,
    @Query('scope') rawScope?: string,
    @Query('page') rawPage?: unknown,
    @Query('pageSize') rawPageSize?: unknown,
  ) {
    const scope = parseOrdersScope(rawScope);
    if (!scope)
      throw new BadRequestException(
        'scope inválido. Use scope=active ou omita o parâmetro.',
      );
    return this.ordersService.findAll(tenant.storeId, req.user, {
      scope,
      page: listPageOrFail(rawPage, rawPageSize),
    });
  }

  @Get(':id/nearby')
  @StaffOnly(...ORDER_MANAGER_ROLES)
  @RequireStoreCapability('read')
  getNearbyOrders(
    @Param('id', ParseIdPipe) id: number,
    @CurrentTenant() tenant: TenantContext,
  ) {
    return this.ordersService.getNearbyOrders(id, tenant.storeId);
  }

  @Patch(':id/assign')
  @StaffOnly(...ORDER_MANAGER_ROLES)
  @RequireStoreCapability('operate')
  assignDriver(
    @Param('id', ParseIdPipe) id: number,
    @Body() dto: AssignDriverDto,
    @CurrentTenant() tenant: TenantContext,
  ) {
    return this.ordersService.assignDriver(id, dto.driverId, tenant.storeId);
  }

  // Cliente dono (enquanto PENDING) ou Administrador/Atendente da loja do pedido (resolvido no serviço)
  @Patch(':id/cancel')
  cancel(
    @Param('id', ParseIdPipe) id: number,
    @Request() req: AuthRequest,
    @Param('storeSlug') storeSlug?: string,
  ) {
    return this.ordersService.cancel(id, req.user, { storeSlug, request: req });
  }

  // Dono do pedido ou equipe da loja do pedido (resolvido no serviço)
  @Get(':id')
  findOne(
    @Param('id', ParseIdPipe) id: number,
    @Request() req: AuthRequest,
    @Param('storeSlug') storeSlug?: string,
  ) {
    return this.ordersService.findOneFor(id, req.user, storeSlug);
  }

  // Somente { status }, conforme o perfil (ver checkStatusChange)
  @Patch(':id')
  @StaffOnly(...STAFF_ROLES)
  @RequireStoreCapability('operate')
  updateStatus(
    @Param('id', ParseIdPipe) id: number,
    @Body() dto: UpdateOrderStatusDto,
    @Request() req: AuthRequest,
    @CurrentTenant() tenant: TenantContext,
  ) {
    return this.ordersService.updateStatus(
      id,
      dto.status,
      req.user,
      tenant.storeId,
      req,
    );
  }
}
