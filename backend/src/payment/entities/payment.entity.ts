import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
  type ValueTransformer,
} from 'typeorm';
import type { OrderSnapshot } from '../../orders/order-snapshot';
import type { OrderType } from '../../orders/order.enums';

/** bigint e decimal chegam do Postgres como texto: na entidade ficam como number. */
const numeric: ValueTransformer = {
  to: (value: unknown) => value,
  from: (value: unknown) =>
    value === null || value === undefined ? value : Number(value),
};

/** Pedido enviado pelo app ao pagar (o mesmo corpo de POST /orders/quote). */
export interface OrderRequestPayload {
  items: {
    productId: number;
    quantity: number;
    addonIds?: number[];
    observation?: string;
    meatPoint?: string;
    removedIngredients?: string[];
  }[];
  type: OrderType;
  addressId?: number;
}

/** Dados do QR Code do PIX (devolvidos de novo quando o app repete a mesma chave de idempotência). */
export interface PixData {
  qr_code: string;
  qr_code_base64: string | null;
  ticket_url: string | null;
}

/**
 * Pagamento online criado por este servidor. Fica no banco (sobrevive a reinícios e a várias
 * instâncias da API) e guarda o pedido e o retrato de preços da hora do pagamento: quando o
 * pagamento é aprovado, o próprio servidor cria o pedido com esses dados.
 */
@Entity('payments')
@Index('UQ_payments_user_idempotency_key', ['user_id', 'idempotency_key'], {
  unique: true,
})
export class Payment {
  /** Id no Mercado Pago (ou na faixa das simulações do sandbox, a partir de 900000000000000). */
  @PrimaryColumn({ type: 'bigint', transformer: numeric })
  id: number;

  @Index()
  @Column({ type: 'int' })
  user_id: number;

  /** CARD | PIX */
  @Column({ type: 'varchar', length: 10 })
  method: 'CARD' | 'PIX';

  /** Forma de pagamento do pedido que este pagamento cria: PIX | CREDIT_CARD | DEBIT_CARD. */
  @Column({ type: 'varchar', length: 20 })
  order_payment_method: string;

  /** Meio no Mercado Pago (master, visa, debelo, pix...). */
  @Column({ type: 'varchar', length: 40, nullable: true })
  payment_method_id: string | null;

  /** Valor cobrado (total do pedido calculado pelo servidor). */
  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: numeric,
  })
  amount: number;

  /** Status do Mercado Pago: pending, in_process, approved, rejected, cancelled, refunded... */
  @Index()
  @Column({ type: 'varchar', length: 30 })
  status: string;

  @Column({ type: 'varchar', length: 80, nullable: true })
  status_detail: string | null;

  /** Aprovação simulada (sandbox): não existe/não vale no Mercado Pago. */
  @Column({ type: 'boolean', default: false })
  simulated: boolean;

  /** Corpo do pedido enviado ao pagar. */
  @Column({ type: 'jsonb' })
  order_payload: OrderRequestPayload;

  /** Retrato de itens, preços, endereço, taxa e total cobrados: é com ele que o pedido é criado. */
  @Column({ type: 'jsonb' })
  price_snapshot: OrderSnapshot;

  @Column({ type: 'jsonb', nullable: true })
  pix_data: PixData | null;

  /** PIX: vencimento do código (date_of_expiration). */
  @Column({ type: 'timestamptz', nullable: true })
  expires_at: Date | null;

  /** PIX do sandbox: aprovado automaticamente a partir deste instante. */
  @Column({ type: 'timestamptz', nullable: true })
  auto_approve_at: Date | null;

  /** Pedido criado por este pagamento. */
  @Index()
  @Column({ type: 'int', nullable: true })
  order_id: number | null;

  /** Chave enviada pelo app: a mesma chave do mesmo cliente devolve este pagamento (nunca cobra 2x). */
  @Column({ type: 'varchar', length: 64, nullable: true })
  idempotency_key: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  external_reference: string | null;

  /** Erro definitivo ao criar o pedido (a conciliação não tenta de novo; precisa de atenção). */
  @Column({ type: 'text', nullable: true })
  finalize_error: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
