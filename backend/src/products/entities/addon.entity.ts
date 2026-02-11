import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('addons')
export class Addon {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string; 

  @Column('text', { nullable: true })
  description: string;

  // Use 'numeric' ou 'decimal' dependendo do seu banco, garantindo precisão
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  price: number; 

  @Column({ nullable: true })
  image: string; 

  @Column({ default: true })
  available: boolean;

  // --- NOVO CAMPO: Categoria do Adicional ---
  // Ex: 'hamburgueres', 'bebidas', 'geral'
  @Column({ default: 'geral' })
  category: string; 
}