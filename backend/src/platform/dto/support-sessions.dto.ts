import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { trimString } from '../../common/transforms';
import { StoreListQueryDto } from '../../store/dto/store-list-query.dto';
import {
  IsTextLength,
  OptionalQueryBoolean,
  OptionalQueryId,
} from './platform-validators';

export const SUPPORT_REASON_MIN_LENGTH = 10;
export const SUPPORT_REASON_MAX_LENGTH = 300;

/** POST /platform/stores/:id/support-sessions: acesso assistido (somente leitura) com motivo. */
export class StartSupportSessionDto {
  @ApiProperty({
    example: 'Chamado 1234: conferir as zonas de entrega com o responsável.',
    minLength: SUPPORT_REASON_MIN_LENGTH,
    maxLength: SUPPORT_REASON_MAX_LENGTH,
  })
  @Transform(({ value }) => trimString(value))
  @IsTextLength({
    min: SUPPORT_REASON_MIN_LENGTH,
    max: SUPPORT_REASON_MAX_LENGTH,
    required: 'Informe o motivo da sessão de suporte.',
    invalid: 'O motivo deve ser um texto.',
    tooShort: `Descreva o motivo com pelo menos ${SUPPORT_REASON_MIN_LENGTH} caracteres.`,
    tooLong: `O motivo pode ter no máximo ${SUPPORT_REASON_MAX_LENGTH} caracteres.`,
  })
  reason: string;
}

/** GET /platform/support-sessions?store_id=&platform_user_id=&active=&page=&pageSize= */
export class SupportSessionListQueryDto extends PickType(StoreListQueryDto, [
  'page',
  'pageSize',
] as const) {
  @ApiPropertyOptional({ example: 7 })
  @OptionalQueryId('store_id')
  store_id?: number;

  @ApiPropertyOptional({
    example: 1,
    description: 'Superadmin que abriu a sessão.',
  })
  @OptionalQueryId('platform_user_id')
  platform_user_id?: number;

  @ApiPropertyOptional({
    description:
      'true = abertas e dentro do prazo; false = encerradas ou expiradas.',
  })
  @OptionalQueryBoolean('active')
  active?: boolean;
}
