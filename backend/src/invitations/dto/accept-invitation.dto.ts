import { PickType } from '@nestjs/swagger';
import { CreateUserDto } from '../../users/dto/create-user.dto';

/**
 * POST /invitations/:token/accept: dados da conta nova, com as mesmas regras do cadastro
 * (nome, senha e telefone opcional). O e-mail, a loja e o perfil vêm do convite.
 */
export class AcceptInvitationDto extends PickType(CreateUserDto, [
  'name',
  'password',
  'phone',
] as const) {}
