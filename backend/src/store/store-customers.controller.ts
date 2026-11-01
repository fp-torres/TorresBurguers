import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth/auth-user';
import { ParseIdPipe } from '../common/pipes/parse-id.pipe';
import { CurrentTenant, StaffRoute } from '../tenancy/decorators';
import type { TenantContext } from '../tenancy/tenant-context';
import { UserRole } from '../users/entities/user.entity';
import {
  BlockCustomerDto,
  StoreCustomersQueryDto,
} from './dto/store-customers.dto';
import { StoreCustomersService } from './store-customers.service';

/**
 * Clientes que compraram na loja da equipe: leitura para ADMIN e atendente; bloquear e desbloquear um
 * cliente nesta loja só para o ADMIN (capacidade de gestão da loja; auditado).
 */
@ApiTags('store')
@Controller('store/customers')
export class StoreCustomersController {
  constructor(private readonly customers: StoreCustomersService) {}

  /** ?search= (nome, e-mail ou telefone) &blocked= &page=&pageSize= → { items, total, page, pageSize }. */
  @Get()
  @StaffRoute(UserRole.ADMIN, UserRole.EMPLOYEE)
  list(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: StoreCustomersQueryDto,
  ) {
    return this.customers.list(tenant.storeId, query);
  }

  /** Cliente, estatísticas, bloqueio e pedidos DESTA loja (404 se ele nunca comprou aqui). */
  @Get(':userId')
  @StaffRoute(UserRole.ADMIN, UserRole.EMPLOYEE)
  detail(
    @CurrentTenant() tenant: TenantContext,
    @Param('userId', ParseIdPipe) userId: number,
  ) {
    return this.customers.detail(tenant.storeId, userId);
  }

  /**
   * { reason } → 201 { reason, blocked_at, blocked_by }. O cliente deixa de orçar, pedir e pagar NESTA
   * loja (403 genérico); 404 se nunca comprou aqui; 409 se já está bloqueado.
   */
  @Post(':userId/block')
  @StaffRoute(UserRole.ADMIN)
  block(
    @CurrentTenant() tenant: TenantContext,
    @Param('userId', ParseIdPipe) userId: number,
    @Body() dto: BlockCustomerDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.customers.block(tenant.storeId, userId, dto.reason, {
      user: req.user,
      request: req,
    });
  }

  /** Desbloqueia (204); 404 se o cliente não está bloqueado nesta loja. */
  @Delete(':userId/block')
  @StaffRoute(UserRole.ADMIN)
  @HttpCode(204)
  async unblock(
    @CurrentTenant() tenant: TenantContext,
    @Param('userId', ParseIdPipe) userId: number,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    await this.customers.unblock(tenant.storeId, userId, {
      user: req.user,
      request: req,
    });
  }
}
