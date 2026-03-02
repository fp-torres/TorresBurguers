import { Injectable, UnauthorizedException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
  ) {}

  async validateUser(email: string, pass: string): Promise<any> {
    // 1. Busca o usuário no banco pelo email
    const user = await this.usersService.findOneByEmail(email);
    
    // 2. Se achou usuário E a senha bate com o hash
    if (user && (await bcrypt.compare(pass, user.password_hash))) {
      // 3. Remove a senha hash para não mandar pro frontend
      const { password_hash, ...result } = user;
      return result;
    }
    
    return null;
  }

  async login(user: any) {
    // Cria o payload do token (o que vai dentro do JWT)
    const payload = { 
      email: user.email, 
      sub: user.id, 
      role: user.role,
      name: user.name 
    };

    return {
      access_token: this.jwtService.sign(payload),
      user: user, // Retorna os dados do usuário para salvar no AsyncStorage do app
    };
  }
}