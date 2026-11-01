import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { toBoolean, trimString } from '../../common/transforms';
import { IsText } from '../../common/validators';
import { CUSTOMER_BLOCK_REASON_MAX_LENGTH } from '../entities/store-customer-block.entity';
import { StoreListQueryDto } from './store-list-query.dto';

/** GET /store/customers: busca e páginas (StoreListQueryDto) + ?blocked=true|false. */
export class StoreCustomersQueryDto extends StoreListQueryDto {
  @ApiPropertyOptional({
    example: true,
    description:
      'true: só os clientes bloqueados nesta loja; false: só os não bloqueados; omitido: todos.',
  })
  @Transform(({ value }) => toBoolean(value))
  @IsOptional()
  @IsBoolean({ message: 'blocked deve ser true ou false.' })
  blocked?: boolean;
}

/** POST /store/customers/:userId/block. */
export class BlockCustomerDto {
  @ApiProperty({
    example: 'Três pedidos falsos em outubro (endereço inexistente).',
    maxLength: CUSTOMER_BLOCK_REASON_MAX_LENGTH,
  })
  @Transform(({ value }) => trimString(value))
  @IsText({
    maxLength: CUSTOMER_BLOCK_REASON_MAX_LENGTH,
    required:
      'Informe o motivo do bloqueio (ele fica registrado para a equipe da loja e na auditoria).',
    invalid: 'O motivo deve ser um texto.',
    tooLong: `O motivo pode ter no máximo ${CUSTOMER_BLOCK_REASON_MAX_LENGTH} caracteres.`,
  })
  reason: string;
}
