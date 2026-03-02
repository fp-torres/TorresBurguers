import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, Not } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './entities/user.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
  ) {}

  async create(createUserDto: CreateUserDto) {
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(createUserDto.password, saltRounds);

    const newUser = this.usersRepository.create({
      ...createUserDto,
      password_hash: passwordHash,
    });

    // Removemos o campo password cru do objeto antes de salvar (segurança)
    delete (newUser as any).password;

    return this.usersRepository.save(newUser);
  }

  findAll() {
    return this.usersRepository.find({ 
      order: { created_at: 'DESC' } 
    });
  }

  findOne(id: number) {
    return this.usersRepository.findOneBy({ id });
  }

  // ⚠️ IMPORTANTE: Essa é a função usada pelo Login
  async findOneByEmail(email: string) {
    return this.usersRepository.findOne({ 
      where: { email }
      // DICA: Se na sua Entity o password_hash estiver como { select: false },
      // você precisaria adicionar: select: ['id', 'email', 'password_hash', 'role', 'name']
    });
  }

  async update(id: number, updateUserDto: UpdateUserDto) {
    const user = await this.findOne(id);
    if (!user) throw new NotFoundException('Usuário não encontrado');

    const updateData: any = { ...updateUserDto };

    // Se o usuário mandou uma nova senha, criptografa ela
    if (updateUserDto.password) {
      const saltRounds = 10;
      updateData.password_hash = await bcrypt.hash(updateUserDto.password, saltRounds);
      delete updateData.password; 
    }

    // Se não mandou avatar (undefined), deletamos a chave para não apagar a foto atual
    if (updateData.avatar === undefined) {
      delete updateData.avatar;
    }

    await this.usersRepository.update(id, updateData);
    
    return this.findOne(id);
  }

  // Buscar Usuários na Lixeira
  findDeleted() {
    return this.usersRepository.find({
      withDeleted: true,
      where: { deleted_at: Not(IsNull()) },
      order: { deleted_at: 'DESC' }
    });
  }

  remove(id: number) {
    return this.usersRepository.softDelete(id);
  }

  restore(id: number) {
    return this.usersRepository.restore(id);
  }

  hardDelete(id: number) {
    return this.usersRepository.delete(id);
  }
}