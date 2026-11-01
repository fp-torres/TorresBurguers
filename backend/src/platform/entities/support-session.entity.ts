import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import { Store } from '../../store/entities/store.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Acesso assistido do suporte a uma loja: explícito (com motivo), temporário (expira), somente
 * leitura e auditado. O token da sessão nunca usa as credenciais do lojista.
 */
@Entity('support_sessions')
@Index('IDX_support_sessions_store_started', ['store_id', 'started_at'])
export class SupportSession {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', nullable: true })
  platform_user_id: number | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'platform_user_id',
    foreignKeyConstraintName: 'FK_support_sessions_platform_user',
  })
  platform_user?: Relation<User> | null;

  @Column({ type: 'int' })
  store_id: number;

  @ManyToOne(() => Store, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'store_id',
    foreignKeyConstraintName: 'FK_support_sessions_store',
  })
  store?: Relation<Store>;

  @Column({ type: 'varchar', length: 300 })
  reason: string;

  @CreateDateColumn({ type: 'timestamptz' })
  started_at: Date;

  @Column({ type: 'timestamptz' })
  expires_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  ended_at: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip: string | null;
}
