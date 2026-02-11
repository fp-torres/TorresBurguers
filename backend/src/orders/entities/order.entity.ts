import { 
  Entity, 
  PrimaryGeneratedColumn, 
  Column, 
  CreateDateColumn, 
  UpdateDateColumn, 
  ManyToOne, 
  OneToMany, 
  JoinColumn 
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Address } from '../../addresses/entities/address.entity'; 
import { OrderItem } from './order-item.entity';

export enum OrderStatus {
  PENDING = 'PENDING',                     // 1. Aguardando Cozinha aceitar
  PREPARING = 'PREPARING',                 // 2. Em preparo na Cozinha
  READY_FOR_PICKUP = 'READY_FOR_PICKUP',   // 3. Pronto (Aguardando Motoboy/Retirada)
  DELIVERING = 'DELIVERING',               // 4. Saiu para entrega
  DONE = 'DONE',                           // 5. Entregue / Finalizado
  CANCELED = 'CANCELED'                    // 6. Cancelado
}

export enum OrderType {
  DELIVERY = 'DELIVERY',
  TAKEOUT = 'TAKEOUT' // Ou 'PICKUP'
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

  // Valor total do pedido (Produtos + Frete)
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  total_price: number;

  // Taxa de entrega separada
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  delivery_fee: number;

  @Column()
  payment_method: string; 

  @Column({ nullable: true })
  estimated_delivery_time: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  // --- RELACIONAMENTOS ---

  // Muitos Pedidos pertencem a Um Usuário
  @ManyToOne(() => User, (user) => user.orders)
  @JoinColumn({ name: 'user_id' })
  user: User;

  // Muitos Pedidos pertencem a Um Endereço (pode ser null se for Retirada)
  @ManyToOne(() => Address, { nullable: true })
  @JoinColumn({ name: 'address_id' })
  address: Address | null; 

  // Um Pedido tem Muitos Itens
  @OneToMany(() => OrderItem, (item) => item.order, { cascade: true })
  items: OrderItem[];
}