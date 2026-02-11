import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinTable, ManyToMany } from 'typeorm';
import { Order } from './order.entity';
import { Product } from '../../products/entities/product.entity';
import { Addon } from '../../products/entities/addon.entity';

@Entity('order_items')
export class OrderItem {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Order, (order) => order.items, { onDelete: 'CASCADE' })
  order: Order;

  @ManyToOne(() => Product)
  product: Product;

  @ManyToMany(() => Addon)
  @JoinTable({ name: 'order_item_addons' })
  addons: Addon[];

  @Column('int')
  quantity: number;

  @Column({ type: 'text', nullable: true }) // Adicionei type: 'text' por segurança
  observation: string;

  // --- A CORREÇÃO ESTÁ AQUI ---
  // O erro ocorria porque o TypeORM lia "string | null" como Objeto.
  // Agora forçamos ele a entender que é um texto ('varchar' ou 'text').
  @Column({ type: 'varchar', nullable: true }) 
  meat_point: string | null; 

  @Column({ type: 'simple-array', nullable: true })
  removed_ingredients: string[]; 
}