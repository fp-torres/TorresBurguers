import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('store_config')
export class StoreConfig {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ default: false }) 
  is_open: boolean;

  @Column({ nullable: true })
  opening_message: string;
  
  @Column({ nullable: true })
  closing_message: string;
}