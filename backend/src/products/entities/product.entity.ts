import { 
  Entity, PrimaryGeneratedColumn, Column, 
  CreateDateColumn, UpdateDateColumn, OneToMany, ManyToMany, JoinTable 
} from 'typeorm';
import { OrderItem } from '../../orders/entities/order-item.entity';
import { Addon } from './addon.entity'; 

export enum ProductCategory {
  BURGER = 'hamburgueres',
  STARTER = 'entradas',
  SIDE = 'acompanhamentos',
  DRINK = 'bebidas',
  DESSERT = 'sobremesas',
  SAUCE = 'molhos',
  ADDON = 'adicionais'
}

@Entity('products')
export class Product {
  @PrimaryGeneratedColumn()
  id: number;

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
    default: ProductCategory.BURGER
  })
  category: ProductCategory;

  @Column({ type: 'simple-array', nullable: true })
  ingredients: string[];

  // RELACIONAMENTO: Um produto pode ter vários adicionais
  @ManyToMany(() => Addon, { cascade: true })
  @JoinTable({ 
    name: 'product_allowed_addons', 
    joinColumn: { name: 'product_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'addon_id', referencedColumnName: 'id' }
  })
  allowed_addons: Addon[];

  @Column({ default: true })
  available: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @OneToMany(() => OrderItem, (item) => item.product)
  items: OrderItem[];
}