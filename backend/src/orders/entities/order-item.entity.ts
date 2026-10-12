import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinTable,
  ManyToMany,
} from 'typeorm';
import { Order } from './order.entity';
import { Product } from '../../products/entities/product.entity';
import { Addon } from '../../products/entities/addon.entity';

/** Adicional como foi cobrado no pedido (nome e preço da época, com a quantidade). */
export interface OrderItemAddonSnapshot {
  id: number;
  name: string;
  price: number;
  quantity: number;
}

@Entity('order_items')
export class OrderItem {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Order, (order) => order.items, { onDelete: 'CASCADE' })
  order: Order;

  @ManyToOne(() => Product)
  product: Product;

  // Adicionais distintos do item (referência ao catálogo). A quantidade de cada um fica em addons_snapshot.
  @ManyToMany(() => Addon)
  @JoinTable({ name: 'order_item_addons' })
  addons: Addon[];

  @Column('int')
  quantity: number;

  @Column({ type: 'text', nullable: true })
  observation: string;

  @Column({ type: 'varchar', nullable: true })
  meat_point: string | null;

  @Column({ type: 'simple-array', nullable: true })
  removed_ingredients: string[];

  // --- Retrato do preço no momento do pedido (o histórico não muda se o cardápio mudar) ---
  // Nulos em pedidos criados antes desta versão.

  /** Nome do produto na época do pedido (renomear o produto não muda o histórico). */
  @Column({ type: 'varchar', nullable: true })
  product_name: string | null;

  /** Preço unitário do produto cobrado (promocional quando havia promoção). */
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  unit_price: number | null;

  /** Adicionais cobrados: [{ id, name, price, quantity }] (preço por unidade do item). */
  @Column({ type: 'jsonb', nullable: true })
  addons_snapshot: OrderItemAddonSnapshot[] | null;
}
