import { IsEmail, IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { NormalizeEmail } from '../../users/dto/transforms';

export class LoginDto {
  @ApiProperty({ example: 'maria@email.com' })
  @NormalizeEmail() // sem espaços e em minúsculas: o login não diferencia maiúsculas
  @IsEmail({}, { message: 'Informe um e-mail válido' })
  email: string;

  @ApiProperty({ example: 'SenhaForte123!' })
  @IsString({ message: 'A senha deve ser um texto' })
  @IsNotEmpty({ message: 'Informe a senha' })
  password: string;
}
