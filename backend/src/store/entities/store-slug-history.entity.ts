import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import { Store } from './store.entity';

/**
 * Endereços (slugs) que uma loja deixou de usar quando o superpainel trocou o endereço dela. Ficam
 * reservados para sempre contra o autoatendimento: links, QR codes impressos e a última loja guardada
 * no navegador dos clientes continuam apontando para o endereço antigo, e um impostor que o
 * registrasse receberia esses clientes (e os pagamentos). O superpainel ainda pode reutilizá-lo (com
 * aviso). Um endereço por linha (o último dono); a loja que voltar a usá-lo continua sendo a dona.
 */
@Entity('store_slug_history')
export class StoreSlugHistory {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_store_slug_history' })
  id: number;

  /** Loja que usava o endereço. */
  @Index('IDX_store_slug_history_store_id')
  @Column({ type: 'int' })
  store_id: number;

  @ManyToOne(() => Store, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'store_id',
    foreignKeyConstraintName: 'FK_store_slug_history_store',
  })
  store?: Relation<Store>;

  @Index('UQ_store_slug_history_slug', { unique: true })
  @Column({ type: 'varchar', length: 60 })
  slug: string;

  /** Quando a loja deixou de usar o endereço (a última vez). */
  @Column({ type: 'timestamptz' })
  released_at: Date;
}
