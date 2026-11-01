import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  OneToMany,
  ManyToMany,
  ManyToOne,
  JoinColumn,
  JoinTable,
  Index,
  type Relation,
} from 'typeorm';
import { OrderItem } from '../../orders/entities/order-item.entity';
import { Store } from '../../store/entities/store.entity';
import { Addon } from './addon.entity';

export enum ProductCategory {
  BURGER = 'hamburgueres',
  STARTER = 'entradas',
  SIDE = 'acompanhamentos',
  DRINK = 'bebidas',
  DESSERT = 'sobremesas',
  SAUCE = 'molhos',
  ADDON = 'adicionais',
  COMBO = 'combos',
}

@Entity('products')
export class Product {
  @PrimaryGeneratedColumn()
  id: number;

  /** Loja dona do produto (todo acesso filtra por ela). */
  @Index('IDX_products_store_id')
  @Column({ type: 'int' })
  store_id: number;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'store_id',
    foreignKeyConstraintName: 'FK_products_store',
  })
  store?: Relation<Store>;

  @Column()
  name: string;

  @Column('text')
  description: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  price: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  promotion_price: number;

  @Column({ default: false })
  is_highlight: boolean;

  @Column({ nullable: true })
  image: string;

  @Column({
    type: 'enum',
    enum: ProductCategory,
    default: ProductCategory.BURGER,
  })
  category: ProductCategory;

  @Column({ type: 'simple-array', nullable: true })
  ingredients: string[];

  // Sem cascade: salvar um produto só grava o vínculo (product_allowed_addons), nunca cria nem
  // altera adicionais — os adicionais vêm sempre do banco, filtrados pela loja do produto.
  @ManyToMany(() => Addon)
  @JoinTable({
    name: 'product_allowed_addons',
    joinColumn: { name: 'product_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'addon_id', referencedColumnName: 'id' },
  })
  allowed_addons: Addon[];

  @Column({ default: true })
  available: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  // --- NOVA COLUNA PARA SOFT DELETE ---
  @DeleteDateColumn()
  deleted_at: Date;

  @OneToMany(() => OrderItem, (item) => item.product)
  items: OrderItem[];
}
