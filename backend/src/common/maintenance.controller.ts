import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth/auth-user';
import { PlatformRoute } from '../tenancy';
import { CredentialsKeyError } from './crypto/secret-box';
import {
  type ImageOptimizationCounts,
  MaintenanceJobStatus,
} from './entities/maintenance-job.entity';
import {
  CLEANUP_CONFIRM_MESSAGE,
  StartUploadsCleanupDto,
} from './maintenance.dto';
import {
  CREDENTIALS_KEY_UNAVAILABLE_MESSAGE,
  MaintenanceJobConflictError,
  MaintenanceService,
  OPTIMIZATION_DONE_MESSAGE,
  type MaintenanceJobView,
  type StartedJob,
  type StoreCredentialsReencryption,
  type StoreCredentialsStatus,
  type UploadsCleanupScheduleView,
} from './maintenance.service';

/** Mensagem da rota antiga quando a execução termina em FAILED (a causa curta vem da execução). */
export const LEGACY_OPTIMIZATION_FAILED_MESSAGE =
  'A otimização de imagens falhou.';

/** ?include=a,b (ou repetido): o item pedido está na lista? Outros valores são ignorados. */
function includes(value: unknown, item: string): boolean {
  const values = Array.isArray(value) ? value : [value];
  return values.some(
    (entry) =>
      typeof entry === 'string' &&
      entry.split(',').some((part) => part.trim().toLowerCase() === item),
  );
}

/** 409 do superpainel: { statusCode, message, error, job } com a execução em andamento. */
function conflictWithJob(error: unknown): unknown {
  if (!(error instanceof MaintenanceJobConflictError)) return error;
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    message: error.message,
    error: 'Conflict',
    job: error.job,
  });
}

/**
 * Manutenção da plataforma no superpainel (somente SUPER_ADMIN, fora de sessão de suporte): a pasta de
 * uploads e as credenciais guardam dados de TODAS as lojas, então nenhuma equipe de loja dispara rotinas
 * sobre elas.
 * - Otimização de imagens e limpeza de arquivos sem uso rodam em SEGUNDO PLANO: o POST devolve a execução
 *   na hora (202) e o superpainel acompanha pelo GET. Uma execução por vez de cada tipo entre todas as
 *   instâncias da API (trava no banco). Auditadas no início e no fim (platform.maintenance.optimize_images,
 *   platform.maintenance.cleanup_uploads e o .finish de cada uma).
 * - A regravação das credenciais Mercado Pago no formato atual é imediata e idempotente
 *   (platform.maintenance.reencrypt_credentials, só contagens).
 */
