import { Entity, PrimaryGeneratedColumn, Column, DeleteDateColumn } from 'typeorm'; // <--- Importado

@Entity('addons')
export class Addon {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string; 

  @Column('text', { nullable: true })
  description: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  price: number; 

  @Column({ nullable: true })
  image: string; 

  @Column({ default: true })
  available: boolean;

  @Column({ default: 'geral' })
  category: string; 

  // --- NOVA COLUNA PARA SOFT DELETE ---
  @DeleteDateColumn()
  deleted_at: Date;
}