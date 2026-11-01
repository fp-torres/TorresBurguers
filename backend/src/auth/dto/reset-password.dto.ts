import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import {
  PASSWORD_API_DESCRIPTION,
  PasswordRules,
} from '../../users/dto/create-user.dto';

export class ResetPasswordDto {
  @ApiProperty({
    description: 'Código do link recebido (/redefinir-senha/<token>)',
  })
  @IsString({ message: 'Link de redefinição inválido.' })
  @IsNotEmpty({ message: 'Link de redefinição inválido.' })
  @MaxLength(200, { message: 'Link de redefinição inválido.' })
  token: string;

  @ApiProperty({
    example: 'NovaSenha#2026',
    minLength: 9,
    description: PASSWORD_API_DESCRIPTION,
  })
  @PasswordRules()
  password: string;
}
