import {
  CanActivate,
  ExecutionContext,
  Global,
  INestApplication,
  Logger,
  Module,
  Type,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthGuard } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth-user';
import { Addon } from '../products/entities/addon.entity';
import { Product } from '../products/entities/product.entity';
import { PlatformAdminGuard } from '../tenancy';
import { PlatformRole, User, UserRole } from '../users/entities/user.entity';
import { CommonModule } from './common.module';
import {
  MaintenanceJob,
  MaintenanceJobKind,
  MaintenanceJobStatus,
} from './entities/maintenance-job.entity';
import { CredentialsKeyError } from './crypto/secret-box';
import {
  LEGACY_OPTIMIZATION_FAILED_MESSAGE,
  LegacyMaintenanceController,
  PlatformMaintenanceController,
} from './maintenance.controller';
import {
  CLEANUP_CONFIRM_MESSAGE,
  CLEANUP_CONFIRM_TYPE_MESSAGE,
  CLEANUP_MODE_MESSAGE,
} from './maintenance.dto';
import {
  CLEANUP_RUNNING_MESSAGE,
  CREDENTIALS_KEY_UNAVAILABLE_MESSAGE,
  MaintenanceJobConflictError,
  MaintenanceService,
  OPTIMIZATION_RUNNING_MESSAGE,
  type JobOutcome,
  type MaintenanceJobView,
} from './maintenance.service';

/** Método do controller (onde os decorators gravam os metadados). */
const handlerOf = (controller: Type, method: string): object =>
  (controller.prototype as Record<string, object>)[method];

const SUPER_ADMIN: AuthUser = {
  id: 1,
  email: 'root@comestra.com',
  name: 'Plataforma',
  role: UserRole.CLIENT,
  storeId: null,
  platformRole: PlatformRole.SUPER_ADMIN,
};
const STORE_ADMIN: AuthUser = {
  id: 2,
  email: 'admin@loja.com',
  name: 'Admin',
  role: UserRole.ADMIN,
  storeId: 7,
  platformRole: null,
};
const CLIENT: AuthUser = {
  id: 3,
  email: 'cliente@email.com',
  name: 'Cliente',
  role: UserRole.CLIENT,
  storeId: null,
  platformRole: null,
};
// Superadmin em sessão de suporte age como ADMIN da loja: nada de superpainel
const SUPPORT_SESSION: AuthUser = {
  ...STORE_ADMIN,
  id: 1,
  supportSession: { id: 3, storeId: 7, expiresAt: new Date() },
};

const as = (user: AuthUser) => ({ 'x-test-user': JSON.stringify(user) });
const fakeJwt: CanActivate = {
  canActivate: (context: ExecutionContext) => {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: unknown }>();
    const raw = req.headers['x-test-user'];
    if (!raw) throw new UnauthorizedException();
    req.user = JSON.parse(raw) as AuthUser;
    return true;
  },
};

const RUNNING_JOB: MaintenanceJobView = {
  id: 9,
  kind: MaintenanceJobKind.OPTIMIZE_IMAGES,
  status: MaintenanceJobStatus.RUNNING,
  started_at: new Date('2026-10-18T12:00:00.000Z'),
  heartbeat_at: new Date('2026-10-18T12:00:05.000Z'),
  finished_at: null,
  duration_ms: 5000,
  summary: {
    items_processed: 2,
    products: 2,
    addons: 0,
    avatars: 0,
    skipped: 1,
  },
  error: null,
  started_by: { id: 1, name: 'Plataforma' },
};
/** Como o JSON chega ao cliente (datas em ISO). */
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const PLATFORM_PATH = '/platform/maintenance/optimize-images';
const LEGACY_PATH = '/maintenance/optimize-images';

