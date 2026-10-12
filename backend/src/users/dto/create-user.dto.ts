import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
  Matches,
  MaxLength,
} from 'class-validator';
import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MaxUtf8Bytes } from '../../common/validators';
import { UserRole } from '../entities/user.entity';
import { EmptyToUndefined, NormalizeEmail, Trim } from './transforms';

/** O bcrypt só considera os primeiros 72 bytes da senha: o resto seria ignorado no login. */
export const MAX_PASSWORD_BYTES = 72;

/** Regras do telefone (opcional), iguais no cadastro e na edição. */
export const PhoneRules = () =>
  applyDecorators(
    IsOptional(),
    IsString({ message: 'O telefone deve ser um texto' }),
    MinLength(10, {
      message: 'O telefone deve ter pelo menos 10 dígitos (DDD + Número)',
    }),
    MaxLength(20, { message: 'O telefone pode ter no máximo 20 caracteres' }),
  );

export class CreateUserDto {
  @ApiProperty({ example: 'Maria Silva', maxLength: 50 })
  @Trim()
  @IsString({ message: 'O nome deve ser um texto' })
  @IsNotEmpty({ message: 'O nome é obrigatório' })
  @MaxLength(50, { message: 'O nome pode ter no máximo 50 caracteres' })
  name: string;

  @ApiProperty({
    example: 'maria@email.com',
    description: 'Gravado sem espaços e em minúsculas',
  })
  @NormalizeEmail()
  @IsEmail({}, { message: 'Email inválido' })
  email: string;

  @ApiPropertyOptional({
    example: '21999999999',
    description: 'Texto vazio é tratado como não informado',
  })
  @EmptyToUndefined()
  @PhoneRules()
  phone?: string;

  @ApiPropertyOptional({
    example: '/uploads/avatar.webp',
    description:
      'URL da foto ou do avatar escolhido. Para enviar uma imagem use o campo "file" (multipart).',
  })
  @EmptyToUndefined()
  @IsOptional()
  @IsString({ message: 'O avatar deve ser um texto' })
  @MaxLength(500, { message: 'O avatar pode ter no máximo 500 caracteres' })
  avatar?: string;

  @ApiProperty({
    example: 'SenhaForte123!',
    minLength: 9,
    description: `De 9 a ${MAX_PASSWORD_BYTES} bytes (letras acentuadas ocupam 2 bytes; emojis, 4)`,
  })
  @IsString()
  @MinLength(9, { message: 'A senha deve ter no mínimo 9 caracteres' })
  @MaxUtf8Bytes(MAX_PASSWORD_BYTES, {
    message: `A senha pode ter no máximo ${MAX_PASSWORD_BYTES} caracteres (letras acentuadas e emojis contam como 2 ou mais).`,
  })
  // Regex: Pelo menos 1 maiúscula, E (1 número OU 1 símbolo)
  @Matches(/((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z]).*$/, {
    message:
      'A senha deve conter pelo menos uma letra maiúscula e um número ou símbolo.',
  })
  password: string;

  @ApiPropertyOptional({
    enum: UserRole,
    default: UserRole.CLIENT,
    description:
      'Sem perfil (ou CLIENT) cria um cliente. Os demais perfis exigem token de ADMIN.',
  })
  @EmptyToUndefined()
  @IsOptional()
  @IsEnum(UserRole, { message: 'Perfil de acesso inválido' })
  role?: UserRole;
}
