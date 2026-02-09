import { 
  Entity, PrimaryGeneratedColumn, Column, 
  CreateDateColumn, ManyToOne, OneToMany, JoinColumn 
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Address } from '../../addresses/entities/address.entity'; 
import { OrderItem } from './order-item.entity';

export enum OrderStatus {
  PENDING = 'PENDING',       // Chegou agora
  PREPARING = 'PREPARING',   // Na chapa
  DELIVERING = 'DELIVERING', // Saiu com motoboy
  DONE = 'DONE',             // Entregue/Finalizado
  CANCELED = 'CANCELED'      // Cancelado
}

export enum OrderType {
  DELIVERY = 'DELIVERY',
  TAKEOUT = 'TAKEOUT'
}

// --- NOVO: Controle Financeiro Sênior ---
export enum PaymentStatus {
  PENDING = 'PENDING', // Pagar na entrega ou aguardando PIX
  PAID = 'PAID',       // Pago
  FAILED = 'FAILED'    // Cartão recusado
}

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn()
  id: number;

  // Status Logístico (Cozinha/Entrega)
  @Column({
    type: 'enum',
    enum: OrderStatus,
    default: OrderStatus.PENDING,
  })
  status: OrderStatus;

  // Status Financeiro (Caixa)
  @Column({
    type: 'enum',
    enum: PaymentStatus,
    default: PaymentStatus.PENDING, // Começa como pendente
  })
  payment_status: PaymentStatus;

  @Column({
    type: 'enum',
    enum: OrderType,
    default: OrderType.DELIVERY
  })
  type: OrderType;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  total_price: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  delivery_fee: number;

  @Column()
  payment_method: string; // "PIX", "CREDIT_CARD", "CASH"

  @CreateDateColumn()
  created_at: Date;

  @ManyToOne(() => User, (user) => user.orders)
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Address, { nullable: true })
  @JoinColumn({ name: 'address_id' })
  address: Address | null; 

  @OneToMany(() => OrderItem, (item) => item.order, { cascade: true })
  items: OrderItem[];
}