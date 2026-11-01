import { Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  jwtModuleOptions,
  SessionJwtService,
  SessionTokenService,
} from './session-token.service';

/**
 * Assinatura dos tokens de sessão, sem depender do AuthModule: assim UsersModule (troca da própria
 * senha/e-mail) e InvitationsModule (aceite) emitem tokens sem import circular com o AuthModule.
 * Validade: JWT_EXPIRES_IN (padrão 7d).
 *
 * O JwtService exportado é o SessionJwtService: todo token de sessão assinado numa requisição ganha
 * "jti" e uma sessão em auth_sessions (gravada pelo SessionIssuanceInterceptor do AuthModule antes da
 * resposta), inclusive o da sessão de suporte, assinado pelo superpainel.
 */
@Module({
  providers: [
    {
      provide: JwtService,
      useFactory: () => new SessionJwtService(jwtModuleOptions()),
    },
    SessionTokenService,
  ],
  exports: [SessionTokenService, JwtService],
})
export class SessionModule {}
