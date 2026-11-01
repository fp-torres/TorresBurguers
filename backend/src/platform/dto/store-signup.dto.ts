import { ApiProperty, PickType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { Equals, IsDefined, ValidateNested } from 'class-validator';
import { toBoolean, trimString } from '../../common/transforms';
import { IsText } from '../../common/validators';
import { CreateUserDto } from '../../users/dto/create-user.dto';
import { normalizeSlugInput } from '../store-identity-rules';
import { IsNestedObject, IsStoreSlug } from './platform-validators';

/** Estabelecimento do autoatendimento: só o nome e o endereço (o resto o ADMIN configura depois). */
export class SignupStoreDto {
  @ApiProperty({ example: 'Pizzaria São João', maxLength: 120 })
  @Transform(({ value }) => trimString(value))
  @IsText({
    maxLength: 120,
    required: 'Informe o nome do estabelecimento.',
    invalid: 'O nome do estabelecimento deve ser um texto.',
    tooLong: 'O nome do estabelecimento pode ter no máximo 120 caracteres.',
  })
  name: string;

  @ApiProperty({
    example: 'pizzaria-sao-joao',
    description:
      'Endereço da loja (/loja/<slug>): 3 a 60 caracteres, minúsculas, números e hífens, sem hífen nas pontas; endereços reservados são recusados.',
  })
  @Transform(({ value }) => normalizeSlugInput(value))
  @IsStoreSlug()
  slug: string;
}

/** Conta do responsável (ADMIN da loja nova): mesmas regras do cadastro de clientes (nome, e-mail, senha). */
export class SignupOwnerDto extends PickType(CreateUserDto, [
  'name',
  'email',
  'password',
  'phone',
] as const) {}

/**
 * POST /stores/signup (público, quando o autoatendimento está habilitado): cria a loja, a assinatura
 * do plano do autoatendimento e a conta do responsável, e já devolve a sessão { access_token, user }.
 */
export class StoreSignupDto {
  @ApiProperty({ type: () => SignupStoreDto })
  @IsDefined({
    message: 'Informe os dados do estabelecimento (store.name e store.slug).',
  })
  // Lista (inclusive vazia) não é objeto: sem isto o serviço receberia um array (500)
  @IsNestedObject(
    'store deve ser um objeto com os dados do estabelecimento (store.name e store.slug).',
  )
  @ValidateNested()
  @Type(() => SignupStoreDto)
  store: SignupStoreDto;

  @ApiProperty({ type: () => SignupOwnerDto })
  @IsDefined({
    message:
      'Informe os dados do responsável (owner.name, owner.email e owner.password).',
  })
  @IsNestedObject(
    'owner deve ser um objeto com os dados do responsável (owner.name, owner.email e owner.password).',
  )
  @ValidateNested()
  @Type(() => SignupOwnerDto)
  owner: SignupOwnerDto;

  @ApiProperty({
    example: true,
    description: 'Aceite dos termos de uso da plataforma (obrigatório).',
  })
  @Transform(({ value }) => toBoolean(value))
  @Equals(true, {
    message:
      'É preciso aceitar os termos de uso para cadastrar o estabelecimento.',
  })
  accept_terms: boolean;
}
