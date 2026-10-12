import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

/**
 * Id de pagamento na URL. Ids do Mercado Pago (e das simulações do sandbox) passam do limite de
 * uma coluna integer, então aqui o limite é o maior inteiro exato do JavaScript (coluna bigint).
 */
@Injectable()
export class ParsePaymentIdPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    const id = Number(value);
    if (
      !/^\d{1,16}$/.test(String(value)) ||
      id < 1 ||
      id > Number.MAX_SAFE_INTEGER
    ) {
      throw new BadRequestException('Id inválido.');
    }
    return id;
  }
}