describe('Manutenção — rotas (somente superadmin)', () => {
  let app: INestApplication<App>;
  let server: App;
  const maintenance = {
    startImageOptimization: jest.fn(),
    latestImageOptimization: jest.fn(),
    startUploadsCleanup: jest.fn(),
    latestUploadsCleanup: jest.fn(),
    uploadsCleanupSchedule: jest.fn(),
    storeCredentialsStatus: jest.fn(),
    reencryptStoreCredentials: jest.fn(),
  };

  const started = (outcome: JobOutcome) => ({
    job: RUNNING_JOB,
    done: Promise.resolve(outcome),
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PlatformMaintenanceController, LegacyMaintenanceController],
      providers: [{ provide: MaintenanceService, useValue: maintenance }],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useValue(fakeJwt)
      .compile();
    app = moduleRef.createNestApplication();
    // Mesma validação da aplicação (config/app-setup.ts)
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

  afterAll(() => app.close());
  beforeEach(() => {
    jest.clearAllMocks();
    maintenance.startImageOptimization.mockResolvedValue(
      started({
        status: MaintenanceJobStatus.SUCCEEDED,
        summary: { ...RUNNING_JOB.summary!, items_processed: 3 },
        error: null,
      }),
    );
    maintenance.latestImageOptimization.mockResolvedValue(RUNNING_JOB);
  });

  it('usam os guards do superpainel (rota nova e rota antiga)', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, PlatformMaintenanceController),
    ).toContain(PlatformAdminGuard);
    expect(
      Reflect.getMetadata(
        GUARDS_METADATA,
        handlerOf(LegacyMaintenanceController, 'runOptimization'),
      ),
    ).toContain(PlatformAdminGuard);
  });

  it('anônimo 401; equipe da loja, cliente e sessão de suporte 403 — nas duas rotas, nada roda', async () => {
    await request(server).post(LEGACY_PATH).expect(401);
    await request(server).post(PLATFORM_PATH).expect(401);
    await request(server).get(PLATFORM_PATH).expect(401);
    for (const user of [STORE_ADMIN, CLIENT, SUPPORT_SESSION]) {
      await request(server).post(LEGACY_PATH).set(as(user)).expect(403);
      await request(server).post(PLATFORM_PATH).set(as(user)).expect(403);
      await request(server).get(PLATFORM_PATH).set(as(user)).expect(403);
    }
    expect(maintenance.startImageOptimization).not.toHaveBeenCalled();
    expect(maintenance.latestImageOptimization).not.toHaveBeenCalled();
  });

  it('POST /platform/...: 202 com a execução iniciada (não espera terminar)', async () => {
    let finish!: (outcome: JobOutcome) => void;
    maintenance.startImageOptimization.mockResolvedValueOnce({
      job: RUNNING_JOB,
      done: new Promise<JobOutcome>((resolve) => {
        finish = resolve;
      }),
    });

    const res = await request(server)
      .post(PLATFORM_PATH)
      .set(as(SUPER_ADMIN))
      .expect(202);

    expect(res.body).toEqual({ job: asJson(RUNNING_JOB) });
    expect(maintenance.startImageOptimization).toHaveBeenCalledWith(
      expect.objectContaining({ id: SUPER_ADMIN.id }),
      expect.anything(),
      'platform',
    );
    finish({
      status: MaintenanceJobStatus.SUCCEEDED,
      summary: RUNNING_JOB.summary!,
      error: null,
    });
  });

  it('POST /platform/...: 409 traz a execução em andamento', async () => {
    maintenance.startImageOptimization.mockRejectedValueOnce(
      new MaintenanceJobConflictError(RUNNING_JOB),
    );

    const res = await request(server)
      .post(PLATFORM_PATH)
      .set(as(SUPER_ADMIN))
      .expect(409);

    expect(res.body).toEqual({
      statusCode: 409,
      message: OPTIMIZATION_RUNNING_MESSAGE,
      error: 'Conflict',
      job: asJson(RUNNING_JOB),
    });
  });

  it('GET /platform/...: { job } com a última execução, ou { job: null }', async () => {
    const res = await request(server)
      .get(PLATFORM_PATH)
      .set(as(SUPER_ADMIN))
      .expect(200);
    expect(res.body).toEqual({ job: asJson(RUNNING_JOB) });

    maintenance.latestImageOptimization.mockResolvedValueOnce(null);
    const empty = await request(server)
      .get(PLATFORM_PATH)
      .set(as(SUPER_ADMIN))
      .expect(200);
    expect(empty.body).toEqual({ job: null });
  });

  it('rota antiga: espera o fim e mantém o contrato { message, itemsProcessed }', async () => {
    const res = await request(server)
      .post(LEGACY_PATH)
      .set(as(SUPER_ADMIN))
      .expect(201);

    expect(res.body).toEqual({
      message: 'Otimização concluída!',
      itemsProcessed: 3,
    });
    expect(maintenance.startImageOptimization).toHaveBeenCalledWith(
      expect.objectContaining({ id: SUPER_ADMIN.id }),
      expect.anything(),
      'legacy',
    );
  });

  it('rota antiga: 409 no formato antigo (sem a execução) e 500 com o motivo curto se a execução falhar', async () => {
    maintenance.startImageOptimization.mockRejectedValueOnce(
      new MaintenanceJobConflictError(RUNNING_JOB),
    );
    const conflict = await request(server)
      .post(LEGACY_PATH)
      .set(as(SUPER_ADMIN))
      .expect(409);
    expect(conflict.body).toEqual({
      statusCode: 409,
      message: OPTIMIZATION_RUNNING_MESSAGE,
      error: 'Conflict',
    });

    const reason =
      'Falha inesperada na otimização (código EACCES). Os detalhes estão no log da API.';
    maintenance.startImageOptimization.mockResolvedValueOnce(
      started({
        status: MaintenanceJobStatus.FAILED,
        summary: RUNNING_JOB.summary!,
        error: reason,
      }),
    );
    const failed = await request(server)
      .post(LEGACY_PATH)
      .set(as(SUPER_ADMIN))
      .expect(500);
    expect(failed.body).toMatchObject({
      statusCode: 500,
      message: `${LEGACY_OPTIMIZATION_FAILED_MESSAGE} ${reason}`,
    });
  });

  describe('limpeza de arquivos sem uso e credenciais', () => {
    const CLEANUP_PATH = '/platform/maintenance/cleanup-uploads';
    const STATUS_PATH = '/platform/maintenance/store-credentials';
    const REENCRYPT_PATH = '/platform/maintenance/store-credentials/reencrypt';
    const CLEANUP_JOB: MaintenanceJobView = {
      ...RUNNING_JOB,
      id: 12,
      kind: MaintenanceJobKind.CLEANUP_UPLOADS,
      summary: {
        mode: 'check',
        min_age_hours: 24,
        files_scanned: 4,
        in_use: 2,
        recent: 1,
        orphans: 1,
        orphan_bytes: 2048,
        deleted: 0,
        deleted_bytes: 0,
        failed: 0,
        skipped: 0,
      },
    };
    const REENCRYPTION = {
      total: 3,
      migrated: 1,
      already_current: 1,
      changed: 0,
      failed: 1,
      failed_store_ids: [9],
    };

    beforeEach(() => {
      maintenance.startUploadsCleanup.mockResolvedValue({
        job: CLEANUP_JOB,
        done: new Promise(() => undefined),
      });
      maintenance.latestUploadsCleanup.mockResolvedValue(CLEANUP_JOB);
      maintenance.storeCredentialsStatus.mockResolvedValue({
        total: 3,
        current: 1,
        legacy: 1,
        unknown: 1,
      });
      maintenance.reencryptStoreCredentials.mockResolvedValue(REENCRYPTION);
    });

    it('anônimo 401; equipe da loja, cliente e sessão de suporte 403 — nada roda', async () => {
      const calls: Array<[string, 'get' | 'post', object?]> = [
        [CLEANUP_PATH, 'post', { mode: 'check' }],
        [CLEANUP_PATH, 'get'],
        [STATUS_PATH, 'get'],
        [REENCRYPT_PATH, 'post'],
      ];
      for (const [path, method, body] of calls) {
        await request(server)[method](path).send(body).expect(401);
        for (const user of [STORE_ADMIN, CLIENT, SUPPORT_SESSION]) {
          await request(server)
            [method](path)
            .set(as(user))
            .send(body)
            .expect(403);
        }
      }
      expect(maintenance.startUploadsCleanup).not.toHaveBeenCalled();
      expect(maintenance.latestUploadsCleanup).not.toHaveBeenCalled();
      expect(maintenance.storeCredentialsStatus).not.toHaveBeenCalled();
      expect(maintenance.reencryptStoreCredentials).not.toHaveBeenCalled();
    });

    it('POST cleanup-uploads: 202 com a execução; verificar não pede confirmação, apagar pede confirm: true', async () => {
      const check = await request(server)
        .post(CLEANUP_PATH)
        .set(as(SUPER_ADMIN))
        .send({ mode: 'check' })
        .expect(202);
      expect(check.body).toEqual({ job: asJson(CLEANUP_JOB) });
      expect(maintenance.startUploadsCleanup).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: SUPER_ADMIN.id }),
        'check',
        expect.anything(),
      );

      await request(server)
        .post(CLEANUP_PATH)
        .set(as(SUPER_ADMIN))
        .send({ mode: 'delete', confirm: true })
        .expect(202);
      expect(maintenance.startUploadsCleanup).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: SUPER_ADMIN.id }),
        'delete',
        expect.anything(),
      );
    });

    it('POST cleanup-uploads: 400 sem modo, modo inválido, apagar sem confirmar ou campo extra — nada roda', async () => {
      const cases: Array<[object | undefined, string]> = [
        [undefined, CLEANUP_MODE_MESSAGE],
        [{}, CLEANUP_MODE_MESSAGE],
        [{ mode: 'DELETE', confirm: true }, CLEANUP_MODE_MESSAGE],
        [{ mode: 'delete' }, CLEANUP_CONFIRM_MESSAGE],
        [{ mode: 'delete', confirm: false }, CLEANUP_CONFIRM_MESSAGE],
        [{ mode: 'delete', confirm: 'true' }, CLEANUP_CONFIRM_MESSAGE],
        [{ mode: 'check', confirm: 'sim' }, CLEANUP_CONFIRM_TYPE_MESSAGE],
        [{ mode: 'check', path: '/etc' }, 'property path should not exist'],
      ];
      for (const [body, message] of cases) {
        const res = await request(server)
          .post(CLEANUP_PATH)
          .set(as(SUPER_ADMIN))
          .send(body)
          .expect(400);
        expect(
          JSON.stringify((res.body as { message: unknown }).message),
        ).toContain(message);
      }
      expect(maintenance.startUploadsCleanup).not.toHaveBeenCalled();
    });

    it('POST cleanup-uploads: 409 traz a limpeza em andamento; GET devolve a última (ou null)', async () => {
      maintenance.startUploadsCleanup.mockRejectedValueOnce(
        new MaintenanceJobConflictError(
          { ...CLEANUP_JOB, status: MaintenanceJobStatus.RUNNING },
          CLEANUP_RUNNING_MESSAGE,
        ),
      );
      const conflict = await request(server)
        .post(CLEANUP_PATH)
        .set(as(SUPER_ADMIN))
        .send({ mode: 'delete', confirm: true })
        .expect(409);
      expect(conflict.body).toEqual({
        statusCode: 409,
        message: CLEANUP_RUNNING_MESSAGE,
        error: 'Conflict',
        job: asJson(CLEANUP_JOB),
      });

      const latest = await request(server)
        .get(CLEANUP_PATH)
        .set(as(SUPER_ADMIN))
        .expect(200);
      expect(latest.body).toEqual({ job: asJson(CLEANUP_JOB) });
      maintenance.latestUploadsCleanup.mockResolvedValueOnce(null);
      const empty = await request(server)
        .get(CLEANUP_PATH)
        .set(as(SUPER_ADMIN))
        .expect(200);
      expect(empty.body).toEqual({ job: null });
    });

    it('GET cleanup-uploads?include=schedule: { job, schedule } (limpeza agendada); sem include continua { job }', async () => {
      const schedule = {
        enabled: true,
        interval_hours: 24,
        mode: 'delete',
        min_age_hours: 24,
        next_run_at: new Date('2026-10-26T12:00:00.000Z'),
        last_run: { ...CLEANUP_JOB, started_by: null },
      };
      maintenance.uploadsCleanupSchedule.mockResolvedValue(schedule);

      for (const query of ['schedule', 'SCHEDULE', 'outra,schedule']) {
        const res = await request(server)
          .get(CLEANUP_PATH)
          .query({ include: query })
          .set(as(SUPER_ADMIN))
          .expect(200);
        expect(res.body).toEqual({
          job: asJson(CLEANUP_JOB),
          schedule: asJson(schedule),
        });
      }
      maintenance.uploadsCleanupSchedule.mockClear();
      for (const query of [{}, { include: 'outra' }]) {
        const res = await request(server)
          .get(CLEANUP_PATH)
          .query(query)
          .set(as(SUPER_ADMIN))
          .expect(200);
        expect(Object.keys(res.body as object)).toEqual(['job']);
      }
      expect(maintenance.uploadsCleanupSchedule).not.toHaveBeenCalled();
      // Mesmas regras de acesso
      await request(server)
        .get(CLEANUP_PATH)
        .query({ include: 'schedule' })
        .set(as(STORE_ADMIN))
        .expect(403);
    });

    it('credenciais: GET com as contagens; POST 200 com o resultado; sem a chave → 503', async () => {
      const status = await request(server)
        .get(STATUS_PATH)
        .set(as(SUPER_ADMIN))
        .expect(200);
      expect(status.body).toEqual({
        total: 3,
        current: 1,
        legacy: 1,
        unknown: 1,
      });

      const done = await request(server)
        .post(REENCRYPT_PATH)
        .set(as(SUPER_ADMIN))
        .expect(200);
      expect(done.body).toEqual(REENCRYPTION);
      expect(maintenance.reencryptStoreCredentials).toHaveBeenCalledWith(
        expect.objectContaining({ id: SUPER_ADMIN.id }),
        expect.anything(),
      );

      maintenance.reencryptStoreCredentials.mockRejectedValueOnce(
        new CredentialsKeyError('CREDENTIALS_ENCRYPTION_KEY não definida'),
      );
      const unavailable = await request(server)
        .post(REENCRYPT_PATH)
        .set(as(SUPER_ADMIN))
        .expect(503);
      expect(unavailable.body).toMatchObject({
        statusCode: 503,
        message: CREDENTIALS_KEY_UNAVAILABLE_MESSAGE,
      });
    });
  });
});

/** Serviços globais da aplicação substituídos por dublês. */
@Global()
@Module({
  providers: [{ provide: AuditService, useValue: {} }],
  exports: [AuditService],
})
class FakeGlobalsModule {}

describe('CommonModule (injeção de dependências)', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  it('monta o serviço e os controllers com o repositório das execuções', async () => {
    let builder = Test.createTestingModule({
      imports: [FakeGlobalsModule, CommonModule],
    });
    for (const entity of [Product, Addon, User, MaintenanceJob]) {
      builder = builder
        .overrideProvider(getRepositoryToken(entity))
        .useValue({});
    }
    const moduleRef = await builder.compile();

    expect(moduleRef.get(MaintenanceService)).toBeInstanceOf(
      MaintenanceService,
    );
    expect(moduleRef.get(PlatformMaintenanceController)).toBeInstanceOf(
      PlatformMaintenanceController,
    );
    expect(moduleRef.get(LegacyMaintenanceController)).toBeInstanceOf(
      LegacyMaintenanceController,
    );
    await moduleRef.close();
  });
});
