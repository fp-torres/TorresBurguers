import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('products')
export class Product {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column('decimal', { precision: 10, scale: 2 }) // Ex: 99.90
  price: number;

  @Column()
  category: string;

  @Column({ nullable: true })
  image_url: string;

  @Column({ type: 'text', nullable: true })
  description: string;
}