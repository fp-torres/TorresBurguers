import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { CreateUserDto, PhoneRules } from './create-user.dto';
import { EmptyToNull } from './transforms';

// Todos os campos do cadastro, opcionais e com as mesmas validações/transformações
// (avatar = URL da foto ou identificador do ícone; "role" só pode ser alterado por ADMIN).
// Exceção: no telefone, texto vazio ou null REMOVE o número (no cadastro, vazio = não informado).
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
}
