import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { trimString } from '../../common/transforms';
import { IsText } from '../../common/validators';
import { MERCADO_PAGO_CREDENTIAL_PATTERN } from '../store-rules';

/**
 * PUT /store/settings/payments (ADMIN): credenciais da conta Mercado Pago da própria loja.
 * O Access Token é só de escrita: é gravado cifrado e nunca volta nas respostas.
 * As mensagens de erro nunca repetem o valor enviado.
 */
export class StorePaymentCredentialsDto {
  @ApiProperty({
    example: 'APP_USR-5a6b2c43-1e71-4b0e-9b5a-0a1b2c3d4e5f',
    maxLength: 120,
    description: 'Chave pública (Public Key) da conta Mercado Pago da loja.',
  })
  @Transform(({ value }) => trimString(value))
  @IsText({
    maxLength: 120,
    pattern: MERCADO_PAGO_CREDENTIAL_PATTERN,
    required: 'Informe a chave pública (Public Key) do Mercado Pago.',
    invalid:
      'Chave pública inválida: ela começa com APP_USR- (produção) ou TEST- (teste).',
    tooLong: 'A chave pública pode ter no máximo 120 caracteres.',
  })
  mp_public_key: string;

  @ApiProperty({
    example: 'APP_USR-1234567890123456-101112-abcdef0123456789-123456789',
    maxLength: 255,
    writeOnly: true,
    description: 'Access Token da conta Mercado Pago da loja (só de escrita).',
  })
  @Transform(({ value }) => trimString(value))
  @IsText({
    maxLength: 255,
    pattern: MERCADO_PAGO_CREDENTIAL_PATTERN,
    required: 'Informe o Access Token do Mercado Pago.',
    invalid:
      'Access Token inválido: ele começa com APP_USR- (produção) ou TEST- (teste).',
    tooLong: 'O Access Token pode ter no máximo 255 caracteres.',
  })
  mp_access_token: string;
}
