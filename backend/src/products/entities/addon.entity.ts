import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('addons')
export class Addon {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string; // Ex: Bacon Extra

  @Column('text', { nullable: true })
  description: string; // Ex: Fatias crocantes

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  price: number; // Ex: 5.00

  @Column({ default: true })
  available: boolean;
}