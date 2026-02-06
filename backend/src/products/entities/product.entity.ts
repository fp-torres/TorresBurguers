import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm';
import { OrderItem } from '../../orders/entities/order-item.entity';

// 1. Categorias exatas da Documentação
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

  // 2. Imagem opcional (caso esteja cadastrando sem foto inicial)
  @Column({ nullable: true })
  image: string;

  // 3. Categoria travada (Segurança de Dados)
  @Column({
    type: 'enum',
    enum: ProductCategory,
    default: ProductCategory.BURGER
  })
  category: ProductCategory;

  // 4. Controle de Disponibilidade (Não deletar, apenas desativar)
  @Column({ default: true })
  available: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @OneToMany(() => OrderItem, (item) => item.product)
  items: OrderItem[];
}