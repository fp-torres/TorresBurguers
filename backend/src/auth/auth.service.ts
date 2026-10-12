import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { PublicUser, toPublicUser } from '../users/public-user';
import { JwtPayload } from './auth-user';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * Confere e-mail (sem diferenciar maiúsculas) e senha.
   * Retorna o usuário SEM o hash da senha, ou null se as credenciais não conferem.
   */
  async validateUser(
    email: string,
    password: string,
  ): Promise<PublicUser | null> {
    const candidates = await this.usersService.findForLogin(email);

    for (const user of candidates) {
      if (
        user.password_hash &&
        (await bcrypt.compare(password, user.password_hash))
      ) {
        return toPublicUser(user);
      }
    }

    return null;
  }

  login(user: PublicUser) {
    // O que vai dentro do JWT
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
    };

    return {
      access_token: this.jwtService.sign(payload),
      user, // dados do usuário (sem senha) para o front-end guardar a sessão
    };
  }
}
