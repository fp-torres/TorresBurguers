import { Store, StoreAccountStatus } from '../store/entities/store.entity';
import { PlatformRole, User, UserRole } from './entities/user.entity';
import { INTERNAL_USER_FIELDS, toPublicUser } from './public-user';
import {
  SESSION_STORE_FIELDS,
  SESSION_STORE_SELECT,
  toSessionStore,
  toSessionUser,
  toTeamMember,
} from './session-user';

const SESSION_KEYS = [
  'avatar',
  'created_at',
  'email',
  'id',
  'name',
  'phone',
  'platform_role',
  'role',
  'store',
  'store_id',
  'updated_at',
];

/** Entidade "carregada demais": hash, campos internos, relações e um campo novo qualquer. */
function loadedUser(): User {
  return Object.assign(new User(), {
    id: 7,
    name: 'Maria',
    email: 'maria@email.com',
    phone: '21999998888',
    avatar: '/uploads/a.webp',
    role: UserRole.ADMIN,
    store_id: 3,
    platform_role: null,
    password_hash: '$2b$10$hash-que-nao-pode-vazar',
    token_version: 4,
    blocked_at: null,
    blocked_reason: 'motivo interno',
    last_login_at: new Date(),
    deleted_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-02T00:00:00Z'),
    orders: [{ id: 1 }],
    campo_futuro: 'interno',
  });
}

function loadedStore(): Store {
  return Object.assign(new Store(), {
    id: 3,
    slug: 'loja-a',
    name: 'Loja A',
    logo: 's3-logo.webp',
    primary_color: '#aa0000',
    account_status: StoreAccountStatus.SUSPENDED,
    document: '12345678000199',
    mp_public_key: 'APP_USR-publica',
    mp_access_token_encrypted: 'v1:segredo',
    owner_user_id: 7,
  });
}

describe('session-user (respostas de conta por lista de campos permitidos)', () => {
  it('SessionUser tem exatamente os campos do contrato, sem hash nem campos internos', () => {
    const session = toSessionUser(loadedUser(), loadedStore());
    expect(Object.keys(session).sort()).toEqual(SESSION_KEYS);
    expect(session).toMatchObject({
      id: 7,
      role: UserRole.ADMIN,
      store_id: 3,
      platform_role: null,
    });
    const json = JSON.stringify(session);
    for (const leaked of [
      'password_hash',
      'token_version',
      'blocked_reason',
      'last_login_at',
      'campo_futuro',
      'orders',
    ]) {
      expect(json).not.toContain(leaked);
    }
  });

  it('a loja vai só como resumo (nunca credenciais, documento ou responsável)', () => {
    const store = toSessionStore(loadedStore());
    expect(store).toEqual({
      id: 3,
      slug: 'loja-a',
      name: 'Loja A',
      logo: 's3-logo.webp',
      primary_color: '#aa0000',
      account_status: StoreAccountStatus.SUSPENDED,
    });
    expect(Object.keys(SESSION_STORE_SELECT).sort()).toEqual(
      [...SESSION_STORE_FIELDS].sort(),
    );
    expect(toSessionStore(null)).toBeNull();
  });

  it('cliente e superadmin: store null; nulos viram null (nunca undefined)', () => {
    const client = Object.assign(new User(), {
      id: 9,
      name: 'Cliente',
      email: 'c@email.com',
      role: UserRole.CLIENT,
      store_id: null,
      platform_role: PlatformRole.SUPER_ADMIN,
    });
    expect(toSessionUser(client)).toMatchObject({
      phone: null,
      avatar: null,
      store_id: null,
      store: null,
      platform_role: PlatformRole.SUPER_ADMIN,
    });
  });

  it('itens da equipe/lixeira levam deleted_at', () => {
    const trashed = Object.assign(loadedUser(), { deleted_at: new Date() });
    expect(toTeamMember(trashed).deleted_at).toBeInstanceOf(Date);
    expect(toTeamMember(loadedUser()).deleted_at).toBeNull();
  });

  it('toPublicUser e User.toJSON removem o hash e os campos internos; a loja vira resumo', () => {
    const user = Object.assign(loadedUser(), { store: loadedStore() });

    const publicUser = toPublicUser(user) as unknown as Record<string, unknown>;
    for (const field of INTERNAL_USER_FIELDS) {
      expect(publicUser).not.toHaveProperty(field);
    }

    const json = JSON.parse(JSON.stringify({ order: { user } })) as {
      order: { user: Record<string, unknown> };
    };
    for (const field of INTERNAL_USER_FIELDS) {
      expect(json.order.user).not.toHaveProperty(field);
    }
    expect(json.order.user.store).toEqual({
      id: 3,
      slug: 'loja-a',
      name: 'Loja A',
      logo: 's3-logo.webp',
    });
    expect(json.order.user.email).toBe('maria@email.com');
  });
});
