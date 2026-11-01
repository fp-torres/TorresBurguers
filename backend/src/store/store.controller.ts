import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  Put,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth/auth-user';
import { ImageFileInterceptor } from '../common/uploads/image-upload';
import {
  CurrentTenant,
  PublicStore,
  PublicStoreRoute,
  RequireStoreCapability,
  StaffRoute,
} from '../tenancy/decorators';
import type { TenantContext } from '../tenancy/tenant-context';
import { UserRole } from '../users/entities/user.entity';
import {
  DeliverySimulationDto,
  GeocodeStoreDto,
} from './dto/delivery-tools.dto';
import { StorePaymentCredentialsDto } from './dto/store-payment-credentials.dto';
import { StoreDeliveryToolsService } from './store-delivery-tools.service';
import { UpdateStoreSettingsDto } from './dto/update-store-settings.dto';
import { UpdateStoreStatusDto } from './dto/update-store-status.dto';
import { presentStoreStatus } from './store-presenter';
import { StoreSettingsService } from './store-settings.service';
import { StoreService, type StoreActor } from './store.service';

const actorOf = (req: AuthenticatedRequest): StoreActor => ({
  user: req.user,
  request: req,
});

/**
 * Loja do painel da equipe (/store): status, configurações, logo e credenciais de pagamento.
 * A loja é SEMPRE a do usuário autenticado (StoreStaffGuard → @CurrentTenant()); nenhuma rota aceita
 * loja vinda do corpo, da query ou de cabeçalhos.
 */
@ApiTags('store')
@Controller('store')
export class StoreController {
  constructor(
    private readonly storeService: StoreService,
    private readonly settings: StoreSettingsService,
    private readonly deliveryTools: StoreDeliveryToolsService,
  ) {}

  // --- Status (contrato do app mobile) ---

  /**
   * Rota antiga, pública: a equipe autenticada vê a própria loja; clientes e visitantes, a loja padrão.
   * Exatamente { id, is_open, opening_message, closing_message }.
   */
  @Get('status')
  @PublicStoreRoute()
  getStatus(@PublicStore() store: TenantContext) {
    return presentStoreStatus(store.store);
  }

  /** Abre/fecha a própria loja e edita as mensagens (ADMIN ou atendente). Loja suspensa → 403. */
  @Patch('status')
  @StaffRoute(UserRole.ADMIN, UserRole.EMPLOYEE)
  @RequireStoreCapability('manage')
  updateStatus(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: UpdateStoreStatusDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.storeService.updateStatus(tenant.storeId, dto, actorOf(req));
  }

  // --- Configurações (ADMIN) ---

  @Get('settings')
  @StaffRoute(UserRole.ADMIN)
  getSettings(@CurrentTenant() tenant: TenantContext) {
    return this.settings.getSettings(tenant);
  }

  @Patch('settings')
  @StaffRoute(UserRole.ADMIN)
  updateSettings(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: UpdateStoreSettingsDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.settings.updateSettings(tenant, dto, actorOf(req));
  }

  // --- Entrega por distância (ADMIN): localizar a loja e testar um endereço (nada é gravado) ---

  /** Ponto do endereço informado (ou do salvo) no mapa: 404 não encontrado, 502 serviço fora do ar. */
  @Post('settings/geocode')
  @HttpCode(200)
  @StaffRoute(UserRole.ADMIN)
  geocodeStore(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: GeocodeStoreDto,
  ) {
    return this.deliveryTools.geocodeStore(tenant, dto);
  }

  /** Distância, faixa (ou zona), taxa e prazo de um endereço com a configuração em edição. */
  @Post('settings/delivery-simulation')
  @HttpCode(200)
  @StaffRoute(UserRole.ADMIN)
  simulateDelivery(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: DeliverySimulationDto,
  ) {
    return this.deliveryTools.simulate(tenant, dto);
  }

  /** Credenciais do Mercado Pago da loja: o Access Token é só de escrita (a resposta traz uma dica). */
  @Put('settings/payments')
  @StaffRoute(UserRole.ADMIN)
  setPaymentCredentials(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: StorePaymentCredentialsDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.settings.setPaymentCredentials(tenant, dto, actorOf(req));
  }

  @Delete('settings/payments')
  @StaffRoute(UserRole.ADMIN)
  removePaymentCredentials(
    @CurrentTenant() tenant: TenantContext,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.settings.removePaymentCredentials(tenant, actorOf(req));
  }

  // --- Logo (recurso custom_branding do plano) ---

  /** JPG, PNG ou WebP até 5 MB, convertido para WebP (s<loja>-...webp em /uploads). */
  @Post('logo')
  @StaffRoute(UserRole.ADMIN)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(ImageFileInterceptor('file'))
  uploadLogo(
    @CurrentTenant() tenant: TenantContext,
    @Req() req: AuthenticatedRequest,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.settings.uploadLogo(tenant, file, actorOf(req));
  }

  @Delete('logo')
  @StaffRoute(UserRole.ADMIN)
  removeLogo(
    @CurrentTenant() tenant: TenantContext,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.settings.removeLogo(tenant, actorOf(req));
  }
}
