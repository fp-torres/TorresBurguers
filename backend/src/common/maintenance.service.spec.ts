import { Logger } from '@nestjs/common';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FindOperator, Repository } from 'typeorm';
import type { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth-user';
import { FakeDb } from '../billing/testing/fake-db.helper-spec';
import type { Addon } from '../products/entities/addon.entity';
import type { Product } from '../products/entities/product.entity';
import { PlatformRole, User, UserRole } from '../users/entities/user.entity';
import {
  MaintenanceJob,
  MaintenanceJobKind,
  MaintenanceJobStatus,
} from './entities/maintenance-job.entity';
import {
  JOB_INTERRUPTED_MESSAGE,
  JOB_SHUTDOWN_MESSAGE,
  MAINTENANCE_BATCH_SIZE,
  MAINTENANCE_HEARTBEAT_INTERVAL_MS,
  MAINTENANCE_JOB_STALE_MS,
  MaintenanceJobConflictError,
  MaintenanceService,
  OPTIMIZATION_RUNNING_MESSAGE,
  OPTIMIZE_IMAGES_AUDIT_ACTION,
  OPTIMIZE_IMAGES_FINISHED_AUDIT_ACTION,
} from './maintenance.service';

// PNG 1x1 válido
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const { RUNNING, SUCCEEDED, FAILED } = MaintenanceJobStatus;
const MINUTE = 60_000;

const SUPER_ADMIN: AuthUser = {
  id: 1,
  email: 'root@comestra.com',
  name: 'Plataforma',
  role: UserRole.CLIENT,
  storeId: null,
  platformRole: PlatformRole.SUPER_ADMIN,
};

type ImageRow = { id: number } & Record<string, unknown>;
type FindArgs = {
  where: { id: FindOperator<number> } & Record<string, unknown>;
  take: number;
  withDeleted: boolean;
};

/** Repositório falso que pagina por id como o banco (id > afterId, ordem crescente, take). */
function fakeRepository(rows: ImageRow[]) {
  return {
    find: jest.fn((args: FindArgs) => {
      const afterId = args.where.id.value;
      return Promise.resolve(
        rows
          .filter((row) => row.id > afterId)
          .sort((a, b) => a.id - b.id)
          .slice(0, args.take),
      );
    }),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
  };
}

/** Banco em memória das execuções: índice único parcial (kind) WHERE status = 'RUNNING', como a migration. */
function createJobsDb(): FakeDb {
  const db = new FakeDb([
    { entity: User, name: 'users' },
    {
      entity: MaintenanceJob,
      name: 'maintenance_jobs',
      relations: {
        started_by: { table: 'users', column: 'started_by_user_id' },
      },
      createdColumns: [],
      updatedColumn: null,
      unique: [
        {
          columns: ['kind'],
          where: (row) => row.status === MaintenanceJobStatus.RUNNING,
        },
      ],
    },
  ]);
  db.seed('users', {
    id: SUPER_ADMIN.id,
    name: SUPER_ADMIN.name,
    email: SUPER_ADMIN.email,
  });
  return db;
}

function jobRows(db: FakeDb): MaintenanceJob[] {
  return db.rows('maintenance_jobs') as unknown as MaintenanceJob[];
}

/** Execução já gravada (ex.: de outra instância). */
function seedJob(db: FakeDb, row: Partial<MaintenanceJob>): MaintenanceJob {
  const now = Date.now();
  return db.seed('maintenance_jobs', {
    kind: MaintenanceJobKind.OPTIMIZE_IMAGES,
    status: RUNNING,
    started_by_user_id: SUPER_ADMIN.id,
    started_at: new Date(now - MINUTE),
    heartbeat_at: new Date(now),
    finished_at: null,
    summary: null,
    error: null,
    ...row,
  }) as unknown as MaintenanceJob;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Relógio das execuções (MaintenanceService.now). */
function mockClock(next: () => Date) {
  return jest
    .spyOn(
      MaintenanceService.prototype as unknown as { now: () => Date },
      'now',
    )
    .mockImplementation(next);
}

function build(
  options: {
    products?: ImageRow[];
    addons?: ImageRow[];
    users?: ImageRow[];
    db?: FakeDb;
  } = {},
) {
  const db = options.db ?? createJobsDb();
  const jobs = db.repository<MaintenanceJob>(MaintenanceJob);
  const repos = {
    products: fakeRepository(options.products ?? []),
    addons: fakeRepository(options.addons ?? []),
    users: fakeRepository(options.users ?? []),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new MaintenanceService(
    repos.products as unknown as Repository<Product>,
    repos.addons as unknown as Repository<Addon>,
    repos.users as unknown as Repository<User>,
    jobs as unknown as Repository<MaintenanceJob>,
    audit as unknown as AuditService,
  );
  return { service, repos, db, jobs, audit };
}

/** Atualizações das execuções que só renovam o heartbeat (sem mudar a situação). */
function heartbeats(update: jest.SpyInstance) {
  return (update.mock.calls as [unknown, Record<string, unknown>][])
    .map(([, changes]) => changes)
    .filter((changes) => 'heartbeat_at' in changes && !('status' in changes));
}

const missingFiles = (total: number): ImageRow[] =>
  Array.from({ length: total }, (_, index) => ({
    id: index + 1,
    store_id: 5,
    name: `P${index + 1}`,
    image: `faltando-${index + 1}.jpg`,
  }));

describe('MaintenanceService', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'maintenance-spec-'));
    process.env.UPLOADS_DIR = dir;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.UPLOADS_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  describe('optimizeEverything (a rotina)', () => {
    it('converte imagens antigas: prefixo da loja mantido, imagem sem dono ganha o da loja do item', async () => {
      writeFileSync(join(dir, 'legado.png'), PNG);
      writeFileSync(join(dir, 's7-antigo.png'), PNG);
      writeFileSync(join(dir, 'adicional.png'), PNG);
      writeFileSync(join(dir, 'avatar.png'), PNG);
      const { service, repos } = build({
        products: [
          { id: 1, store_id: 5, name: 'A', image: 'legado.png' },
          { id: 2, store_id: 7, name: 'B', image: 's7-antigo.png' },
          { id: 3, store_id: 5, name: 'C', image: 'faltando.jpg' },
          { id: 4, store_id: 5, name: 'D', image: '../fora.png' },
        ],
        addons: [{ id: 9, store_id: 5, image: 'adicional.png' }],
        users: [{ id: 20, avatar: '/uploads/avatar.png' }],
      });

      const result = await service.optimizeEverything();

      expect(result).toMatchObject({
        message: 'Otimização concluída!',
        itemsProcessed: 4,
        products: 2,
        addons: 1,
        avatars: 1,
        skipped: 2, // arquivo ausente e caminho fora da pasta
      });

      const [first, second] = repos.products.update.mock.calls as unknown as [
        [object, { image: string }],
        [object, { image: string }],
      ];
      // Grava só se a imagem ainda for a lida (id + imagem antiga)
      expect(first[0]).toEqual({ id: 1, image: 'legado.png' });
      expect(first[1].image).toMatch(/^s5-legado-\d+\.webp$/);
      expect(second[0]).toEqual({ id: 2, image: 's7-antigo.png' });
      expect(second[1].image).toMatch(/^s7-antigo-\d+\.webp$/); // sem prefixo dobrado

      expect(repos.addons.update).toHaveBeenCalledWith(
        { id: 9, image: 'adicional.png' },
        { image: expect.stringMatching(/^s5-adicional-\d+\.webp$/) as unknown },
      );
      // Avatar é da conta (global): sem prefixo de loja, no formato /uploads/<arquivo>
      expect(repos.users.update).toHaveBeenCalledWith(
        { id: 20, avatar: '/uploads/avatar.png' },
        {
          avatar: expect.stringMatching(
            /^\/uploads\/avatar-\d+\.webp$/,
          ) as unknown,
        },
      );

      for (const [, changes] of [first, second]) {
        expect(existsSync(join(dir, changes.image))).toBe(true);
      }
      // Os originais continuam no disco
      expect(existsSync(join(dir, 'legado.png'))).toBe(true);
    });

    it('percorre as tabelas em lotes por id (inclusive lixeira), sem carregar tudo de uma vez', async () => {
      const { service, repos } = build({
        products: missingFiles(MAINTENANCE_BATCH_SIZE + 20),
      });

      const result = await service.optimizeEverything();

      expect(result.skipped).toBe(MAINTENANCE_BATCH_SIZE + 20);
      const calls = repos.products.find.mock.calls as unknown as [FindArgs][];
      expect(calls).toHaveLength(2);
      expect(calls.map(([args]) => args.where.id.value)).toEqual([
        0,
        MAINTENANCE_BATCH_SIZE,
      ]);
      for (const [args] of calls) {
        expect(args.take).toBe(MAINTENANCE_BATCH_SIZE);
        expect(args.withDeleted).toBe(true);
        // O banco já filtra as candidatas (não nulas, não .webp, não URL)
        expect(args.where.image).toBeInstanceOf(FindOperator);
      }
    });

    it('imagem trocada no meio da conversão: não sobrescreve e apaga o .webp que sobrou', async () => {
      writeFileSync(join(dir, 'legado.png'), PNG);
      const { service, repos } = build({
        products: [{ id: 1, store_id: 5, name: 'A', image: 'legado.png' }],
      });
      repos.products.update.mockResolvedValueOnce({ affected: 0 });

      const result = await service.optimizeEverything();

      expect(result.itemsProcessed).toBe(0);
      expect(readdirSync(dir).filter((file) => file.endsWith('.webp'))).toEqual(
        [],
      );
    });
  });

  describe('execução em segundo plano', () => {
    it('devolve a execução RUNNING na hora, termina SUCCEEDED com as contagens e audita início e fim', async () => {
      writeFileSync(join(dir, 'legado.png'), PNG);
      const { service, db, audit } = build({
        products: [
          { id: 1, store_id: 5, name: 'A', image: 'legado.png' },
          { id: 2, store_id: 5, name: 'B', image: 'faltando.jpg' },
        ],
      });

      const started = await service.startImageOptimization(
        SUPER_ADMIN,
        null,
        'platform',
      );

      expect(started.job).toMatchObject({
        kind: MaintenanceJobKind.OPTIMIZE_IMAGES,
        status: RUNNING,
        finished_at: null,
        error: null,
        started_by: { id: SUPER_ADMIN.id, name: SUPER_ADMIN.name },
        summary: {
          items_processed: 0,
          products: 0,
          addons: 0,
          avatars: 0,
          skipped: 0,
        },
      });
      const jobId = started.job.id;
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: OPTIMIZE_IMAGES_AUDIT_ACTION,
          scope: 'PLATFORM',
          actor: SUPER_ADMIN,
          targetType: 'maintenance_job',
          targetId: jobId,
          metadata: { job_id: jobId, route: 'platform' },
        }),
      );

      const outcome = await started.done;

      const summary = {
        items_processed: 1,
        products: 1,
        addons: 0,
        avatars: 0,
        skipped: 1,
      };
      expect(outcome).toEqual({ status: SUCCEEDED, summary, error: null });
      const [row] = jobRows(db);
      expect(row).toMatchObject({
        id: jobId,
        status: SUCCEEDED,
        started_by_user_id: SUPER_ADMIN.id,
        summary,
        error: null,
      });
      expect(row.finished_at).not.toBeNull();
      expect(audit.record).toHaveBeenCalledTimes(2);
      expect(audit.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: OPTIMIZE_IMAGES_FINISHED_AUDIT_ACTION,
          scope: 'PLATFORM',
          actor: SUPER_ADMIN,
          targetId: jobId,
          result: 'SUCCESS',
          metadata: {
            ...summary,
            duration_ms: expect.any(Number) as unknown,
            job_id: jobId,
          },
        }),
      );

      // GET: a última execução, com resumo, duração e quem iniciou
      await expect(service.latestImageOptimization()).resolves.toMatchObject({
        id: jobId,
        status: SUCCEEDED,
        summary,
        duration_ms: expect.any(Number) as unknown,
        started_by: { id: SUPER_ADMIN.id, name: SUPER_ADMIN.name },
      });
    });

    it('trava no banco: com uma execução RUNNING, outra tentativa (nesta ou em OUTRA instância) recebe o conflito com ela', async () => {
      const gate = deferred<ImageRow[]>();
      const { service, db, repos } = build();
      repos.products.find.mockImplementationOnce(() => gate.promise);

      // Inicia sem esperar a rotina (ela está parada no primeiro lote)
      const first = await service.startImageOptimization(SUPER_ADMIN);
      expect(jobRows(db)).toEqual([
        expect.objectContaining({ id: first.job.id, status: RUNNING }),
      ]);

      await expect(
        service.startImageOptimization(SUPER_ADMIN),
      ).rejects.toMatchObject({
        message: OPTIMIZATION_RUNNING_MESSAGE,
        job: expect.objectContaining({
          id: first.job.id,
          status: RUNNING,
        }) as unknown,
      });

      // Outra instância da API: memória própria, mesmo banco
      const other = build({ db });
      const error = (await other.service
        .startImageOptimization(SUPER_ADMIN, null, 'legacy')
        .catch((reason: unknown) => reason)) as MaintenanceJobConflictError;
      expect(error).toBeInstanceOf(MaintenanceJobConflictError);
      expect(error.job).toMatchObject({
        id: first.job.id,
        status: RUNNING,
        started_by: { id: SUPER_ADMIN.id, name: SUPER_ADMIN.name },
      });
      expect(other.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: OPTIMIZE_IMAGES_AUDIT_ACTION,
          result: 'FAILURE',
          targetId: first.job.id,
          metadata: {
            reason: OPTIMIZATION_RUNNING_MESSAGE,
            running_job_id: first.job.id,
            route: 'legacy',
          },
        }),
      );
      expect(jobRows(db)).toHaveLength(1);

      // Terminada a primeira, pode rodar de novo
      gate.resolve([]);
      await expect(first.done).resolves.toMatchObject({ status: SUCCEEDED });
      const again = await other.service.startImageOptimization(SUPER_ADMIN);
      expect(again.job.id).not.toBe(first.job.id);
      await again.done;
      expect(jobRows(db).map((row) => row.status)).toEqual([
        SUCCEEDED,
        SUCCEEDED,
      ]);
    });

    it('execução presa (heartbeat parado há mais de 10 min) vira FAILED "interrompida" ao iniciar outra, auditada pelo sistema', async () => {
      const { service, db, audit } = build();
      const now = Date.now();
      const stale = seedJob(db, {
        started_at: new Date(now - 30 * MINUTE),
        heartbeat_at: new Date(now - MAINTENANCE_JOB_STALE_MS - MINUTE),
        summary: {
          items_processed: 7,
          products: 7,
          addons: 0,
          avatars: 0,
          skipped: 2,
        },
      });

      const started = await service.startImageOptimization(SUPER_ADMIN);

      expect(started.job.id).not.toBe(stale.id);
      const old = jobRows(db).find((row) => row.id === stale.id);
      expect(old).toMatchObject({
        status: FAILED,
        error: JOB_INTERRUPTED_MESSAGE,
        summary: { items_processed: 7, skipped: 2 },
      });
      expect(old?.finished_at).not.toBeNull();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'SYSTEM',
          action: OPTIMIZE_IMAGES_FINISHED_AUDIT_ACTION,
          result: 'FAILURE',
          targetId: stale.id,
          metadata: expect.objectContaining({
            reason: JOB_INTERRUPTED_MESSAGE,
            job_id: stale.id,
            items_processed: 7,
            started_by_user_id: SUPER_ADMIN.id,
          }) as unknown,
        }),
      );
      await expect(started.done).resolves.toMatchObject({
        status: SUCCEEDED,
      });
    });

    it('heartbeat recente (menos de 10 min) ainda trava: conflito, nada é expirado', async () => {
      const { service, db } = build();
      const running = seedJob(db, {
        heartbeat_at: new Date(Date.now() - MAINTENANCE_JOB_STALE_MS + MINUTE),
      });

      await expect(
        service.startImageOptimization(SUPER_ADMIN),
      ).rejects.toBeInstanceOf(MaintenanceJobConflictError);
      expect(jobRows(db)).toEqual([
        expect.objectContaining({ id: running.id, status: RUNNING }),
      ]);
    });

    it('GET: null sem execuções; a consulta também expira a execução presa e devolve a última com a duração', async () => {
      const { service, db } = build();
      await expect(service.latestImageOptimization()).resolves.toBeNull();

      const now = Date.now();
      const stale = seedJob(db, {
        started_at: new Date(now - 20 * MINUTE),
        heartbeat_at: new Date(now - 15 * MINUTE),
      });
      const latest = await service.latestImageOptimization();
      expect(latest).toMatchObject({
        id: stale.id,
        status: FAILED,
        error: JOB_INTERRUPTED_MESSAGE,
        started_by: { id: SUPER_ADMIN.id, name: SUPER_ADMIN.name },
      });
      expect(latest?.duration_ms).toBeGreaterThanOrEqual(20 * MINUTE);

      // Em andamento: duração até agora
      const running = seedJob(db, { started_at: new Date(now - 2 * MINUTE) });
      const current = await service.latestImageOptimization();
      expect(current).toMatchObject({ id: running.id, status: RUNNING });
      expect(current?.duration_ms).toBeGreaterThanOrEqual(2 * MINUTE);
    });

    it('heartbeat a cada lote, com as contagens parciais (relógio parado: nenhum extra dentro do lote)', async () => {
      const at = new Date('2026-10-18T12:00:00.000Z');
      mockClock(() => new Date(at));
      const { service, db, jobs } = build({
        products: missingFiles(2 * MAINTENANCE_BATCH_SIZE + 50),
      });
      const update = jest.spyOn(jobs, 'update');

      const started = await service.startImageOptimization(SUPER_ADMIN);
      await started.done;

      // 3 lotes (100, 100, 50) → 3 heartbeats, cada um com o que já tinha sido feito
      expect(
        heartbeats(update).map(
          (changes) => (changes.summary as { skipped: number }).skipped,
        ),
      ).toEqual([0, MAINTENANCE_BATCH_SIZE, 2 * MAINTENANCE_BATCH_SIZE]);
      expect(jobRows(db)[0]).toMatchObject({
        status: SUCCEEDED,
        summary: { skipped: 2 * MAINTENANCE_BATCH_SIZE + 50 },
      });
    });

    it(`dentro do lote o heartbeat é renovado no máximo a cada ${MAINTENANCE_HEARTBEAT_INTERVAL_MS / 1000} s`, async () => {
      let clock = new Date('2026-10-18T12:00:00.000Z').getTime();
      // Cada leitura do relógio avança um pouco mais que o intervalo
      mockClock(
        () => new Date((clock += MAINTENANCE_HEARTBEAT_INTERVAL_MS + 1000)),
      );
      const { service, db, jobs } = build({ products: missingFiles(30) });
      const update = jest.spyOn(jobs, 'update');

      const started = await service.startImageOptimization(SUPER_ADMIN);
      await started.done;

      // 1 do lote + 1 por imagem (cada uma chega depois do intervalo)
      const beats = heartbeats(update);
      expect(beats).toHaveLength(1 + 30);
      const times = beats.map((changes) =>
        (changes.heartbeat_at as Date).getTime(),
      );
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(jobRows(db)[0].heartbeat_at.getTime()).toBeGreaterThan(
        times[times.length - 1],
      );
    });

    it('outra instância marcou a execução como interrompida: esta para no próximo heartbeat e não sobrescreve', async () => {
      const { service, db, jobs, repos, audit } = build({
        products: missingFiles(MAINTENANCE_BATCH_SIZE + 50),
      });
      const load = repos.products.find.getMockImplementation()!;
      repos.products.find.mockImplementation(async (args: FindArgs) => {
        if (args.where.id.value > 0) {
          // Ao ler o 2º lote, o heartbeat "venceu" e outra instância expirou a execução
          await jobs.update(
            { status: RUNNING },
            { status: FAILED, error: JOB_INTERRUPTED_MESSAGE },
          );
        }
        return load(args);
      });

      const started = await service.startImageOptimization(SUPER_ADMIN);
      const outcome = await started.done;

      expect(outcome).toMatchObject({
        status: FAILED,
        error: JOB_INTERRUPTED_MESSAGE,
        summary: { skipped: MAINTENANCE_BATCH_SIZE }, // o 2º lote não foi processado
      });
      expect(jobRows(db)).toEqual([
        expect.objectContaining({
          status: FAILED,
          error: JOB_INTERRUPTED_MESSAGE,
        }),
      ]);
      // Quem expirou é quem registra o fim
      expect(audit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({
          action: OPTIMIZE_IMAGES_FINISHED_AUDIT_ACTION,
        }),
      );
    });

    it('falha inesperada: FAILED com motivo curto (sem caminho nem mensagem interna), contagens parciais e auditoria FAILURE', async () => {
      const { service, db, repos, audit } = build({
        products: missingFiles(3),
      });
      repos.addons.find.mockRejectedValueOnce(
        Object.assign(
          new Error(
            "EACCES: permission denied, open 'C:\\segredo\\uploads\\x.png'",
          ),
          { code: 'EACCES' },
        ),
      );

      const started = await service.startImageOptimization(SUPER_ADMIN);
      const outcome = await started.done;

      const reason =
        'Falha inesperada na otimização (código EACCES). Os detalhes estão no log da API.';
      expect(outcome).toEqual({
        status: FAILED,
        error: reason,
        summary: {
          items_processed: 0,
          products: 0,
          addons: 0,
          avatars: 0,
          skipped: 3,
        },
      });
      const [row] = jobRows(db);
      expect(row).toMatchObject({
        status: FAILED,
        error: reason,
        summary: { skipped: 3 },
      });
      expect(row.error).not.toMatch(/segredo|permission|uploads/);
      expect(row.finished_at).not.toBeNull();
      expect(audit.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: OPTIMIZE_IMAGES_FINISHED_AUDIT_ACTION,
          result: 'FAILURE',
          metadata: expect.objectContaining({
            reason,
            skipped: 3,
          }) as unknown,
        }),
      );
      // A trava foi liberada
      const again = await service.startImageOptimization(SUPER_ADMIN);
      await expect(again.done).resolves.toMatchObject({ status: SUCCEEDED });
    });

    it('erro ao gravar a execução (banco fora do ar) → a rota recebe o erro e a tentativa fica na auditoria', async () => {
      const { service, jobs, audit } = build();
      jest
        .spyOn(jobs, 'save')
        .mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:5432'));

      await expect(service.startImageOptimization(SUPER_ADMIN)).rejects.toThrow(
        'ECONNREFUSED',
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: OPTIMIZE_IMAGES_AUDIT_ACTION,
          result: 'FAILURE',
          metadata: {
            reason: 'Erro inesperado (detalhes no log da API).',
            route: 'platform',
          },
        }),
      );
    });

    it('desligamento ordenado da API: a execução para e fica FAILED (API encerrada)', async () => {
      const gate = deferred<ImageRow[]>();
      const { service, db, repos } = build();
      repos.products.find.mockImplementationOnce(() => gate.promise);
      await expect(
        service.beforeApplicationShutdown(),
      ).resolves.toBeUndefined(); // nada rodando

      const started = await service.startImageOptimization(SUPER_ADMIN);
      const shutdown = service.beforeApplicationShutdown();
      gate.resolve(missingFiles(1));
      await shutdown;

      await expect(started.done).resolves.toMatchObject({
        status: FAILED,
        error: JOB_SHUTDOWN_MESSAGE,
      });
      expect(jobRows(db)).toEqual([
        expect.objectContaining({
          status: FAILED,
          error: JOB_SHUTDOWN_MESSAGE,
        }),
      ]);
    });
  });
});
