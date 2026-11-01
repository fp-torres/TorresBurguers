import { Logger } from '@nestjs/common';
import * as fsModule from 'fs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FindOperator, Repository } from 'typeorm';
import type { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth-user';
import { FakeDb } from '../billing/testing/fake-db.helper-spec';
import { Addon } from '../products/entities/addon.entity';
import { Product } from '../products/entities/product.entity';
import { Store } from '../store/entities/store.entity';
import { PlatformRole, User, UserRole } from '../users/entities/user.entity';
import {
  MaintenanceJob,
  MaintenanceJobKind,
  MaintenanceJobStatus,
} from './entities/maintenance-job.entity';
import {
  CLEANUP_RUNNING_MESSAGE,
  CLEANUP_UPLOADS_AUDIT_ACTION,
  CLEANUP_UPLOADS_FINISHED_AUDIT_ACTION,
  MaintenanceJobConflictError,
  MaintenanceService,
} from './maintenance.service';
import {
  UPLOADS_CLEANUP_MIN_AGE_HOURS,
  type UploadsCleanupSummary,
  isCleanupCandidateName,
  isScheduledCleanupDue,
  readCleanupCounts,
  uploadReferenceKey,
  uploadReferenceVariants,
  uploadsCleanupScheduleConfig,
} from './maintenance.uploads-cleanup';
import { storeStorageUsage } from './uploads/storage-usage';

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-10-25T12:00:00.000Z');

const SUPER_ADMIN: AuthUser = {
  id: 1,
  email: 'root@comestra.com',
  name: 'Plataforma',
  role: UserRole.CLIENT,
  storeId: null,
  platformRole: PlatformRole.SUPER_ADMIN,
};

/** Banco em memória com as tabelas que guardam arquivos e as execuções (trava por tipo). */
function createDb(): FakeDb {
  const db = new FakeDb([
    { entity: User, name: 'users' },
    { entity: Product, name: 'products' },
    { entity: Addon, name: 'addons' },
    { entity: Store, name: 'stores' },
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
    avatar: null,
  });
  return db;
}

function build(db = createDb()) {
  const repos = {
    products: db.repository<Product>(Product),
    addons: db.repository<Addon>(Addon),
    users: db.repository<User>(User),
    jobs: db.repository<MaintenanceJob>(MaintenanceJob),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new MaintenanceService(
    repos.products as unknown as Repository<Product>,
    repos.addons as unknown as Repository<Addon>,
    repos.users as unknown as Repository<User>,
    repos.jobs as unknown as Repository<MaintenanceJob>,
    audit as unknown as AuditService,
  );
  return { service, db, repos, audit };
}

describe('Limpeza de arquivos sem uso — regras', () => {
  it('só imagens com nome da API são candidatas (ocultos, nomes estranhos e outros tipos nunca)', () => {
    for (const name of [
      's3-compressed-1760000000000-ab12cd34.webp',
      'u7-compressed-1.webp',
      'legado.PNG',
      'foto_antiga.jpeg',
      '1700000000000-123.jpg',
    ]) {
      expect(isCleanupCandidateName(name)).toBe(true);
    }
    for (const name of [
      '.gitkeep',
      '.oculto.png',
      '-traco.png',
      'nome com espaço.png',
      '../fora.png',
      'pasta/arquivo.png',
      'pasta\\arquivo.png',
      'package.json',
      '.env',
      'notas.txt',
      'arquivo.webp.exe',
      `${'a'.repeat(252)}.png`,
    ]) {
      expect(isCleanupCandidateName(name)).toBe(false);
    }
  });

  it('a chave da referência é o último trecho do caminho ou URL (sem query/âncora, minúsculas)', () => {
    expect(uploadReferenceKey('s3-a.webp')).toBe('s3-a.webp');
    expect(uploadReferenceKey('/uploads/U7-A.webp')).toBe('u7-a.webp');
    expect(uploadReferenceKey('uploads/a.png')).toBe('a.png');
    expect(
      uploadReferenceKey('http://192.168.0.10:3000/uploads/a.png?v=2#x'),
    ).toBe('a.png');
    expect(uploadReferenceKey('C:\\fotos\\b.jpg')).toBe('b.jpg');
    expect(uploadReferenceKey('  c.png  ')).toBe('c.png');
    expect(uploadReferenceKey('https://cdn.exemplo.com/')).toBeNull();
    expect(uploadReferenceKey('')).toBeNull();
    expect(uploadReferenceKey(null)).toBeNull();
    expect(uploadReferenceKey(42)).toBeNull();
    expect(uploadReferenceVariants('a.png')).toEqual([
      'a.png',
      '/uploads/a.png',
      'uploads/a.png',
    ]);
  });

  it('resumo lido do banco: só contagens conhecidas e modo válido', () => {
    expect(readCleanupCounts(null)).toBeNull();
    expect(
      readCleanupCounts({
        mode: 'apagar tudo',
        trigger: 'cron',
        orphans: -3,
        extra: 'x',
      }),
    ).toEqual({
      mode: 'check',
      // Valor desconhecido (ou ausente, nas execuções antigas) = manual
      trigger: 'manual',
      min_age_hours: UPLOADS_CLEANUP_MIN_AGE_HOURS,
      files_scanned: 0,
      in_use: 0,
      recent: 0,
      orphans: 0,
      orphan_bytes: 0,
      deleted: 0,
      deleted_bytes: 0,
      failed: 0,
      skipped: 0,
    });
  });
});

describe('MaintenanceService — limpeza de arquivos sem uso', () => {
  let root: string;
  let dir: string;
  const originalUploads = process.env.UPLOADS_DIR;

  /** Grava um arquivo na pasta de uploads com a idade (horas, pela data de modificação) informada. */
  function plant(name: string, ageHours: number, bytes = 10, base = dir) {
    const file = join(base, name);
    writeFileSync(file, Buffer.alloc(bytes, 1));
    const time = new Date(NOW.getTime() - ageHours * HOUR);
    utimesSync(file, time, time);
    return file;
  }

  const exists = (name: string) => existsSync(join(dir, name));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cleanup-spec-'));
    dir = join(root, 'uploads');
    mkdirSync(dir);
    process.env.UPLOADS_DIR = dir;
    jest
      .spyOn(
        MaintenanceService.prototype as unknown as { now: () => Date },
        'now',
      )
      .mockImplementation(() => new Date(NOW));
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalUploads === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = originalUploads;
    rmSync(root, { recursive: true, force: true });
  });

  /** Cadastros que usam arquivos (inclusive lixeira e conta apagada) e arquivos de todos os tipos. */
  function scenario(db: FakeDb) {
    db.seed('stores', { id: 1, slug: 'loja', logo: 's1-logo.webp' });
    db.seed('stores', { id: 2, slug: 'sem-logo', logo: null });
    db.seed('products', { id: 1, store_id: 1, image: 's1-produto.webp' });
    db.seed('products', {
      id: 2,
      store_id: 1,
      image: 's1-lixeira.webp',
      deleted_at: new Date(NOW.getTime() - 48 * HOUR),
    });
    db.seed('products', {
      id: 3,
      store_id: 1,
      image: 'https://cdn.exemplo.com/fotos/Externo.PNG?v=3',
    });
    db.seed('products', { id: 4, store_id: 1, image: null });
    db.seed('addons', { id: 1, store_id: 1, image: '/uploads/adicional.png' });
    db.seed('users', {
      id: 2,
      name: 'Cliente',
      avatar: '/uploads/u2-avatar.webp',
    });
    db.seed('users', {
      id: 3,
      name: 'Conta apagada',
      avatar: 'http://192.168.0.10:3000/uploads/u3-antigo.jpg',
      deleted_at: new Date(NOW.getTime() - 72 * HOUR),
    });

    // Em uso (todos antigos): nunca apagados
    plant('s1-logo.webp', 100);
    plant('s1-produto.webp', 100);
    plant('s1-lixeira.webp', 100);
    plant('externo.png', 100); // mesmo nome de uma URL externa: mantido (erra para o lado de não apagar)
    plant('adicional.png', 100);
    plant('u2-avatar.webp', 100);
    plant('u3-antigo.jpg', 100);
    // Sem uso
    plant('orfao-velho.png', 25, 1000);
    plant('S9-ORFAO.WEBP', 24 * 30, 500);
    plant('orfao-novo.webp', 23, 300); // menos de 24 h: mantido
    plant('orfao-quase.webp', 23.9, 300);
    // Nunca apagados: ocultos, nomes fora do padrão, não-imagens e pastas
    plant('.oculto.png', 100);
    plant('nome com espaço.png', 100);
    plant('notas.txt', 100);
    plant('package.json', 100);
    mkdirSync(join(dir, 'pasta.png'));
    plant('dentro.png', 100, 10, join(dir, 'pasta.png'));
  }

  it('check: só conta (quantidade e tamanho); nada é apagado', async () => {
    const { service, db } = build();
    scenario(db);

    const counts = await service.cleanUploads('check');

    expect(counts).toEqual({
      mode: 'check',
      trigger: 'manual',
      min_age_hours: 24,
      files_scanned: 11,
      in_use: 7,
      recent: 2,
      orphans: 2,
      orphan_bytes: 1500,
      deleted: 0,
      deleted_bytes: 0,
      failed: 0,
      skipped: 5,
    });
    for (const name of [
      'orfao-velho.png',
      'S9-ORFAO.WEBP',
      'orfao-novo.webp',
      's1-produto.webp',
    ]) {
      expect(exists(name)).toBe(true);
    }
  });

  it('delete: apaga só as imagens sem uso há mais de 24 h; o resto fica (inclusive fora da pasta)', async () => {
    const { service, db } = build();
    scenario(db);
    // Fora da pasta de uploads: arquivo antigo e sem uso, na pasta-mãe
    const outside = plant('fora.png', 100, 10, root);

    const counts = await service.cleanUploads('delete');

    expect(counts).toMatchObject({
      mode: 'delete',
      files_scanned: 11,
      in_use: 7,
      recent: 2,
      orphans: 2,
      orphan_bytes: 1500,
      deleted: 2,
      deleted_bytes: 1500,
      failed: 0,
      skipped: 5,
    });
    expect(exists('orfao-velho.png')).toBe(false);
    expect(exists('S9-ORFAO.WEBP')).toBe(false);
    for (const name of [
      's1-logo.webp',
      's1-produto.webp',
      's1-lixeira.webp',
      'externo.png',
      'adicional.png',
      'u2-avatar.webp',
      'u3-antigo.jpg',
      'orfao-novo.webp',
      'orfao-quase.webp',
      '.oculto.png',
      'nome com espaço.png',
      'notas.txt',
      'package.json',
      join('pasta.png', 'dentro.png'),
    ]) {
      expect(exists(name)).toBe(true);
    }
    expect(existsSync(outside)).toBe(true);

    // Idempotente: a segunda rodada não acha mais nada para apagar
    const again = await service.cleanUploads('delete');
    expect(again).toMatchObject({ orphans: 0, deleted: 0, files_scanned: 9 });
  });

  it('atalho (symlink) para fora da pasta: nunca é seguido nem apagado', async () => {
    const { service } = build();
    const target = plant('alvo-fora.png', 100, 10, root);
    try {
      symlinkSync(target, join(dir, 'atalho.png'), 'file');
    } catch {
      // Sem permissão para criar atalhos (Windows sem modo desenvolvedor): nada a conferir aqui
      return;
    }

    const counts = await service.cleanUploads('delete');

    expect(counts).toMatchObject({ files_scanned: 0, skipped: 1, deleted: 0 });
    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(dir, 'atalho.png'))).toBe(true);
  });

  it('conferência final: arquivo que passou a ser usado (ou mudou) no meio não é apagado', async () => {
    const { service, db, repos } = build();
    plant('vai-ser-usado.png', 48, 100);
    plant('vai-mudar.png', 48, 200);
    plant('sem-uso.png', 48, 300);

    // Logo antes de apagar o lote (conferência no banco), uma loja salva um produto com o arquivo
    // e outro arquivo é regravado (fica recente)
    const plain = db.repository<Product>(Product);
    jest.spyOn(repos.products, 'find').mockImplementation((options) => {
      const where = (options?.where ?? {}) as Record<string, unknown>;
      if (
        where.image instanceof FindOperator &&
        where.image.type === 'in' &&
        !db.rows('products').length
      ) {
        db.seed('products', { id: 9, store_id: 1, image: 'vai-ser-usado.png' });
        utimesSync(join(dir, 'vai-mudar.png'), NOW, NOW);
      }
      return plain.find(options);
    });

    const counts = await service.cleanUploads('delete');

    expect(counts).toMatchObject({
      files_scanned: 3,
      in_use: 1,
      recent: 1,
      orphans: 1,
      orphan_bytes: 300,
      deleted: 1,
      deleted_bytes: 300,
    });
    expect(exists('vai-ser-usado.png')).toBe(true);
    expect(exists('vai-mudar.png')).toBe(true);
    expect(exists('sem-uso.png')).toBe(false);
  });

  it('erro ao apagar: conta a falha, segue com os demais e o log não traz a mensagem do disco', async () => {
    const { service } = build();
    plant('travado.png', 48, 100);
    plant('livre.png', 48, 100);
    const unlink = fsModule.promises.unlink;
    const warn = jest.spyOn(Logger.prototype, 'warn');
    jest
      .spyOn(fsModule.promises, 'unlink')
      .mockImplementation((target) =>
        String(target).endsWith('travado.png')
          ? Promise.reject(
              Object.assign(
                new Error('EBUSY: resource busy or locked, /srv/segredo'),
                { code: 'EBUSY' },
              ),
            )
          : unlink(target),
      );

    const counts = await service.cleanUploads('delete');

    expect(counts).toMatchObject({ orphans: 2, deleted: 1, failed: 1 });
    expect(exists('travado.png')).toBe(true);
    expect(exists('livre.png')).toBe(false);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('EBUSY');
    expect(logged).not.toContain('/srv/segredo');
  });

  it('pasta de uploads inexistente: nada a fazer', async () => {
    const { service } = build();
    process.env.UPLOADS_DIR = join(root, 'nao-existe');
    await expect(service.cleanUploads('delete')).resolves.toMatchObject({
      files_scanned: 0,
      deleted: 0,
    });
  });

  describe('execução em segundo plano', () => {
    it('delete: RUNNING na hora, SUCCEEDED com as contagens e auditoria (só contagens) no início e no fim', async () => {
      const { service, db, audit } = build();
      plant('orfao.png', 48, 1234);
      plant('em-uso.png', 48, 10);
      db.seed('products', { id: 1, store_id: 1, image: 'em-uso.png' });

      const started = await service.startUploadsCleanup(
        SUPER_ADMIN,
        'delete',
        null,
      );
      expect(started.job).toMatchObject({
        kind: MaintenanceJobKind.CLEANUP_UPLOADS,
        status: MaintenanceJobStatus.RUNNING,
        finished_at: null,
        started_by: { id: SUPER_ADMIN.id, name: SUPER_ADMIN.name },
        summary: { mode: 'delete', orphans: 0, deleted: 0 },
      });
      const jobId = started.job.id;
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: CLEANUP_UPLOADS_AUDIT_ACTION,
          scope: 'PLATFORM',
          actor: SUPER_ADMIN,
          targetType: 'maintenance_job',
          targetId: jobId,
          metadata: { job_id: jobId, mode: 'delete', trigger: 'manual' },
        }),
      );

      const outcome = await started.done;
      const summary: UploadsCleanupSummary = {
        mode: 'delete',
        trigger: 'manual',
        min_age_hours: 24,
        files_scanned: 2,
        in_use: 1,
        recent: 0,
        orphans: 1,
        orphan_bytes: 1234,
        deleted: 1,
        deleted_bytes: 1234,
        failed: 0,
        skipped: 0,
      };
      expect(outcome).toEqual({
        status: MaintenanceJobStatus.SUCCEEDED,
        summary,
        error: null,
      });
      expect(exists('orfao.png')).toBe(false);
      expect(audit.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: CLEANUP_UPLOADS_FINISHED_AUDIT_ACTION,
          result: 'SUCCESS',
          targetId: jobId,
          metadata: {
            ...summary,
            duration_ms: expect.any(Number) as unknown,
            job_id: jobId,
          },
        }),
      );
      // Nada de nomes de arquivo na execução nem na auditoria
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain(
        'orfao.png',
      );
      await expect(service.latestUploadsCleanup()).resolves.toMatchObject({
        id: jobId,
        status: MaintenanceJobStatus.SUCCEEDED,
        summary,
      });
      // A otimização tem a própria execução (o GET dela não mostra a limpeza)
      await expect(service.latestImageOptimization()).resolves.toBeNull();
    });

    it('uma limpeza por vez (verificar e apagar dividem a trava); a otimização tem trava própria', async () => {
      const { service, db, audit } = build();
      const running = db.seed('maintenance_jobs', {
        kind: MaintenanceJobKind.CLEANUP_UPLOADS,
        status: MaintenanceJobStatus.RUNNING,
        started_by_user_id: SUPER_ADMIN.id,
        started_at: new Date(NOW.getTime() - 60_000),
        heartbeat_at: new Date(NOW.getTime() - 1_000),
        finished_at: null,
        summary: { mode: 'check', files_scanned: 3 },
        error: null,
      });

      for (const mode of ['check', 'delete'] as const) {
        const error = (await service
          .startUploadsCleanup(SUPER_ADMIN, mode)
          .catch((caught: unknown) => caught)) as MaintenanceJobConflictError;
        expect(error).toBeInstanceOf(MaintenanceJobConflictError);
        expect(error.message).toBe(CLEANUP_RUNNING_MESSAGE);
        expect(error.job).toMatchObject({
          id: running.id,
          kind: MaintenanceJobKind.CLEANUP_UPLOADS,
          summary: { mode: 'check', files_scanned: 3 },
        });
        expect(audit.record).toHaveBeenLastCalledWith(
          expect.objectContaining({
            action: CLEANUP_UPLOADS_AUDIT_ACTION,
            result: 'FAILURE',
            metadata: {
              reason: CLEANUP_RUNNING_MESSAGE,
              running_job_id: running.id,
              mode,
              trigger: 'manual',
            },
          }),
        );
      }

      const optimization = await service.startImageOptimization(SUPER_ADMIN);
      expect(optimization.job.kind).toBe(MaintenanceJobKind.OPTIMIZE_IMAGES);
      await optimization.done;
    });
  });

  describe('limpeza agendada (UPLOADS_CLEANUP_INTERVAL_HOURS)', () => {
    const DAILY = uploadsCleanupScheduleConfig({
      UPLOADS_CLEANUP_INTERVAL_HOURS: '24',
    });
    const clock = (at: Date) =>
      jest
        .spyOn(
          MaintenanceService.prototype as unknown as { now: () => Date },
          'now',
        )
        .mockImplementation(() => new Date(at));

    /** Serviço com o agendamento ligado, sem timer: as conferências são chamadas pelo teste. */
    function scheduled(db?: FakeDb) {
      const built = build(db);
      built.service.startCleanupSchedule(DAILY);
      built.service.stopCleanupSchedule();
      return built;
    }

    it('na hora: apaga como a manual, sem ator (SYSTEM, trigger schedule); a próxima só depois do intervalo', async () => {
      const { service, audit, db } = scheduled();
      plant('s3-orfao.webp', 48, 700);
      plant('s3-recente.webp', 1, 300);
      const invalidateAll = jest.spyOn(storeStorageUsage, 'invalidateAll');

      const started = await service.checkScheduledCleanup();
      expect(started).not.toBeNull();
      expect(started!.job).toMatchObject({
        kind: MaintenanceJobKind.CLEANUP_UPLOADS,
        status: MaintenanceJobStatus.RUNNING,
        started_by: null,
        summary: { mode: 'delete', trigger: 'schedule' },
      });
      const jobId = started!.job.id;
      expect(db.rows('maintenance_jobs')[0]).toMatchObject({
        id: jobId,
        started_by_user_id: null,
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: CLEANUP_UPLOADS_AUDIT_ACTION,
          scope: 'SYSTEM',
          actor: null,
          targetType: 'maintenance_job',
          targetId: jobId,
          metadata: { job_id: jobId, mode: 'delete', trigger: 'schedule' },
        }),
      );

      const outcome = await started!.done;
      expect(outcome).toMatchObject({
        status: MaintenanceJobStatus.SUCCEEDED,
        summary: { trigger: 'schedule', deleted: 1, deleted_bytes: 700 },
      });
      expect(exists('s3-orfao.webp')).toBe(false);
      expect(exists('s3-recente.webp')).toBe(true); // menos de 24 h
      expect(audit.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: CLEANUP_UPLOADS_FINISHED_AUDIT_ACTION,
          scope: 'SYSTEM',
          actor: null,
          result: 'SUCCESS',
          metadata: expect.objectContaining({
            job_id: jobId,
            trigger: 'schedule',
            deleted: 1,
          }) as unknown,
        }),
      );
      // Arquivos apagados: o uso de armazenamento das lojas é medido de novo
      expect(invalidateAll).toHaveBeenCalled();

      // Logo depois (mesma instância ou outra): ainda não está na hora
      await expect(service.checkScheduledCleanup()).resolves.toBeNull();
      clock(new Date(NOW.getTime() + 23 * HOUR));
      await expect(service.checkScheduledCleanup()).resolves.toBeNull();
      // Um intervalo depois (com a folga de meia conferência): roda de novo
      clock(new Date(NOW.getTime() + 24 * HOUR - 60_000));
      const next = await service.checkScheduledCleanup();
      expect(next?.job).toMatchObject({ summary: { trigger: 'schedule' } });
      await next!.done;
      expect(db.rows('maintenance_jobs')).toHaveLength(2);
    });

    it('com uma limpeza em andamento (manual ou de outra instância): adia sem auditar a recusa', async () => {
      const { service, db, audit } = scheduled();
      db.seed('maintenance_jobs', {
        kind: MaintenanceJobKind.CLEANUP_UPLOADS,
        status: MaintenanceJobStatus.RUNNING,
        started_by_user_id: SUPER_ADMIN.id,
        started_at: new Date(NOW.getTime() - 60_000),
        heartbeat_at: new Date(NOW.getTime() - 1_000),
        finished_at: null,
        summary: { mode: 'check', trigger: 'manual' },
        error: null,
      });

      await expect(service.checkScheduledCleanup()).resolves.toBeNull();
      expect(audit.record).not.toHaveBeenCalled();
      expect(db.rows('maintenance_jobs')).toHaveLength(1);
    });

    it('limpeza manual recente não conta como a agendada; desligada nunca roda', async () => {
      const { service, db } = scheduled();
      const manual = await service.startUploadsCleanup(SUPER_ADMIN, 'check');
      await manual.done;

      const started = await service.checkScheduledCleanup();
      expect(started?.job.summary).toMatchObject({ trigger: 'schedule' });
      await started!.done;

      const off = build(db);
      off.service.startCleanupSchedule(uploadsCleanupScheduleConfig({}));
      clock(new Date(NOW.getTime() + 30 * 24 * HOUR));
      await expect(off.service.checkScheduledCleanup()).resolves.toBeNull();
    });

    it('situação: ligada ou não, intervalo, última execução agendada e a próxima prevista', async () => {
      const { service, db } = build();
      service.startCleanupSchedule(uploadsCleanupScheduleConfig({}));
      await expect(service.uploadsCleanupSchedule()).resolves.toEqual({
        enabled: false,
        interval_hours: null,
        mode: 'delete',
        min_age_hours: 24,
        next_run_at: null,
        last_run: null,
      });

      service.startCleanupSchedule(DAILY);
      try {
        // Nunca rodou: na primeira conferência do timer (5 min depois da subida)
        await expect(service.uploadsCleanupSchedule()).resolves.toMatchObject({
          enabled: true,
          interval_hours: 24,
          next_run_at: new Date(NOW.getTime() + 5 * 60_000),
          last_run: null,
        });

        const started = await service.checkScheduledCleanup();
        await started!.done;
        const view = await service.uploadsCleanupSchedule();
        expect(view.last_run).toMatchObject({
          id: started!.job.id,
          status: MaintenanceJobStatus.SUCCEEDED,
          started_by: null,
          summary: { trigger: 'schedule' },
        });
        // 24 h - 2,5 min de folga, arredondado para a conferência seguinte do timer
        expect(view.next_run_at).toEqual(new Date(NOW.getTime() + 24 * HOUR));
        expect(db.rows('maintenance_jobs')).toHaveLength(1);
      } finally {
        service.stopCleanupSchedule();
      }
    });

    it('timer: confere a cada intervalo de conferência; desligada não liga timer; o desligamento para', () => {
      jest.useFakeTimers();
      try {
        const { service } = build();
        const check = jest
          .spyOn(service, 'checkScheduledCleanup')
          .mockResolvedValue(null);
        const fast = uploadsCleanupScheduleConfig({
          UPLOADS_CLEANUP_INTERVAL_HOURS: '0.005', // 18 s
        });
        expect(fast).toMatchObject({ intervalMs: 18_000, checkMs: 18_000 });

        service.startCleanupSchedule(fast);
        jest.advanceTimersByTime(18_000 * 3);
        expect(check).toHaveBeenCalledTimes(3);

        service.onModuleDestroy();
        jest.advanceTimersByTime(18_000 * 3);
        expect(check).toHaveBeenCalledTimes(3);

        service.startCleanupSchedule(uploadsCleanupScheduleConfig({}));
        jest.advanceTimersByTime(60 * 60_000);
        expect(check).toHaveBeenCalledTimes(3);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});

describe('Limpeza agendada — configuração e horário', () => {
  it('vazio, 0 ou off: desligada (o padrão)', () => {
    for (const value of [undefined, '', '  ', '0', '0.0', '0,00', 'off']) {
      expect(
        uploadsCleanupScheduleConfig({ UPLOADS_CLEANUP_INTERVAL_HOURS: value }),
      ).toEqual({
        enabled: false,
        intervalHours: null,
        intervalMs: null,
        checkMs: null,
        problem: null,
      });
    }
  });

  it('horas com decimais (ponto ou vírgula); mínimo de 10 s; conferência a cada 5 min no máximo', () => {
    expect(
      uploadsCleanupScheduleConfig({ UPLOADS_CLEANUP_INTERVAL_HOURS: ' 24 ' }),
    ).toEqual({
      enabled: true,
      intervalHours: 24,
      intervalMs: 24 * HOUR,
      checkMs: 5 * 60_000,
      problem: null,
    });
    expect(
      uploadsCleanupScheduleConfig({ UPLOADS_CLEANUP_INTERVAL_HOURS: '0,5' }),
    ).toMatchObject({ intervalHours: 0.5, intervalMs: HOUR / 2 });
    expect(
      uploadsCleanupScheduleConfig({
        UPLOADS_CLEANUP_INTERVAL_HOURS: '0.0001',
      }),
    ).toMatchObject({ enabled: true, intervalMs: 10_000, checkMs: 10_000 });
  });

  it('valor inválido: desligada, com o problema para o log', () => {
    for (const value of ['abc', '-1', '1e3', '24h', '1.2.3']) {
      const config = uploadsCleanupScheduleConfig({
        UPLOADS_CLEANUP_INTERVAL_HOURS: value,
      });
      expect(config.enabled).toBe(false);
      expect(config.problem).toContain('UPLOADS_CLEANUP_INTERVAL_HOURS');
    }
  });

  it('está na hora: nunca rodou ou a última agendada começou há um intervalo (folga de meia conferência)', () => {
    const config = { intervalMs: 24 * HOUR, checkMs: 5 * 60_000 };
    const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR);
    expect(isScheduledCleanupDue(null, NOW, config)).toBe(true);
    expect(isScheduledCleanupDue(NOW, at(23.9), config)).toBe(false);
    expect(isScheduledCleanupDue(NOW, at(24 - 2.5 / 60), config)).toBe(true);
    expect(isScheduledCleanupDue(NOW.toISOString(), at(25), config)).toBe(true);
    expect(
      isScheduledCleanupDue(null, NOW, { intervalMs: null, checkMs: null }),
    ).toBe(false);
  });
});
