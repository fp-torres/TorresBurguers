import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { MAX_DB_INT } from '../validators';

/**
 * Converte o parâmetro :id em número (como o ParseIntPipe), recusando com 400 valores
 * que não cabem numa coluna integer — sem isso o PostgreSQL responde erro e a API daria 500.
 */
@Injectable()
export class ParseIdPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    const id = Number(value);
    if (!/^\d+$/.test(String(value)) || id < 1 || id > MAX_DB_INT) {
      throw new BadRequestException('Id inválido.');
    }
    return id;
  }
}
