import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { jwtSecret } from '../config/jwt';
import { AuthUser, JwtPayload } from './auth-user';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly usersService: UsersService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // Mesmo segredo usado na assinatura (AuthModule) — fonte única em config/jwt.ts
      secretOrKey: jwtSecret(),
    });
  }

  /**
   * Recarrega o usuário a cada requisição:
   * - conta inexistente ou excluída (lixeira) → 401, mesmo com token ainda válido;
   * - o perfil devolvido é o ATUAL do banco (mudanças de perfil valem na hora).
   */
  async validate(payload: Partial<JwtPayload>): Promise<AuthUser> {
    const id = Number(payload?.sub);
    const user =
      Number.isInteger(id) && id > 0
        ? await this.usersService.findActiveById(id)
        : null;

    if (!user) {
      throw new UnauthorizedException(
        'Sessão inválida ou expirada. Faça login novamente.',
      );
    }

    return { id: user.id, email: user.email, role: user.role, name: user.name };
  }
}
