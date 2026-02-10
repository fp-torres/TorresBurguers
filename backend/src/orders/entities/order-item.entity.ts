import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinTable, ManyToMany } from 'typeorm';
import { Order } from './order.entity';
import { Product } from '../../products/entities/product.entity';
import { Addon } from '../../products/entities/addon.entity'; // Ajuste o caminho se necessário

@Entity('order_items')
export class OrderItem {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Order, (order) => order.items, { onDelete: 'CASCADE' })
  order: Order;

  @ManyToOne(() => Product)
  product: Product;

  // Adicionais escolhidos pelo cliente neste item
  @ManyToMany(() => Addon)
  @JoinTable({ name: 'order_item_addons' })
  addons: Addon[];

  @Column('int')
  quantity: number;

  @Column({ nullable: true })
  observation: string;

  // --- NOVO: Ponto da Carne ---
  @Column({ nullable: true })
  meat_point: string; // Ex: "Ao Ponto", "Bem Passado"

  // --- NOVO: Ingredientes Removidos ---
  @Column({ type: 'simple-array', nullable: true })
  removed_ingredients: string[]; // Ex: ["Cebola", "Picles"]
}