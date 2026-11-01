import * as bcrypt from 'bcrypt';
import type { Repository } from 'typeorm';
import { demoSuperadminSeedAllowed } from '../../config/env';
import { PlatformRole, type User } from '../../users/entities/user.entity';
import { DEFAULT_USERS } from './default-users';
import {
  defaultUsersFor,
  demoSuperadminsWithPublicPassword,
  seedDefaultUsers,
} from './seed-default-users';
import { seedAllowed, seedIncludesSuperadmin } from './seed-policy';

const SUPERADMIN = DEFAULT_USERS.find((u) => u.platformRole)!;

/** Repositório falso: guarda o que foi criado e devolve contas pelo e-mail. */
function fakeUsers(existing: Partial<User>[] = []) {
  const saved: Partial<User>[] = [];
  const repo = {
    findOne: jest.fn(({ where }: { where: { email: unknown } }) => {
      const wanted = JSON.stringify(where.email);
      const found = existing.find((user) =>
        wanted.toLowerCase().includes(String(user.email).toLowerCase()),
      );
      return Promise.resolve(found ?? null);
    }),
    create: jest.fn((data: Partial<User>) => data),
    save: jest.fn((data: Partial<User>) => {
      saved.push(data);
      return Promise.resolve(data);
    }),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
    restore: jest.fn(() => Promise.resolve()),
  };
  return { repo: repo as unknown as Repository<User>, saved, mock: repo };
}

describe('superadmin de demonstração (senha pública): só com opção explícita, nunca em produção', () => {
  it('test: incluído por padrão (suíte E2E); development: só com SEED_DEMO_SUPERADMIN=true; produção: nunca', () => {
    expect(demoSuperadminSeedAllowed({ NODE_ENV: 'test' })).toBe(true);
    expect(
      demoSuperadminSeedAllowed({
        NODE_ENV: 'test',
        SEED_DEMO_SUPERADMIN: 'false',
      }),
    ).toBe(false);
    expect(demoSuperadminSeedAllowed({ NODE_ENV: 'development' })).toBe(false);
    expect(
      demoSuperadminSeedAllowed({
        NODE_ENV: 'development',
        SEED_DEMO_SUPERADMIN: 'true',
      }),
    ).toBe(true);
    for (const env of [
      { NODE_ENV: 'production', SEED_DEMO_SUPERADMIN: 'true' },
      { SEED_DEMO_SUPERADMIN: 'true' },
      { NODE_ENV: 'staging', SEED_DEMO_SUPERADMIN: 'true' },
    ]) {
      expect(demoSuperadminSeedAllowed(env)).toBe(false);
    }
  });

  it('npm run seed: recusado em produção mesmo com --force; superadmin só com --with-superadmin', () => {
    expect(seedAllowed({ NODE_ENV: 'production' })).toBe(false);
    expect(seedAllowed({})).toBe(false);
    expect(seedAllowed({ NODE_ENV: 'development' })).toBe(true);

    const dev = { NODE_ENV: 'development' };
    expect(seedIncludesSuperadmin(['node', 'seed.ts'], dev)).toBe(false);
    expect(
      seedIncludesSuperadmin(['node', 'seed.ts', '--with-superadmin'], dev),
    ).toBe(true);
    expect(
      seedIncludesSuperadmin(['node', 'seed.ts', '--with-superadmin'], {
        NODE_ENV: 'production',
      }),
    ).toBe(false);
  });

  it('subida em development: cria a equipe e o cliente demo, mas não o superadmin', async () => {
    expect(defaultUsersFor(false).some((u) => u.platformRole)).toBe(false);
    expect(defaultUsersFor(true)).toContain(SUPERADMIN);

    const { repo, saved } = fakeUsers();
    await seedDefaultUsers(repo, {
      resetPasswords: false,
      storeId: 3,
      includeSuperadmin: false,
    });
    expect(saved.map((user) => user.email)).not.toContain(SUPERADMIN.email);
    expect(saved.some((user) => user.platform_role)).toBe(false);
    expect(saved).toHaveLength(DEFAULT_USERS.length - 1);

    const withSuperadmin = fakeUsers();
    await seedDefaultUsers(withSuperadmin.repo, {
      resetPasswords: false,
      storeId: 3,
      includeSuperadmin: true,
    });
    expect(
      withSuperadmin.saved.find((user) => user.email === SUPERADMIN.email),
    ).toMatchObject({
      platform_role: PlatformRole.SUPER_ADMIN,
      store_id: null,
    });
  });

  it('seed com redefinição sem o superadmin não toca na conta de e-mail coincidente', async () => {
    const { repo, mock } = fakeUsers([
      {
        id: 50,
        email: SUPERADMIN.email,
        platform_role: PlatformRole.SUPER_ADMIN,
      },
    ]);
    await seedDefaultUsers(repo, {
      resetPasswords: true,
      storeId: 3,
      includeSuperadmin: false,
    });
    expect(mock.update).not.toHaveBeenCalledWith(50, expect.anything());
  });

  it('avisa quando um superadmin antigo ainda usa a senha pública', async () => {
    const hash = await bcrypt.hash(SUPERADMIN.password, 4);
    const exposed = fakeUsers([
      {
        id: 50,
        email: SUPERADMIN.email,
        platform_role: PlatformRole.SUPER_ADMIN,
        password_hash: hash,
      },
    ]);
    await expect(
      demoSuperadminsWithPublicPassword(exposed.repo),
    ).resolves.toEqual([SUPERADMIN.email]);

    const changed = fakeUsers([
      {
        id: 50,
        email: SUPERADMIN.email,
        platform_role: PlatformRole.SUPER_ADMIN,
        password_hash: await bcrypt.hash('OutraSenhaForte#2026', 4),
      },
    ]);
    await expect(
      demoSuperadminsWithPublicPassword(changed.repo),
    ).resolves.toEqual([]);
  });
});
