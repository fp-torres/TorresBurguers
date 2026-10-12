import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, Not } from 'typeorm';
import * as bcrypt from 'bcrypt';
import {
  isForeignKeyViolation,
  isUniqueViolation,
} from '../common/database-errors';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { emailEquals, normalizeEmail } from './email';
import { User, UserRole } from './entities/user.entity';
import { PublicUser, toPublicUser } from './public-user';
import { assertKeepsAnAdmin, removesActiveAdmin } from './users.policy';

const SALT_ROUNDS = 10;
const EMAIL_TAKEN = 'E-mail já cadastrado';
const USER_NOT_FOUND = 'Usuário não encontrado';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  /** Cria a conta com o perfil já autorizado pelo controller (padrão: CLIENT). */
  async create(
    createUserDto: CreateUserDto,
    role: UserRole = UserRole.CLIENT,
  ): Promise<PublicUser> {
    const email = normalizeEmail(createUserDto.email);
    await this.assertEmailAvailable(email);

    const newUser = this.usersRepository.create({
      name: createUserDto.name,
      email,
      phone: createUserDto.phone,
      avatar: createUserDto.avatar,
      role,
      password_hash: await bcrypt.hash(createUserDto.password, SALT_ROUNDS),
    });

    try {
      return toPublicUser(await this.usersRepository.save(newUser));
    } catch (error) {
      // Corrida entre dois cadastros com o mesmo e-mail: a constraint UNIQUE do banco decide
      if (isUniqueViolation(error)) {
        throw new ConflictException(EMAIL_TAKEN);
      }
      throw error;
    }
  }

  findAll() {
    return this.usersRepository.find({
      order: { created_at: 'DESC' },
    });
  }

  async findOne(id: number): Promise<User> {
    const user = await this.usersRepository.findOneBy({ id });
    if (!user) throw new NotFoundException(USER_NOT_FOUND);
    return user;
  }

  /** Usuário ativo (não excluído) ou null — usado pela JwtStrategy a cada requisição. */
  findActiveById(id: number): Promise<User | null> {
    return this.usersRepository.findOneBy({ id });
  }

  /**
   * Usado SOMENTE pelo login: é a única consulta que carrega o password_hash.
   * Compara o e-mail sem diferenciar maiúsculas; pode haver mais de uma conta antiga
   * que difere só na caixa, por isso devolve todas (a senha decide qual é).
   */
  findForLogin(email: string): Promise<User[]> {
    return this.usersRepository
      .createQueryBuilder('u')
      .addSelect('u.password_hash')
      .where('LOWER(u.email) = :email', { email: normalizeEmail(email) })
      .orderBy('u.id', 'ASC')
      .getMany();
  }

  /**
   * Atualiza somente os campos enviados. O perfil já chega autorizado pelo controller.
   * Rebaixar o último ADMIN ativo → 400.
   */
  async update(id: number, updateUserDto: UpdateUserDto): Promise<User> {
    const user = await this.findOne(id);

    const data: Partial<User> = {};
    if (updateUserDto.name !== undefined) data.name = updateUserDto.name;
    // null (o DTO converte texto vazio em null) remove o telefone
    if (updateUserDto.phone !== undefined) data.phone = updateUserDto.phone;
    if (updateUserDto.role !== undefined) data.role = updateUserDto.role;
    // Sem avatar (undefined) mantém a foto atual
    if (updateUserDto.avatar !== undefined) data.avatar = updateUserDto.avatar;

    if (updateUserDto.email !== undefined) {
      data.email = normalizeEmail(updateUserDto.email);
      await this.assertEmailAvailable(data.email, id);
    }

    // Nova senha é sempre gravada como hash
    if (updateUserDto.password) {
      data.password_hash = await bcrypt.hash(
        updateUserDto.password,
        SALT_ROUNDS,
      );
    }

    if (Object.keys(data).length > 0) {
      try {
        await this.keepingAnAdmin(user, data.role ?? user.role, (users) =>
          users.update(id, data),
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictException(EMAIL_TAKEN);
        }
        throw error;
      }
    }

    return this.findOne(id);
  }

  // Buscar Usuários na Lixeira
  findDeleted() {
    return this.usersRepository.find({
      withDeleted: true,
      where: { deleted_at: Not(IsNull()) },
      order: { deleted_at: 'DESC' },
    });
  }

  /**
   * Exclusão lógica (vai para a lixeira). O token da conta deixa de valer na hora.
   * O último ADMIN ativo não pode ir para a lixeira (400).
   */
  async remove(id: number) {
    const user = await this.findOne(id);
    await this.keepingAnAdmin(user, null, (users) => users.softDelete(id));
    return { message: 'Usuário removido.' };
  }

  async restore(id: number): Promise<User> {
    const user = await this.usersRepository.findOne({
      where: { id },
      withDeleted: true,
    });
    if (!user) throw new NotFoundException(USER_NOT_FOUND);

    if (user.deleted_at) await this.usersRepository.restore(id);
    return this.findOne(id);
  }

  /**
   * Exclusão definitiva. Contas com pedidos não podem ser apagadas (o histórico precisa delas).
   * O último ADMIN ativo também não (400).
   */
  async hardDelete(id: number) {
    const user = await this.usersRepository.findOne({
      where: { id },
      withDeleted: true,
    });
    if (!user) throw new NotFoundException(USER_NOT_FOUND);

    try {
      await this.keepingAnAdmin(user, null, (users) => users.delete(id));
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new ConflictException(
          'Não é possível excluir definitivamente: o usuário possui pedidos vinculados.',
        );
      }
      throw error;
    }
    return { message: 'Usuário excluído definitivamente.' };
  }

  /**
   * Executa a alteração garantindo que continue existindo pelo menos um ADMIN ativo.
   * Quando a operação tira um ADMIN do grupo (rebaixamento, lixeira ou exclusão definitiva), os
   * ADMINs ativos ficam travados (SELECT ... FOR UPDATE) até o fim da transação: duas operações
   * simultâneas (ex.: dois administradores excluindo um ao outro) não deixam o sistema sem ADMIN.
   */
  private async keepingAnAdmin<T>(
    target: User,
    nextRole: UserRole | null,
    action: (users: Repository<User>) => Promise<T>,
  ): Promise<T> {
    if (!removesActiveAdmin(target, nextRole)) {
      return action(this.usersRepository);
    }

    return this.usersRepository.manager.transaction(async (manager) => {
      const users = manager.getRepository(User);
      const admins = await users
        .createQueryBuilder('u')
        .select('u.id')
        .where('u.role = :role', { role: UserRole.ADMIN })
        .setLock('pessimistic_write')
        .getMany(); // a lixeira (deleted_at) fica de fora automaticamente
      assertKeepsAnAdmin(
        target,
        nextRole,
        admins.map((admin) => admin.id),
      );
      return action(users);
    });
  }

  /** 409 se outra conta (inclusive na lixeira) já usa o e-mail, sem diferenciar maiúsculas. */
  private async assertEmailAvailable(email: string, ignoreId?: number) {
    const taken = await this.usersRepository.exists({
      where: {
        email: emailEquals(email),
        ...(ignoreId !== undefined ? { id: Not(ignoreId) } : {}),
      },
      withDeleted: true,
    });
    if (taken) throw new ConflictException(EMAIL_TAKEN);
  }
}
