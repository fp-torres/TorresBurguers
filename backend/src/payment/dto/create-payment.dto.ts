import {
  IsDefined,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { QuoteOrderDto } from '../../orders/dto/create-order.dto';
import { IDEMPOTENCY_KEY_PATTERN } from '../payment-rules';

const onlyDigits = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.replace(/\D/g, '') : value;

/**
 * O valor cobrado NUNCA vem do cliente: o servidor calcula a partir de "order"
 * (mesmo corpo e mesmas validações de POST /orders/quote).
 */
export class CreatePixPaymentDto {
  @ApiProperty({ type: QuoteOrderDto })
  @IsDefined({ message: 'order é obrigatório.' })
  @IsObject({ message: 'order deve ser um objeto.' })
  @ValidateNested()
  @Type(() => QuoteOrderDto)
  order: QuoteOrderDto;

  @ApiProperty({
    required: false,
    example: '3f0e7a52-8c1d-4f7b-9a0e-1b2c3d4e5f60',
    description:
      'Chave da tentativa de pagamento (uuid), repetida nas novas tentativas: a mesma chave do mesmo cliente devolve o mesmo pagamento e nunca cobra duas vezes.',
  })
  @IsOptional()
  @IsString({ message: 'idempotencyKey inválido.' })
  @Matches(IDEMPOTENCY_KEY_PATTERN, { message: 'idempotencyKey inválido.' })
  idempotencyKey?: string;
}

export class CreateCardPaymentDto extends CreatePixPaymentDto {
  @ApiProperty({
    description:
      'Token do cartão gerado pelo SDK do Mercado Pago (nunca o número do cartão).',
  })
  @IsString()
  @IsNotEmpty({ message: 'token é obrigatório.' })
  @MaxLength(255)
  token: string;

  @ApiProperty({
    example: 'master',
    description:
      'Bandeira no Mercado Pago (visa, master, elo, amex, debvisa, ...).',
  })
  @IsString()
  @Matches(/^[a-z_]{2,30}$/, { message: 'paymentMethodId inválido.' })
  paymentMethodId: string;

  @ApiProperty({ required: false, minimum: 1, maximum: 12 })
  @IsOptional()
  @IsInt({ message: 'installments deve ser um número inteiro.' })
  @Min(1)
  @Max(12)
  installments?: number;

  @ApiProperty({
    description: 'CPF (11 dígitos) ou CNPJ (14) do titular; máscara é aceita.',
  })
  @Transform(onlyDigits)
  @IsString()
  @Matches(/^(\d{11}|\d{14})$/, {
    message: 'docNumber deve ser um CPF (11 dígitos) ou CNPJ (14 dígitos).',
  })
  docNumber: string;

  @ApiProperty({ required: false, enum: ['CPF', 'CNPJ'] })
  @IsOptional()
  @IsIn(['CPF', 'CNPJ'], { message: 'docType deve ser CPF ou CNPJ.' })
  docType?: string;

  @ApiProperty({
    required: false,
    description: 'E-mail do pagador (padrão: e-mail da conta).',
  })
  @IsOptional()
  @IsEmail({}, { message: 'email inválido.' })
  email?: string;
}
