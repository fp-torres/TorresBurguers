import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';
import { emptyToNull, toNumber } from '../../common/transforms';
import { IsNumberInRange } from '../../common/validators';
import { INVITATION_STATUSES, type InvitationStatus } from '../invitation-view';

export const MAX_PAGE_SIZE = 100;

/** ?page=1&pageSize=20 (máx. 100) e filtro opcional por situação. */
export class ListInvitationsQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Transform(({ value }) => toNumber(value))
  @IsOptional()
  @IsNumberInRange({
    min: 1,
    max: 1_000_000,
    integer: true,
    invalid: 'Página inválida.',
  })
  page?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: MAX_PAGE_SIZE })
  @Transform(({ value }) => toNumber(value))
  @IsOptional()
  @IsNumberInRange({
    min: 1,
    max: MAX_PAGE_SIZE,
    integer: true,
    invalid: `Tamanho de página inválido (1 a ${MAX_PAGE_SIZE}).`,
  })
  pageSize?: number;

  @ApiPropertyOptional({ enum: INVITATION_STATUSES })
  // Como os outros filtros: vazio = sem filtro; maiúsculas ou minúsculas (?status=pending)
  @Transform(({ value }) => {
    const text = emptyToNull(value);
    return typeof text === 'string' ? text.toUpperCase() : (text ?? undefined);
  })
  @IsOptional()
  @IsIn(INVITATION_STATUSES, {
    message: `Situação inválida. Use ${INVITATION_STATUSES.join(', ')}.`,
  })
  status?: InvitationStatus;
}
