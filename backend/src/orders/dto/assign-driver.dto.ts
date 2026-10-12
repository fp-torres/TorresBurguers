import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { IsNumberInRange, MAX_DB_INT } from '../../common/validators';

/** PATCH /orders/:id/assign */
export class AssignDriverDto {
  @ApiProperty({ description: 'Id do usuário entregador (perfil COURIER).' })
  @Type(() => Number)
  @IsNumberInRange({
    min: 1,
    max: MAX_DB_INT,
    integer: true,
    invalid: 'driverId deve ser um número inteiro.',
    tooLow: 'Id inválido.',
    tooHigh: 'Id inválido.',
  })
  driverId: number;
}
