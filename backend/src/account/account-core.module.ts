import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { AccountEmailTokensService } from './account-email-tokens.service';
import { AccountNoticesService } from './account-notices.service';
import { AccountEmailToken } from './entities/account-email-token.entity';

/**
 * Base da verificação de e-mail, sem controller e sem depender do UsersModule: os links (tokens) e os
 * avisos por e-mail. Importado pelo UsersModule (reserva do e-mail antigo, troca pela rota antiga,
 * verificação do cadastro) e pelo AccountModule (rotas /account), sem import circular.
 * MailService e RateLimitService vêm do SharedModule (global).
 */
@Module({
  imports: [TypeOrmModule.forFeature([AccountEmailToken, User])],
  providers: [AccountEmailTokensService, AccountNoticesService],
  exports: [AccountEmailTokensService, AccountNoticesService],
})
export class AccountCoreModule {}
