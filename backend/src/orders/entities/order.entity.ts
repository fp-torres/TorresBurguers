import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
  type Relation,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Address } from '../../addresses/entities/address.entity';
import { Store } from '../../store/entities/store.entity';
import { OrderItem } from './order-item.entity';
import { OrderStatus, OrderType, PaymentStatus } from '../order.enums';
import type { DeliveryAddressSnapshot } from '../order-snapshot';

// Reexportados para quem já importava os enums da entidade
export { OrderStatus, OrderType, PaymentStatus };

@Entity('orders')
@Index('IDX_orders_store_created_at', ['store_id', 'created_at'])
@Index('IDX_orders_store_status', ['store_id', 'status'])
// Meus pedidos (cliente global, todas as lojas)
@Index('IDX_orders_user_created_at', ['user', 'created_at'])
// Número do pedido: único dentro da loja
@Index('UQ_orders_store_number', ['store_id', 'number'], { unique: true })
// Quadro de pedidos (encerrados nas últimas 24 h) e quadro do entregador (também cobre a FK driver_id):
// migration PerformanceIndexes
@Index('IDX_orders_store_updated_at', ['store_id', 'updated_at'])
@Index('IDX_orders_driver_updated_at', ['driver', 'updated_at'])
// Pedidos abertos: índice parcial (store_id, created_at) WHERE status NOT IN ('DONE', 'CANCELED') OR
// payment_status = 'REFUND_PENDING', criado pela migration PerformanceIndexes.
// synchronize:false porque o TypeORM não compara o WHERE de forma estável (recriaria o índice a cada subida).
@Index('IDX_orders_store_open', { synchronize: false })
export class Order {
  @PrimaryGeneratedColumn()
  id: number;

  /** Loja do pedido: a equipe só enxerga os pedidos da própria loja. */
  @Column({ type: 'int' })
  store_id: number;

  /**
   * Número do pedido NA LOJA (1, 2, 3...), sem buracos: é o "Pedido #N" das telas. O id é global e
   * continua sendo a chave das rotas (e do app mobile), mas não é mostrado ao cliente (revelaria o
   * volume das outras lojas). Atribuído pelo banco em TODO insert (gatilho TRG_orders_assign_number:
   * pago na entrega, criado pelo pagamento aprovado ou por SQL) e imutável (TRG_orders_number_immutable).
   * Por isso a API nunca o envia (insert/update: false); depois do save, recarregue o pedido para lê-lo.
   */
  @Column({ type: 'int', insert: false, update: false })
  number: number;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'store_id', foreignKeyConstraintName: 'FK_orders_store' })
  store?: Relation<Store>;

  @Column({
    type: 'enum',
    enum: OrderStatus,
    default: OrderStatus.PENDING,
  })
  status: OrderStatus;

  @Column({
    type: 'enum',
    enum: PaymentStatus,
    default: PaymentStatus.PENDING,
  })
  payment_status: PaymentStatus;

  @Column({
    type: 'enum',
    enum: OrderType,
    default: OrderType.DELIVERY,
  })
  type: OrderType;

  // Valores calculados no servidor (o Postgres devolve decimal como string)
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  total_price: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  delivery_fee: number;

  // PIX | CREDIT_CARD | DEBIT_CARD | MONEY (pedidos antigos podem ter DINHEIRO, CARTAO_*)
  @Column()
  payment_method: string;

  // Troco: sempre no formato "R$ 50,00" (ou null quando não precisa)
  @Column({ type: 'varchar', nullable: true })
  change_for: string | null;

  // Pagamento online (Mercado Pago) que quitou o pedido. Único: um pagamento quita um só pedido.
  @Column({ type: 'bigint', nullable: true, unique: true })
  payment_id: number | null;

  @Column({ type: 'varchar', nullable: true })
  estimated_delivery_time: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => User, (user) => user.orders)
  @JoinColumn({ name: 'user_id' })
  user: User;

  // Entregador responsável
  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'driver_id' })
  driver: User | null;

  @ManyToOne(() => Address, { nullable: true })
  @JoinColumn({ name: 'address_id' })
  address: Address | null;

  // Retrato do endereço de entrega no momento do pedido: editar ou excluir o endereço depois
  // não muda o histórico. Null em retiradas e em pedidos anteriores a esta versão (usam "address").
  @Column({ type: 'simple-json', nullable: true })
  delivery_address: DeliveryAddressSnapshot | null;

  @OneToMany(() => OrderItem, (item) => item.order, { cascade: true })
  items: OrderItem[];
}
