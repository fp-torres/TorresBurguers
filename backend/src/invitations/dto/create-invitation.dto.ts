import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  MaxLength,
} from 'class-validator';
import { toBoolean } from '../../common/transforms';
import { NormalizeEmail } from '../../users/dto/transforms';
import { UserRole } from '../../users/entities/user.entity';
import { STAFF_ROLES } from '../../users/users.policy';

/** POST /store/invitations: convite do ADMIN para a equipe da PRÓPRIA loja (a loja vem do token). */
export class CreateStoreInvitationDto {
  @ApiProperty({ example: 'atendente@email.com' })
  @NormalizeEmail()
  @IsEmail({}, { message: 'Informe um e-mail válido' })
  @MaxLength(160, { message: 'O e-mail pode ter no máximo 160 caracteres' })
  email: string;

  @ApiProperty({ enum: STAFF_ROLES, example: UserRole.EMPLOYEE })
  @IsIn(STAFF_ROLES, {
    message:
      'Perfil inválido. Use ADMIN, EMPLOYEE, KITCHEN ou COURIER (clientes não são convidados).',
  })
  role: UserRole;
}

/**
 * Convite feito pelo superpainel (POST /platform/stores/:id/invitations): pode tornar o convidado o
 * responsável principal da loja (stores.owner_user_id) ao aceitar.
 */
export class CreateInvitationDto extends CreateStoreInvitationDto {
  @ApiPropertyOptional({ default: false })
  @Transform(({ value }) => toBoolean(value))
  @IsOptional()
  @IsBoolean({ message: 'make_owner deve ser verdadeiro ou falso' })
  make_owner?: boolean;
}
