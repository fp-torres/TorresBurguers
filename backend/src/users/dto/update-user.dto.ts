import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CreateUserDto, PhoneRules } from './create-user.dto';
import { EmptyToNull, EmptyToUndefined } from './transforms';

// Todos os campos do cadastro, opcionais e com as mesmas validações/transformações
// (avatar = um dos ícones prontos; foto própria vai no campo "file"; "role" só pode ser alterado
// por ADMIN). Exceção: no telefone, texto vazio ou null REMOVE o número (no cadastro, vazio = não
// informado).
export class UpdateUserDto extends PartialType(
  OmitType(CreateUserDto, ['phone'] as const),
) {
  @ApiPropertyOptional({
    example: '21999999999',
    nullable: true,
    description: 'Texto vazio ou null remove o telefone',
  })
  @EmptyToNull()
  @PhoneRules()
  phone?: string | null;

  @ApiPropertyOptional({
    example: 'SenhaAtual@123',
    description:
      'Senha atual, para trocar o próprio e-mail ou a própria senha. Conferida quando enviada ' +
      '(errada → 400); obrigatória para as contas da plataforma.',
  })
  @EmptyToUndefined()
  @IsOptional()
  @IsString({ message: 'A senha atual deve ser um texto' })
  @MaxLength(200, {
    message: 'A senha atual pode ter no máximo 200 caracteres',
  })
  current_password?: string;
}
