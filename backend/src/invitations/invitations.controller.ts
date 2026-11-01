import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthenticatedRequest } from '../auth/auth-user';
import { PlanLimitsService } from '../billing/plan-limits.service';
import { ParseIdPipe } from '../common/pipes/parse-id.pipe';
import {
  RateLimitService,
  teamWriteKey,
} from '../common/rate-limit/rate-limit.service';
import { CurrentTenant, StaffRoute } from '../tenancy/decorators';
import type { TenantContext } from '../tenancy/tenant-context';
import { UserRole } from '../users/entities/user.entity';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { CreateStoreInvitationDto } from './dto/create-invitation.dto';
import { ListInvitationsQueryDto } from './dto/list-invitations.dto';
import { InvitationsService } from './invitations.service';

/** Aceite público do convite (link recebido por e-mail ou repassado pelo superpainel). */
@ApiTags('Convites')
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  /** { store: { name, slug, logo }, email_masked, role, expires_at } ou 404. */
  @Get(':token')
  inspect(@Param('token') token: string, @Req() req: Request) {
    return this.invitations.inspect(token, req);
  }

  /** Cria a conta da equipe e já faz o login: { access_token, user }. */
  @Post(':token/accept')
  accept(
    @Param('token') token: string,
    @Body() dto: AcceptInvitationDto,
    @Req() req: Request,
  ) {
    return this.invitations.accept(token, dto, req);
  }
}

/** Convites da equipe da PRÓPRIA loja (ADMIN). A loja vem do usuário autenticado. */
@ApiTags('Equipe da loja')
@Controller('store/invitations')
export class StoreInvitationsController {
  constructor(
    private readonly invitations: InvitationsService,
    private readonly planLimits: PlanLimitsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** Convites da loja; o id de quem convidou só aparece quando é da equipe da própria loja. */
  @Get()
  @StaffRoute(UserRole.ADMIN)
  list(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: ListInvitationsQueryDto,
  ) {
    return this.invitations.listByStore(tenant.storeId, query, {
      hidePlatformInviters: true,
    });
  }

  /** { invitation, url }: o link aparece só nesta resposta (também vai por e-mail). */
  @Post()
  @StaffRoute(UserRole.ADMIN)
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: CreateStoreInvitationDto,
    @Req() req: AuthenticatedRequest,
  ) {
    // Limite por loja (TEAM_WRITE): convites e contas da equipe; também freia a sondagem de e-mails
    this.rateLimit.consume('TEAM_WRITE', teamWriteKey(tenant.storeId));
    // Aviso antecipado: sem vaga no plano, o convite não poderia ser aceito
    await this.planLimits.assertWithinLimit(tenant.storeId, 'staff_users');
    const { invitation, url, message } = await this.invitations.create({
      storeId: tenant.storeId,
      email: dto.email,
      role: dto.role,
      makeOwner: false,
      invitedBy: req.user,
      request: req,
    });
    // Contrato da loja: { invitation, url } (o campo delivered é da fase 1b do plano). Aditivo: message
    // só quando o e-mail NÃO foi enviado (teto de convites do destinatário somando as lojas)
    return message ? { invitation, url, message } : { invitation, url };
  }

  @Delete(':id')
  @StaffRoute(UserRole.ADMIN)
  revoke(
    @Param('id', ParseIdPipe) id: number,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.invitations.revoke(id, tenant.storeId, req.user, req);
  }
}