@ApiTags('Superpainel — manutenção')
@Controller('platform/maintenance')
@PlatformRoute()
export class PlatformMaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  /** Converte para WebP as imagens antigas de produtos, adicionais e avatares, em segundo plano. */
  @Post('optimize-images')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({
    description:
      '{ job }: execução iniciada (status RUNNING). Acompanhe por GET /platform/maintenance/optimize-images.',
  })
  @ApiConflictResponse({
    description:
      '{ statusCode, message, error, job }: já existe uma execução em andamento (job = ela).',
  })
  async startImageOptimization(
    @Req() req: AuthenticatedRequest,
  ): Promise<{ job: MaintenanceJobView }> {
    try {
      const { job } = await this.maintenance.startImageOptimization(
        req.user,
        req,
        'platform',
      );
      return { job };
    } catch (error) {
      throw conflictWithJob(error);
    }
  }

  /** A última execução (em andamento ou terminada), com o resumo e a duração; null se nunca rodou. */
  @Get('optimize-images')
  @ApiOkResponse({
    description:
      '{ job | null }: status RUNNING/SUCCEEDED/FAILED, started_at, heartbeat_at, finished_at, duration_ms, summary { items_processed, products, addons, avatars, skipped }, error, started_by.',
  })
  async latestImageOptimization(): Promise<{ job: MaintenanceJobView | null }> {
    return { job: await this.maintenance.latestImageOptimization() };
  }

  /**
   * Limpeza das imagens de /uploads que nenhum cadastro usa (produtos e adicionais, inclusive na lixeira,
   * fotos de perfil e logos) e com mais de 24 h, em segundo plano. check só conta (quantidade e tamanho);
   * delete apaga e exige confirm: true. Verificação e exclusão dividem a trava (uma por vez).
   */
  @Post('cleanup-uploads')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({
    description:
      '{ job }: execução iniciada (status RUNNING, kind cleanup_uploads). Acompanhe por GET /platform/maintenance/cleanup-uploads.',
  })
  @ApiBadRequestResponse({
    description: 'mode ausente ou inválido; delete sem confirm: true.',
  })
  @ApiConflictResponse({
    description:
      '{ statusCode, message, error, job }: já existe uma limpeza em andamento (job = ela).',
  })
  async startUploadsCleanup(
    @Body() dto: StartUploadsCleanupDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ job: MaintenanceJobView }> {
    // Além do DTO: nada é apagado sem a confirmação explícita (e nenhum modo desconhecido roda)
    const mode = dto?.mode;
    if (mode !== 'check' && !(mode === 'delete' && dto.confirm === true)) {
      throw new BadRequestException(CLEANUP_CONFIRM_MESSAGE);
    }
    try {
      const { job } = await this.maintenance.startUploadsCleanup(
        req.user,
        mode,
        req,
      );
      return { job };
    } catch (error) {
      throw conflictWithJob(error);
    }
  }

  /**
   * A última limpeza (verificação ou exclusão, manual ou agendada), com as contagens e a duração; null se
   * nunca rodou. Com ?include=schedule, também a situação da limpeza agendada (UPLOADS_CLEANUP_INTERVAL_HOURS).
   */
  @Get('cleanup-uploads')
  @ApiQuery({
    name: 'include',
    required: false,
    enum: ['schedule'],
    description:
      'schedule = inclui { schedule: { enabled, interval_hours, mode, min_age_hours, next_run_at, last_run } } (a limpeza agendada).',
  })
  @ApiOkResponse({
    description:
      '{ job | null } (+ schedule com ?include=schedule): status RUNNING/SUCCEEDED/FAILED, duração e summary { mode, trigger (manual | schedule), min_age_hours, files_scanned, in_use, recent, orphans, orphan_bytes, deleted, deleted_bytes, failed, skipped } (só contagens). Agendada: started_by null.',
  })
  async latestUploadsCleanup(@Query('include') include?: unknown): Promise<{
    job: MaintenanceJobView | null;
    schedule?: UploadsCleanupScheduleView;
  }> {
    const job = await this.maintenance.latestUploadsCleanup();
    // O formato padrão continua { job }: o agendamento só vem quando pedido
    if (!includes(include, 'schedule')) return { job };
    return { job, schedule: await this.maintenance.uploadsCleanupSchedule() };
  }

  /** Quantas lojas têm credenciais Mercado Pago em cada formato (nada é decifrado nem exibido). */
  @Get('store-credentials')
  @ApiOkResponse({
    description:
      '{ total, current, legacy, unknown }: lojas com Access Token gravado no formato atual (v2, preso à loja), no antigo (v1) e em formato desconhecido.',
  })
  storeCredentialsStatus(): Promise<StoreCredentialsStatus> {
    return this.maintenance.storeCredentialsStatus();
  }

  /** Regrava no formato atual (v2, preso à loja) os Access Tokens antigos (v1). Idempotente. */
  @Post('store-credentials/reencrypt')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    description:
      '{ total, migrated, already_current, changed, failed, failed_store_ids }: só contagens e ids de loja; o token nunca sai.',
  })
  @ApiServiceUnavailableResponse({
    description:
      'CREDENTIALS_ENCRYPTION_KEY ausente (produção): nada foi regravado.',
  })
  async reencryptStoreCredentials(
    @Req() req: AuthenticatedRequest,
  ): Promise<StoreCredentialsReencryption> {
    try {
      return await this.maintenance.reencryptStoreCredentials(req.user, req);
    } catch (error) {
      if (error instanceof CredentialsKeyError) {
        throw new ServiceUnavailableException(
          CREDENTIALS_KEY_UNAVAILABLE_MESSAGE,
        );
      }
      throw error;
    }
  }
}

/**
 * Rota antiga (/maintenance, mesmas regras de acesso: somente SUPER_ADMIN), mantida para chamadas antigas.
 * Contrato antigo: espera a execução terminar e responde { message, itemsProcessed }; 409 se já houver
 * uma em andamento. Usa a mesma execução em segundo plano e a mesma trava no banco do superpainel (se a
 * conexão cair antes do fim, a execução continua e o resultado aparece no superpainel).
 */
@ApiTags('maintenance')
@Controller('maintenance')
export class LegacyMaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  @Post('optimize-images')
  @PlatformRoute()
  @ApiCreatedResponse({
    description:
      '{ message, itemsProcessed } ao final (rota antiga; prefira POST /platform/maintenance/optimize-images).',
  })
  async runOptimization(@Req() req: AuthenticatedRequest) {
    let started: StartedJob<ImageOptimizationCounts>;
    try {
      started = await this.maintenance.startImageOptimization(
        req.user,
        req,
        'legacy',
      );
    } catch (error) {
      if (error instanceof MaintenanceJobConflictError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }

    const outcome = await started.done;
    if (outcome.status !== MaintenanceJobStatus.SUCCEEDED) {
      throw new InternalServerErrorException(
        outcome.error
          ? `${LEGACY_OPTIMIZATION_FAILED_MESSAGE} ${outcome.error}`
          : LEGACY_OPTIMIZATION_FAILED_MESSAGE,
      );
    }
    // Contrato da rota: { message, itemsProcessed } (o detalhamento fica na execução e na auditoria)
    return {
      message: OPTIMIZATION_DONE_MESSAGE,
      itemsProcessed: outcome.summary.items_processed,
    };
  }
}
