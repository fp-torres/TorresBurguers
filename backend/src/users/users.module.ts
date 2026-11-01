import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountCoreModule } from '../account/account-core.module';
import { SessionModule } from '../auth/session.module';
import { Invitation } from '../invitations/entities/invitation.entity';
import { Store } from '../store/entities/store.entity';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { User } from './entities/user.entity';

@Module({
  imports: [
    // Store: resumo da loja exibido na sessão (ver session-user.ts) e o responsável (owner_user_id).
    // Invitation: convites pendentes de quem perde o direito de convidar são cancelados
    TypeOrmModule.forFeature([User, Store, Invitation]),
    // Token novo para quem troca a própria senha/e-mail (as outras sessões são encerradas)
    SessionModule,
    // Verificação de e-mail: reserva do endereço antigo, links e avisos da troca pela rota antiga
    AccountCoreModule,
  ],
  controllers: [UsersController],
  providers: [UsersService],
  // AuthModule (login/JwtStrategy), convites e superpainel usam o UsersService; o AccountCoreModule
  // segue junto para as rotas /account e a redefinição de senha
  exports: [UsersService, AccountCoreModule],
})
export class UsersModule {}
