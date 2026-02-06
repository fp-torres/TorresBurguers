import { 
  Entity, PrimaryGeneratedColumn, Column, 
  CreateDateColumn, ManyToOne, OneToMany, JoinColumn 
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Address } from '../../addresses/entities/address.entity'; 
import { OrderItem } from './order-item.entity';

export enum OrderStatus {
  PENDING = 'PENDING',
  PREPARING = 'PREPARING',
  DELIVERING = 'DELIVERING',
  DONE = 'DONE',
  CANCELED = 'CANCELED'
}

export enum OrderType {
  DELIVERY = 'DELIVERY',
  TAKEOUT = 'TAKEOUT'
}

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
    enum: OrderType,
    default: OrderType.DELIVERY
  })
  type: OrderType;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  total_price: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  delivery_fee: number;

  @Column()
  payment_method: string;

  @CreateDateColumn()
  created_at: Date;

  @ManyToOne(() => User, (user) => user.orders)
  @JoinColumn({ name: 'user_id' })
  user: User;

  // CORREÇÃO AQUI: Adicionamos '| null' para o TypeScript aceitar nulo
  @ManyToOne(() => Address, { nullable: true })
  @JoinColumn({ name: 'address_id' })
  address: Address | null; 
  // ------------------------------------------------------------------

  @OneToMany(() => OrderItem, (item) => item.order, { cascade: true })
  items: OrderItem[];
}