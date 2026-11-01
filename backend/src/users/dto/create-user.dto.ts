import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
  MaxLength,
  ValidateBy,
  ValidationOptions,
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

/** Quebras de linha para o "." das regex do JavaScript (sem a flag s). */
const LINE_TERMINATORS = new Set(['\n', '\r', ' ', ' ']);

/**
 * Pelo menos uma letra maiúscula E um número ou símbolo, com o MESMO resultado da regra antiga
 * (/((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z]).*$/), mas em tempo linear. A regex antiga não era
 * ancorada: numa senha sem número nem símbolo ela custava O(n²) e ~100 KB travavam a API por ~20 s
 * (o class-validator roda todas as regras, inclusive depois do limite de 72 bytes recusar o tamanho).
 * Como na regra antiga, só a última linha conta e os pontos do início dela não contam como símbolo.
 */
export function meetsPasswordComposition(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  let start = value.length;
  while (start > 0 && !LINE_TERMINATORS.has(value[start - 1])) start--;
  while (start < value.length && value[start] === '.') start++;
  const rest = value.slice(start);
  // Uma classe de caracteres cada (sem quantificadores): uma única passada pelo texto
  return /[A-Z]/.test(rest) && /[\d\W]/.test(rest);
}

/** Composição da senha (ver meetsPasswordComposition), sem regex com retrocesso. */
const PasswordComposition = (validationOptions?: ValidationOptions) =>
  ValidateBy(
    {
      name: 'passwordComposition',
      validator: { validate: (value) => meetsPasswordComposition(value) },
    },
    validationOptions,
  );

/**
 * Política de senha, a MESMA no cadastro, na edição, na redefinição e no aceite de convite:
 * 9 a 72 bytes, com pelo menos uma maiúscula e um número ou símbolo.
 * Todas as regras são lineares no tamanho do texto (o corpo JSON pode ter ~100 KB).
 */
export const PasswordRules = () =>
  applyDecorators(
    IsString(),
    MinLength(9, { message: 'A senha deve ter no mínimo 9 caracteres' }),
    MaxUtf8Bytes(MAX_PASSWORD_BYTES, {
      message: `A senha pode ter no máximo ${MAX_PASSWORD_BYTES} caracteres (letras acentuadas e emojis contam como 2 ou mais).`,
    }),
    PasswordComposition({
      message:
        'A senha deve conter pelo menos uma letra maiúscula e um número ou símbolo.',
    }),
  );

export const PASSWORD_API_DESCRIPTION = `De 9 a ${MAX_PASSWORD_BYTES} bytes (letras acentuadas ocupam 2 bytes; emojis, 4), com uma letra maiúscula e um número ou símbolo`;

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
    example: 'https://cdn-icons-png.flaticon.com/512/3075/3075977.png',
    description:
      'Um dos ícones prontos (lista em users/avatar.ts) ou, na edição, o valor atual. ' +
      'Para enviar uma foto própria use o campo "file" (multipart). Outros valores → 400.',
  })
  @EmptyToUndefined()
  @IsOptional()
  @IsString({ message: 'O avatar deve ser um texto' })
  @MaxLength(500, { message: 'O avatar pode ter no máximo 500 caracteres' })
  avatar?: string;

  @ApiProperty({
    example: 'SenhaForte123!',
    minLength: 9,
    description: PASSWORD_API_DESCRIPTION,
  })
  @PasswordRules()
  password: string;

  @ApiPropertyOptional({
    enum: UserRole,
    default: UserRole.CLIENT,
    description:
      'Sem token (ou com token que não é de ADMIN de loja): cadastro de cliente (sem perfil ou CLIENT). ' +
      'Com token de ADMIN da loja: conta da equipe da própria loja (ADMIN, EMPLOYEE, KITCHEN ou COURIER).',
  })
  @EmptyToUndefined()
  @IsOptional()
  @IsEnum(UserRole, { message: 'Perfil de acesso inválido' })
  role?: UserRole;
}
