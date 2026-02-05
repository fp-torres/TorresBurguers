import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService) {
    super({
      // 1. Onde procurar o token? No cabeçalho Authorization: Bearer <token>
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // 2. CORREÇÃO AQUI: Adicionamos "|| ''" para garantir que nunca seja undefined
      secretOrKey: configService.get('JWT_SECRET') || 'chave-secreta-padrao',
    });
  }

  // 3. Validação do payload do token
  async validate(payload: any) {
    return { id: payload.sub, email: payload.email, role: payload.role };
  }
}