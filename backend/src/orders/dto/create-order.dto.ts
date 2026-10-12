import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { IsNumberInRange, MAX_DB_INT } from '../../common/validators';
import { OrderType } from '../order.enums';
import {
  MAX_ADDONS_PER_ITEM,
  MAX_ITEM_QUANTITY,
  MAX_OBSERVATION_LENGTH,
  MAX_ORDER_LINES,
  PAYMENT_METHODS,
  type PaymentMethodCode,
} from '../order-rules';

/** Ids no corpo: inteiro de 1 até o limite do integer do Postgres; fora disso, "Id inválido.". */
function idRules(field: string) {
  return {
    min: 1,
    max: MAX_DB_INT,
    integer: true,
    invalid: `${field} deve ser um número inteiro.`,
    tooLow: 'Id inválido.',
    tooHigh: 'Id inválido.',
  };
}

export class OrderItemDto {
  @ApiProperty()
  @IsNumberInRange(idRules('productId'))
  productId: number;

  @ApiProperty({ minimum: 1, maximum: MAX_ITEM_QUANTITY })
  @IsInt({ message: 'A quantidade deve ser um número inteiro.' })
  @Min(1, { message: 'A quantidade deve ser no mínimo 1.' })
  @Max(MAX_ITEM_QUANTITY, {
    message: `A quantidade deve ser no máximo ${MAX_ITEM_QUANTITY}.`,
  })
  quantity: number;

  @ApiProperty({
    required: false,
    type: [Number],
    description:
      'Ids dos adicionais de UMA unidade do item; repetir o id indica a quantidade (ex.: [3, 3] = 2x).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ADDONS_PER_ITEM, {
    message: `No máximo ${MAX_ADDONS_PER_ITEM} adicionais por item.`,
  })
  @IsNumberInRange(
    {
      ...idRules('addonIds'),
      invalid: 'addonIds deve conter apenas números inteiros.',
    },
    { each: true },
  )
  addonIds?: number[];

  @ApiProperty({ required: false, maxLength: MAX_OBSERVATION_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_OBSERVATION_LENGTH, {
    message: `A observação pode ter no máximo ${MAX_OBSERVATION_LENGTH} caracteres.`,
  })
  observation?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  meatPoint?: string;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  removedIngredients?: string[];
}

/** Corpo de POST /orders/quote — também usado como "order" em POST /payment/card e /payment/pix. */
export class QuoteOrderDto {
  @ApiProperty({ type: [OrderItemDto] })
  @IsArray()
  @ArrayNotEmpty({ message: 'O pedido precisa ter pelo menos um item.' })
  @ArrayMaxSize(MAX_ORDER_LINES, {
    message: `O pedido pode ter no máximo ${MAX_ORDER_LINES} itens.`,
  })
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];

  @ApiProperty({ enum: OrderType })
  @IsEnum(OrderType, { message: 'type deve ser DELIVERY ou TAKEOUT.' })
  type: OrderType;

  @ApiProperty({
    required: false,
    description: 'Obrigatório para DELIVERY (endereço do próprio cliente).',
  })
  @IsOptional()
  @IsNumberInRange(idRules('addressId'))
  addressId?: number;
}

export class CreateOrderDto extends QuoteOrderDto {
  @ApiProperty({
    enum: PAYMENT_METHODS,
    description: 'Com paymentId = pago online; sem = pago na entrega/retirada.',
  })
  @IsIn(PAYMENT_METHODS, {
    message: 'paymentMethod deve ser PIX, CREDIT_CARD, DEBIT_CARD ou MONEY.',
  })
  paymentMethod: PaymentMethodCode;

  @ApiProperty({
    required: false,
    description: 'Id do pagamento aprovado em /payment/card ou /payment/pix.',
  })
  @IsOptional()
  // Ids do Mercado Pago passam do integer: o limite é o da coluna bigint (inteiro exato do JS)
  @IsNumberInRange({ ...idRules('paymentId'), max: Number.MAX_SAFE_INTEGER })
  paymentId?: number;

  @ApiProperty({
    required: false,
    description: 'Troco para quanto (apenas MONEY), ex.: "R$ 50,00".',
  })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  changeFor?: string;
}
