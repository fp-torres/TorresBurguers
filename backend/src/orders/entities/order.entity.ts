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

export enum PaymentStatus {
  PENDING = 'PENDING', 
  PAID = 'PAID',       
  FAILED = 'FAILED'    
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
    enum: PaymentStatus,
    default: PaymentStatus.PENDING, 
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
  payment_method: string; 

  // NOVO: Tempo estimado em minutos (Ex: "45-55")
  @Column({ nullable: true })
  estimated_delivery_time: string;

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