import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsersModule } from '../users/users.module';
import { JwtStrategy } from './jwt.strategy';
import { jwtExpiresIn, jwtSecret } from '../config/jwt';

@Module({
  imports: [
    UsersModule,
    // Assinatura dos tokens: mesmo segredo da verificação (JwtStrategy). Validade: JWT_EXPIRES_IN (padrão 7d)
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: jwtSecret(),
        signOptions: { expiresIn: jwtExpiresIn() },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
})
export class AuthModule {}
