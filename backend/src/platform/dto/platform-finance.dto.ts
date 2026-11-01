import { ApiPropertyOptional } from '@nestjs/swagger';
import { OptionalQueryDate } from './platform-validators';

/**
 * GET /platform/finance?from=AAAA-MM-DD&to=AAAA-MM-DD (calendário da plataforma). Padrão: os últimos
 * 12 meses do calendário (do dia 1º de 11 meses atrás até hoje). Máximo: 3 anos.
 */
export class FinanceQueryDto {
  @ApiPropertyOptional({ example: '2025-11-01' })
  @OptionalQueryDate('from')
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-31' })
  @OptionalQueryDate('to')
  to?: string;
}
