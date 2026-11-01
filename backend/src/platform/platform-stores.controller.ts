import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth/auth-user';
import { ParseIdPipe } from '../common/pipes/parse-id.pipe';
import { CreateInvitationDto } from '../invitations/dto/create-invitation.dto';
import { ListInvitationsQueryDto } from '../invitations/dto/list-invitations.dto';
import { PlatformRoute } from '../tenancy/decorators';
import { StoreAuditQueryDto } from './dto/platform-audit.dto';
import {
  CreatePlatformStoreDto,
  PlatformStoreListQueryDto,
  PlatformStoreTeamQueryDto,
  StoreMetricsQueryDto,
  StoreStatusNoteDto,
  StoreStatusReasonDto,
  UpdatePlatformStoreDto,
} from './dto/platform-stores.dto';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformStoresService } from './platform-stores.service';

/**
 * Superpainel › Estabelecimentos (somente SUPER_ADMIN fora de sessão de suporte; alterações auditadas).
 * A loja-alvo vem do :id da rota. Assinatura da loja: POST /platform/stores/:id/subscription e
 * /platform/subscriptions/* (PlatformBillingController).
 */
@ApiTags('Superpainel — estabelecimentos')
@Controller('platform')
@PlatformRoute()
export class PlatformStoresController {
  constructor(
    private readonly stores: PlatformStoresService,
    private readonly auditLogs: PlatformAuditService,
  ) {}

  /** ?search=&account_status=&plan_id=&subscription_status=&sort=&order=&page=&pageSize= */
  @Get('stores')
  list(@Query() query: PlatformStoreListQueryDto) {
    return this.stores.list(query);
  }

  /** { store, subscription, invitation: { ..., url }, warnings } — o link do convite aparece só aqui. */
  @Post('stores')
  create(
    @Body() dto: CreatePlatformStoreDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.stores.create(dto, req.user, req);
  }

  @Get('stores/:id')
  detail(@Param('id', ParseIdPipe) id: number) {
    return this.stores.detail(id);
  }

  /** Detalhe atualizado + warnings (ex.: slug alterado, domínio próprio ainda não roteado). */
  @Patch('stores/:id')
  update(
    @Param('id', ParseIdPipe) id: number,
    @Body() dto: UpdatePlatformStoreDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.stores.update(id, dto, req.user, req);
  }

  /** ACTIVE → SUSPENDED (sem novos pedidos nem alterações; dados preservados). */
  @Post('stores/:id/suspend')
  @HttpCode(HttpStatus.OK)
  suspend(
    @Param('id', ParseIdPipe) id: number,
    @Body() dto: StoreStatusReasonDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.stores.changeStatus(id, 'suspend', dto.reason, req.user, req);
  }

  /** SUSPENDED → ACTIVE */
  @Post('stores/:id/reactivate')
  @HttpCode(HttpStatus.OK)
  reactivate(
    @Param('id', ParseIdPipe) id: number,
    @Body() dto: StoreStatusNoteDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.stores.changeStatus(
      id,
      'reactivate',
      dto.reason,
      req.user,
      req,
    );
  }

  /** ACTIVE | SUSPENDED → INACTIVE (some da vitrine e do painel; nada é apagado). */
  @Post('stores/:id/deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Param('id', ParseIdPipe) id: number,
    @Body() dto: StoreStatusReasonDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.stores.changeStatus(
      id,
      'deactivate',
      dto.reason,
      req.user,
      req,
    );
  }

  /** INACTIVE → ACTIVE */
  @Post('stores/:id/restore')
  @HttpCode(HttpStatus.OK)
  restore(
    @Param('id', ParseIdPipe) id: number,
    @Body() dto: StoreStatusNoteDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.stores.changeStatus(id, 'restore', dto.reason, req.user, req);
  }

  /** Equipe da loja, inclusive a lixeira, com último acesso e bloqueio. Auditada (platform.store.team.view). */
  @Get('stores/:id/users')
  team(
    @Param('id', ParseIdPipe) id: number,
    @Query() query: PlatformStoreTeamQueryDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.stores.team(id, query, req.user, req);
  }

  /** Vendas por dia (calendário da loja), por situação e por forma de pagamento. */
  @Get('stores/:id/metrics')
  metrics(
    @Param('id', ParseIdPipe) id: number,
    @Query() query: StoreMetricsQueryDto,
  ) {
    return this.stores.metrics(id, query);
  }

  /** Auditoria da loja (paginada). */
  @Get('stores/:id/audit')
  async audit(
    @Param('id', ParseIdPipe) id: number,
    @Query() query: StoreAuditQueryDto,
  ) {
    await this.stores.assertExists(id);
    return this.auditLogs.list(query, { storeId: id });
  }

  @Get('stores/:id/invitations')
  listInvitations(
    @Param('id', ParseIdPipe) id: number,
    @Query() query: ListInvitationsQueryDto,
  ) {
    return this.stores.listInvitations(id, query);
  }

  /** { invitation, url, warnings }: o link de uso único aparece só nesta resposta. */
  @Post('stores/:id/invitations')
  createInvitation(
    @Param('id', ParseIdPipe) id: number,
    @Body() dto: CreateInvitationDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.stores.createInvitation(id, dto, req.user, req);
  }

  /** Cancela um convite pendente de qualquer loja (aceito → 409). */
  @Delete('invitations/:id')
  revokeInvitation(
    @Param('id', ParseIdPipe) id: number,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.stores.revokeInvitation(id, req.user, req);
  }
}
