import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';
import { NormalizeEmail } from '../../users/dto/transforms';

export class ForgotPasswordDto {
  @ApiProperty({ example: 'maria@email.com' })
  @NormalizeEmail() // como no login: sem espaços e em minúsculas
  @IsEmail({}, { message: 'Informe um e-mail válido' })
  email: string;
}
