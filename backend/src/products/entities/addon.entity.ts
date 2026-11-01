import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  DeleteDateColumn,
  Index,
  JoinColumn,
  ManyToOne,
  type Relation,
} from 'typeorm';
import { Store } from '../../store/entities/store.entity';

@Entity('addons')
export class Addon {
  @PrimaryGeneratedColumn()
  id: number;

  /** Loja dona do adicional: um produto só aceita adicionais da própria loja. */
  @Index('IDX_addons_store_id')
  @Column({ type: 'int' })
  store_id: number;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'store_id', foreignKeyConstraintName: 'FK_addons_store' })
  store?: Relation<Store>;

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

  // Soft delete (lixeira)
  @DeleteDateColumn()
  deleted_at: Date;
}
