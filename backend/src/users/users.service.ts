import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt'; // <--- Importe o bcrypt
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
    // 1. Gera o Hash da senha (O '10' é o custo do processamento, padrão de mercado)
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(createUserDto.password, saltRounds); //

    // 2. Cria o usuário com a senha criptografada
    const newUser = this.usersRepository.create({
      name: createUserDto.name,
      email: createUserDto.email,
      role: createUserDto.role,
      password_hash: passwordHash, // <--- Salvamos o hash, não a senha pura
    });

    // 3. Salva no banco e retorna (O TypeORM remove a senha do retorno se configurado, mas vamos garantir depois)
    return this.usersRepository.save(newUser);
  }

  // ... (mantenha os outros métodos findAll, findOne, etc como estavam)
  findAll() {
    return this.usersRepository.find();
  }

  findOne(id: number) {
    return this.usersRepository.findOneBy({ id });
  }

  update(id: number, updateUserDto: UpdateUserDto) {
    return this.usersRepository.update(id, updateUserDto);
  }

  remove(id: number) {
    return this.usersRepository.delete(id);
  }
}