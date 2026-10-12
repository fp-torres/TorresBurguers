import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { emptyToNull, toBoolean } from '../../common/transforms';
import { IsOptionalNotNull, IsText } from '../../common/validators';

/**
 * Atualização do status da loja: envie só o que mudou.
 * Mensagens vazias ou null limpam o texto exibido na vitrine.
 */
export class UpdateStoreDto {
  @ApiPropertyOptional({
    example: true,
    description: 'Loja aberta para pedidos?',
  })
  @Transform(({ value }) => toBoolean(value))
  @IsOptionalNotNull()
  @IsBoolean({ message: 'is_open deve ser verdadeiro ou falso.' })
  is_open?: boolean;

  @ApiPropertyOptional({
    example: 'Bem-vindo! Peça já o seu.',
    nullable: true,
    maxLength: 200,
  })
  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @IsText({
    maxLength: 200,
    invalid: 'A mensagem de loja aberta deve ser um texto.',
    tooLong: 'A mensagem de loja aberta pode ter no máximo 200 caracteres.',
  })
  opening_message?: string | null;

  @ApiPropertyOptional({
    example: 'Voltamos amanhã às 18h.',
    nullable: true,
    maxLength: 200,
  })
  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @IsText({
    maxLength: 200,
    invalid: 'A mensagem de loja fechada deve ser um texto.',
    tooLong: 'A mensagem de loja fechada pode ter no máximo 200 caracteres.',
  })
  closing_message?: string | null;
}
