import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthService } from './auth.service';
import { AuthSessionsService } from './auth-sessions.service';
import { SessionIssuanceInterceptor } from './session-issuance.interceptor';
import { SupportSessionReadOnlyInterceptor } from './support-session-read-only.interceptor';
import { AuthController } from './auth.controller';
import { UsersModule } from '../users/users.module';
import { User } from '../users/entities/user.entity';
import { JwtStrategy } from './jwt.strategy';
import { SupportSession } from '../platform/entities/support-session.entity';
import { PasswordResetToken } from './entities/password-reset-token.entity';
import { PasswordResetService } from './password-reset.service';
import { SessionModule } from './session.module';
import { WebSessionController } from './web-session.controller';
import { WebSessionService } from './web-session.service';

@Module({
  imports: [
    UsersModule,
    // Assinatura dos tokens (mesmo segredo da JwtStrategy): SessionTokenService + JwtService
    SessionModule,
    // JwtStrategy confere as sessões de acesso assistido do suporte; redefinição de senha. As sessões de
    // acesso (auth_sessions) usam o EntityManager desta conexão (ver AuthSessionsService)
    TypeOrmModule.forFeature([SupportSession, PasswordResetToken, User]),
  ],
  // WebSessionController: sessão do site em cookie (/auth/web/refresh e /auth/web/logout)
  controllers: [AuthController, WebSessionController],
  providers: [
    AuthService,
    AuthSessionsService,
    PasswordResetService,
    WebSessionService,
    JwtStrategy,
    // Sessão (auth_sessions) de todo token emitido numa requisição, gravada antes da resposta
    { provide: APP_INTERCEPTOR, useClass: SessionIssuanceInterceptor },
    // Sessão de suporte somente leitura em TODA a API (não só no painel da loja e em /users)
    { provide: APP_INTERCEPTOR, useClass: SupportSessionReadOnlyInterceptor },
  ],
  // SessionModule reexporta o JwtService (SessionJwtService) e o SessionTokenService para quem importar o
  // AuthModule (ex.: superpainel emitindo o token de uma sessão de suporte)
  exports: [AuthService, PasswordResetService, SessionModule],
})
export class AuthModule {}
