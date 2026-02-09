import { 
  Entity, PrimaryGeneratedColumn, Column, 
  CreateDateColumn, UpdateDateColumn, OneToMany 
} from 'typeorm';
import { OrderItem } from '../../orders/entities/order-item.entity';

// Categorias exatas da Documentação
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

  // --- NOVO: Preço Promocional (De R$ 30 por R$ 19.90) ---
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  promotion_price: number;

  // --- NOVO: Destaque na Home (Carrossel) ---
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

  @Column({ default: true })
  available: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @OneToMany(() => OrderItem, (item) => item.product)
  items: OrderItem[];
}