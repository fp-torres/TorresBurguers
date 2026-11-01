import { Logger, Module, type OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SessionModule } from '../auth/session.module';
import { MailService } from '../notifications/mail.service';
import { User } from '../users/entities/user.entity';
import { UsersModule } from '../users/users.module';
import { AccountCoreModule } from './account-core.module';
import { AccountSecurityService } from './account-security.service';
import { accountSecurityModeWarnings } from './account-security-mode';
import { AccountController } from './account.controller';

/**
 * Rotas /account (segurança da própria conta). Importa o UsersModule (que traz o AccountCoreModule:
 * links e avisos) e o SessionModule (token novo na troca de senha, o mesmo do login). AuditService,
 * MailService e RateLimitService são globais.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    UsersModule,
    SessionModule,
    AccountCoreModule,
  ],
  controllers: [AccountController],
  providers: [AccountSecurityService],
})
export class AccountModule implements OnModuleInit {
  private readonly logger = new Logger(AccountModule.name);

  constructor(private readonly mail: MailService) {}

  /** Avisos do ACCOUNT_SECURITY_MODE na subida (fora do env.ts, cujas listas de avisos são exatas). */
  onModuleInit(): void {
    for (const warning of accountSecurityModeWarnings(
      process.env,
      this.mail.configured,
    )) {
      this.logger.warn(warning);
    }
  }
}
