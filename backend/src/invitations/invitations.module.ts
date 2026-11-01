import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SessionModule } from '../auth/session.module';
import { Store } from '../store/entities/store.entity';
import { User } from '../users/entities/user.entity';
import { UsersModule } from '../users/users.module';
import { Invitation } from './entities/invitation.entity';
import {
  InvitationsController,
  StoreInvitationsController,
} from './invitations.controller';
import { InvitationsService } from './invitations.service';

/**
 * Convites para a equipe de uma loja: criação pelo ADMIN da loja (/store/invitations) e pelo
 * superpainel (InvitationsService exportado), aceite público (/invitations/:token).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Invitation, Store, User]),
    UsersModule,
    // Aceitar o convite já devolve a sessão (access_token)
    SessionModule,
  ],
  controllers: [InvitationsController, StoreInvitationsController],
  providers: [InvitationsService],
  exports: [InvitationsService],
})
export class InvitationsModule {}
