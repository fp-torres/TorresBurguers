import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Address } from '../../addresses/entities/address.entity';
import { OrderItem } from './order-item.entity';
import { OrderStatus, OrderType, PaymentStatus } from '../order.enums';
import type { DeliveryAddressSnapshot } from '../order-snapshot';

// Reexportados para quem já importava os enums da entidade
export { OrderStatus, OrderType, PaymentStatus };

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn()
  id: number;

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
