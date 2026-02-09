import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
      // CORREÇÃO AQUI: Removido "|| null". Deixe apenas a propriedade.
      // Se vier undefined, o TypeORM ignora (fica null no banco se nullable=true)
      phone: createUserDto.phone, 
      password_hash: passwordHash, 
    });

    return this.usersRepository.save(newUser);
  }

  findAll() {
    return this.usersRepository.find({ order: { created_at: 'DESC' } });
  }

  findOne(id: number) {
    return this.usersRepository.findOneBy({ id });
  }

  async update(id: number, updateUserDto: UpdateUserDto) {
    const user = await this.findOne(id);
    if (!user) throw new NotFoundException('Usuário não encontrado');

    if (updateUserDto.password) {
      updateUserDto.password = await bcrypt.hash(updateUserDto.password, 10);
    }
    
    const { password, ...data } = updateUserDto;
    const updateData: any = { ...data };
    
    if (password) {
      updateData.password_hash = password;
    }

    await this.usersRepository.update(id, updateData);
    return this.findOne(id);
  }

  remove(id: number) {
    return this.usersRepository.delete(id);
  }
}