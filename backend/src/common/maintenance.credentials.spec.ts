import { Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import type { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth-user';
import { FakeDb } from '../billing/testing/fake-db.helper-spec';
import { Addon } from '../products/entities/addon.entity';
import { Product } from '../products/entities/product.entity';
import { Store } from '../store/entities/store.entity';
import { PlatformRole, User, UserRole } from '../users/entities/user.entity';
import {
  CredentialsKeyError,
  decryptStoreSecret,
  encryptSecret,
  encryptStoreSecret,
  secretFormatVersion,
} from './crypto/secret-box';
import { MaintenanceJob } from './entities/maintenance-job.entity';
import {
  CREDENTIALS_KEY_UNAVAILABLE_MESSAGE,
  MaintenanceService,
  REENCRYPT_CREDENTIALS_AUDIT_ACTION,
} from './maintenance.service';

const SUPER_ADMIN: AuthUser = {
  id: 1,
  email: 'root@comestra.com',
  name: 'Plataforma',
  role: UserRole.CLIENT,
  storeId: null,
  platformRole: PlatformRole.SUPER_ADMIN,
};

const TOKEN_1 = 'APP_USR-1111111111111111-101112-aaaaaaaaaaaaaaaa-111111111';
const TOKEN_2 = 'APP_USR-2222222222222222-101112-bbbbbbbbbbbbbbbb-222222222';
const TOKEN_4 = 'APP_USR-4444444444444444-101112-dddddddddddddddd-444444444';

type StoreRow = { id: number; mp_access_token_encrypted: string | null };

function build() {
  const db = new FakeDb([
    { entity: Product, name: 'products' },
    { entity: Addon, name: 'addons' },
    { entity: User, name: 'users' },
    { entity: Store, name: 'stores' },
    {
      entity: MaintenanceJob,
      name: 'maintenance_jobs',
      createdColumns: [],
      updatedColumn: null,
    },
  ]);
  const jobs = db.repository<MaintenanceJob>(MaintenanceJob);
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new MaintenanceService(
    db.repository(Product) as unknown as Repository<Product>,
    db.repository(Addon) as unknown as Repository<Addon>,
    db.repository(User) as unknown as Repository<User>,
    jobs as unknown as Repository<MaintenanceJob>,
    audit as unknown as AuditService,
  );
  const stores = () => db.rows('stores') as unknown as StoreRow[];
  const tokenOf = (id: number) =>
    stores().find((row) => row.id === id)?.mp_access_token_encrypted ?? null;
  return { service, db, audit, stores, tokenOf };
}

describe('MaintenanceService — credenciais Mercado Pago no formato atual', () => {
  const original = {
    key: process.env.CREDENTIALS_ENCRYPTION_KEY,
    env: process.env.NODE_ENV,
  };
  let legacy1: string;
  let current2: string;
  let foreignKey4: string;

  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  beforeEach(() => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    process.env.NODE_ENV = 'test';
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    legacy1 = encryptSecret(TOKEN_1); // v1: sem vínculo com a loja
    current2 = encryptStoreSecret(2, TOKEN_2); // v2: já preso à loja 2
    // v1 gravado com OUTRA chave (ex.: chave trocada): ilegível
    foreignKey4 = encryptSecret(TOKEN_4, {
      NODE_ENV: 'test',
      CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    restore('CREDENTIALS_ENCRYPTION_KEY', original.key);
    restore('NODE_ENV', original.env);
  });

  function seed(db: FakeDb) {
    db.seed('stores', { id: 1, mp_access_token_encrypted: legacy1 });
    db.seed('stores', { id: 2, mp_access_token_encrypted: current2 });
    db.seed('stores', { id: 3, mp_access_token_encrypted: 'lixo-corrompido' });
    db.seed('stores', { id: 4, mp_access_token_encrypted: foreignKey4 });
    db.seed('stores', { id: 5, mp_access_token_encrypted: null });
    db.seed('stores', { id: 6, mp_access_token_encrypted: '' });
  }

  it('situação: conta as lojas por formato, sem decifrar nada', async () => {
    const { service, db } = build();
    seed(db);
    await expect(service.storeCredentialsStatus()).resolves.toEqual({
      total: 4,
      current: 1,
      legacy: 2,
      unknown: 1,
    });
  });

  it('regrava o v1 como v2 preso à loja; v2 fica igual; ilegíveis ficam como estão; idempotente', async () => {
    const { service, db, audit, tokenOf } = build();
    seed(db);

    const first = await service.reencryptStoreCredentials(SUPER_ADMIN, null);

    expect(first).toEqual({
      total: 4,
      migrated: 1,
      already_current: 1,
      changed: 0,
      failed: 2,
      failed_store_ids: [3, 4],
    });
    const upgraded = tokenOf(1)!;
    expect(secretFormatVersion(upgraded)).toBe('v2');
    expect(decryptStoreSecret(1, upgraded)).toBe(TOKEN_1);
    expect(() => decryptStoreSecret(2, upgraded)).toThrow();
    expect(tokenOf(2)).toBe(current2);
    expect(tokenOf(3)).toBe('lixo-corrompido');
    expect(tokenOf(4)).toBe(foreignKey4);
    expect(tokenOf(5)).toBeNull();
    expect(tokenOf(6)).toBe('');

    // Auditoria: só contagens (nem token, nem valor cifrado, nem ids)
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: SUPER_ADMIN,
        scope: 'PLATFORM',
        action: REENCRYPT_CREDENTIALS_AUDIT_ACTION,
        metadata: {
          total: 4,
          migrated: 1,
          already_current: 1,
          changed: 0,
          failed: 2,
        },
      }),
    );
    const everything = JSON.stringify([
      first,
      audit.record.mock.calls,
      (Logger.prototype.log as jest.Mock).mock.calls,
      (Logger.prototype.warn as jest.Mock).mock.calls,
    ]);
    for (const secret of [
      TOKEN_1,
      TOKEN_2,
      TOKEN_4,
      legacy1,
      upgraded,
      current2,
    ]) {
      expect(everything).not.toContain(secret);
    }

    // Segunda vez: nada muda (o v2 não é regravado)
    const second = await service.reencryptStoreCredentials(SUPER_ADMIN, null);
    expect(second).toMatchObject({
      total: 4,
      migrated: 0,
      already_current: 2,
      failed: 2,
    });
    expect(tokenOf(1)).toBe(upgraded);
    await expect(service.storeCredentialsStatus()).resolves.toEqual({
      total: 4,
      current: 2,
      legacy: 1,
      unknown: 1,
    });
  });

  it('a loja salvou credenciais novas no meio: a gravação condicional não sobrescreve', async () => {
    const { service, db, tokenOf } = build();
    db.seed('stores', { id: 1, mp_access_token_encrypted: legacy1 });
    const saved = encryptStoreSecret(1, 'APP_USR-nova-credencial-da-loja');
    const stores = db.repository<Store>(Store);
    jest
      .spyOn(
        MaintenanceService.prototype as unknown as {
          storeRepository: () => unknown;
        },
        'storeRepository',
      )
      .mockReturnValue({
        find: (options: Parameters<typeof stores.find>[0]) =>
          stores.find(options),
        update: async (criteria: unknown, partial: Partial<Store>) => {
          await stores.update({ id: 1 }, { mp_access_token_encrypted: saved });
          return stores.update(criteria, partial);
        },
      });

    await expect(
      service.reencryptStoreCredentials(SUPER_ADMIN, null),
    ).resolves.toMatchObject({ total: 1, migrated: 0, changed: 1 });
    expect(tokenOf(1)).toBe(saved);
  });

  it('produção sem a chave: nada é regravado, a falha fica na auditoria e o erro sobe (503 na rota)', async () => {
    const { service, db, audit, tokenOf } = build();
    seed(db);
    delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    process.env.NODE_ENV = 'production';

    await expect(
      service.reencryptStoreCredentials(SUPER_ADMIN, null),
    ).rejects.toBeInstanceOf(CredentialsKeyError);
    expect(tokenOf(1)).toBe(legacy1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: REENCRYPT_CREDENTIALS_AUDIT_ACTION,
        result: 'FAILURE',
        metadata: expect.objectContaining({
          reason: CREDENTIALS_KEY_UNAVAILABLE_MESSAGE,
          migrated: 0,
        }) as unknown,
      }),
    );
    // A situação (sem decifrar) continua disponível
    await expect(service.storeCredentialsStatus()).resolves.toMatchObject({
      legacy: 2,
    });
  });
});
