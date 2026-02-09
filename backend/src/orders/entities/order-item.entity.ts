import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinTable, ManyToMany } from 'typeorm';
import { Order } from './order.entity';
import { Product } from '../../products/entities/product.entity';
import { Addon } from 'src/products/entities/addon.entity';

@Entity('order_items')
export class OrderItem {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Order, (order) => order.items, { onDelete: 'CASCADE' })
  order: Order;

  @ManyToOne(() => Product)
  product: Product;

  @ManyToMany(() => Addon)
  @JoinTable({ name: 'order_item_addons' }) // Tabela pivô automática
  addons: Addon[];
  // ------------------------------------

  @Column('int')
  quantity: number;

  @Column({ nullable: true })
  observation: string;
}