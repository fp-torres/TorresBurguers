import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import {
  PASSWORD_API_DESCRIPTION,
  PasswordRules,
} from '../../users/dto/create-user.dto';
import { NormalizeEmail } from '../../users/dto/transforms';

/** Senha atual (reautenticação): texto até 200 caracteres; a conferência é no serviço. */
const CurrentPassword = () =>
  applyDecorators(
    IsString({ message: 'Informe a senha atual.' }),
    IsNotEmpty({ message: 'Informe a senha atual.' }),
    MaxLength(200, {
      message: 'A senha atual pode ter no máximo 200 caracteres',
    }),
  );

/** Código de um link recebido por e-mail (a conferência do formato é no serviço: inválido → 404). */
const LinkToken = (message: string) =>
  applyDecorators(
    IsString({ message }),
    IsNotEmpty({ message }),
    MaxLength(200, { message }),
  );

/** POST /account/password */
export class ChangePasswordDto {
  @ApiProperty({ example: 'SenhaAtual@123' })
  @CurrentPassword()
  current_password: string;

  @ApiProperty({
    example: 'NovaSenha#2026',
    minLength: 9,
    description: PASSWORD_API_DESCRIPTION,
  })
  @PasswordRules()
  password: string;
}

/** POST /account/email-change */
export class RequestEmailChangeDto {
  @ApiProperty({
    example: 'novo@email.com',
    description: 'Novo e-mail (gravado sem espaços e em minúsculas)',
  })
  @NormalizeEmail()
  @IsEmail({}, { message: 'Informe um e-mail válido' })
  @MaxLength(160, { message: 'O e-mail pode ter no máximo 160 caracteres' })
  email: string;

  @ApiProperty({ example: 'SenhaAtual@123' })
  @CurrentPassword()
  current_password: string;
}

/** POST /account/email-change/confirm e POST /account/email-verification/confirm */
export class AccountLinkTokenDto {
  @ApiProperty({
    description:
      'Código do link recebido por e-mail (/confirmar-email/<código> ou /verificar-email/<código>)',
  })
  @LinkToken('Link inválido.')
  token: string;
}

/** POST /account/email-revert ("Não fui eu") */
export class RevertEmailChangeDto {
  @ApiProperty({
    description:
      'Código do link "Não fui eu" (/desfazer-troca-de-email/<código>)',
  })
  @LinkToken('Link inválido.')
  token: string;

  @ApiProperty({
    example: 'NovaSenha#2026',
    minLength: 9,
    description: `Nova senha da conta. ${PASSWORD_API_DESCRIPTION}`,
  })
  @PasswordRules()
  password: string;
}
