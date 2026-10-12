import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { User, UserRole } from '../users/entities/user.entity';
import { toPublicUser } from '../users/public-user';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';

function makeUser(overrides: Partial<User> = {}): User {
  return Object.assign(new User(), {
    id: 7,
    name: 'Maria Silva',
    email: 'maria@email.com',
    role: UserRole.CLIENT,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  });
}

describe('AuthService', () => {
  let hash: string;

  beforeAll(async () => {
    hash = await bcrypt.hash('Senha@12345', 4);
  });

  function serviceWith(candidates: User[]) {
    const users = {
      findForLogin: jest.fn().mockResolvedValue(candidates),
    };
    return {
      users,
      service: new AuthService(
        users as unknown as UsersService,
        new JwtService({ secret: 'segredo-de-teste' }),
      ),
    };
  }

  it('aceita a senha certa e devolve o usuário sem password_hash', async () => {
    const { users, service } = serviceWith([makeUser({ password_hash: hash })]);

    const user = await service.validateUser('maria@email.com', 'Senha@12345');

    expect(users.findForLogin).toHaveBeenCalledWith('maria@email.com');
    expect(user).toMatchObject({ id: 7, email: 'maria@email.com' });
    expect(user).not.toHaveProperty('password_hash');
  });

  it('senha errada ou e-mail inexistente → null', async () => {
    expect(
      await serviceWith([
        makeUser({ password_hash: hash }),
      ]).service.validateUser('maria@email.com', 'Errada@12345'),
    ).toBeNull();
    expect(
      await serviceWith([]).service.validateUser(
        'nada@email.com',
        'Senha@12345',
      ),
    ).toBeNull();
  });

  it('contas antigas que diferem só em maiúsculas: a senha decide qual entra', async () => {
    const otherHash = await bcrypt.hash('Outra@12345', 4);
    const { service } = serviceWith([
      makeUser({ id: 1, email: 'Maria@Email.com', password_hash: otherHash }),
      makeUser({ id: 2, email: 'maria@email.com', password_hash: hash }),
    ]);

    const user = await service.validateUser('MARIA@email.com', 'Senha@12345');
    expect(user?.id).toBe(2);
  });

  it('o token leva sub, email, role e name e respeita a validade configurada', () => {
    const jwt = new JwtService({
      secret: 'segredo-de-teste',
      signOptions: { expiresIn: '7d' },
    });
    const service = new AuthService({} as UsersService, jwt);

    const { access_token, user } = service.login(toPublicUser(makeUser()));
    const payload = jwt.verify<Record<string, number | string>>(access_token);

    expect(payload).toMatchObject({
      sub: 7,
      email: 'maria@email.com',
      role: UserRole.CLIENT,
      name: 'Maria Silva',
    });
    expect(Number(payload.exp) - Number(payload.iat)).toBe(7 * 24 * 60 * 60);
    expect(user).not.toHaveProperty('password_hash');
  });
});

describe('JwtStrategy.validate', () => {
  const originalSecret = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET = 'segredo-de-teste';
  });

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });

  function strategyWith(found: User | null) {
    const users = { findActiveById: jest.fn().mockResolvedValue(found) };
    return {
      users,
      strategy: new JwtStrategy(users as unknown as UsersService),
    };
  }

  it('devolve id, email, name e o perfil ATUAL do banco (não o do token)', async () => {
    const { users, strategy } = strategyWith(
      makeUser({ role: UserRole.EMPLOYEE }),
    );

    await expect(
      strategy.validate({ sub: 7, role: UserRole.CLIENT }),
    ).resolves.toEqual({
      id: 7,
      email: 'maria@email.com',
      role: UserRole.EMPLOYEE,
      name: 'Maria Silva',
    });
    expect(users.findActiveById).toHaveBeenCalledWith(7);
  });

  it('conta excluída ou inexistente → 401', async () => {
    const { strategy } = strategyWith(null);
    await expect(strategy.validate({ sub: 7 })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('sub inválido → 401 sem consultar o banco', async () => {
    const { users, strategy } = strategyWith(makeUser());
    await expect(strategy.validate({})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(users.findActiveById).not.toHaveBeenCalled();
  });
});

describe('User.toJSON', () => {
  it('nunca serializa o password_hash, nem quando aninhado (ex.: order.user)', () => {
    const user = makeUser({ password_hash: '$2b$10$hash-que-nao-pode-vazar' });
    const json = JSON.parse(JSON.stringify({ order: { user } })) as {
      order: { user: Record<string, unknown> };
    };

    expect(json.order.user).not.toHaveProperty('password_hash');
    expect(json.order.user.email).toBe('maria@email.com');
  });
});
