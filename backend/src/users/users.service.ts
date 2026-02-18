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

  async findOneByEmail(email: string) {
    return this.usersRepository.findOneBy({ email });
  }

  async create(createUserDto: CreateUserDto) {
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(createUserDto.password, saltRounds);

    const newUser = this.usersRepository.create({
      name: createUserDto.name,
      email: createUserDto.email,
      role: createUserDto.role as any,
      phone: createUserDto.phone, 
      password_hash: passwordHash, 
    });

    return this.usersRepository.save(newUser);
  }

  findAll() {
    return this.usersRepository.find({ order: { created_at: 'DESC' } });
  }

  // Buscar Usuários na Lixeira
  findDeleted() {
    return this.usersRepository.find({
      withDeleted: true,
      where: { deleted_at: Not(IsNull()) },
      order: { deleted_at: 'DESC' }
    });
  }

  findOne(id: number) {
    return this.usersRepository.findOneBy({ id });
  }

  async update(id: number, updateUserDto: UpdateUserDto) {
    const user = await this.findOne(id);
    if (!user) throw new NotFoundException('Usuário não encontrado');

    const updateData: any = { ...updateUserDto };

    // Se houver senha nova, criptografa antes de salvar
    if (updateUserDto.password) {
      const saltRounds = 10;
      updateData.password_hash = await bcrypt.hash(updateUserDto.password, saltRounds);
      delete updateData.password; // Remove o campo password cru
    }

    // Remove campos que não devem ser atualizados diretamente se vierem vazios
    if (!updateData.avatar) delete updateData.avatar;

    await this.usersRepository.update(id, updateData);
    
    // Retorna o usuário atualizado (sem a senha)
    return this.findOne(id);
  }

  // Enviar para Lixeira (Soft Delete)
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