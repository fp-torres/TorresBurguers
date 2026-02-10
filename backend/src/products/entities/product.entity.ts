import { 
  Entity, PrimaryGeneratedColumn, Column, 
  CreateDateColumn, UpdateDateColumn, OneToMany, ManyToMany, JoinTable 
} from 'typeorm';
import { OrderItem } from '../../orders/entities/order-item.entity';
import { Addon } from './addon.entity'; // Certifique-se de que o arquivo addon.entity.ts existe

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

  // --- NOVO: Ingredientes Padrão (Ex: Pão, Carne, Queijo, Cebola) ---
  // Isso permite que o frontend saiba o que mostrar para o usuário "Remover"
  @Column({ type: 'simple-array', nullable: true })
  ingredients: string[];

  // --- NOVO: Adicionais Permitidos ---
  // Define quais adicionais aparecem para este produto específico
  @ManyToMany(() => Addon)
  @JoinTable({ name: 'product_allowed_addons' })
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