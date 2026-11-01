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
import { Subscription } from './subscription.entity';

/** Histórico da assinatura: criação, mudanças de status/plano, cobranças e falhas. */
@Entity('subscription_events')
@Index('IDX_subscription_events_store_created', ['store_id', 'created_at'])
export class SubscriptionEvent {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('IDX_subscription_events_subscription_id')
  @Column({ type: 'int' })
  subscription_id: number;

  @ManyToOne(() => Subscription, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'subscription_id',
    foreignKeyConstraintName: 'FK_subscription_events_subscription',
  })
  subscription?: Relation<Subscription>;

  @Column({ type: 'int' })
  store_id: number;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'store_id',
    foreignKeyConstraintName: 'FK_subscription_events_store',
  })
  store?: Relation<Store>;

  /** CREATED, STATUS_CHANGED, PLAN_CHANGED, INVOICE_CREATED, PAYMENT_SUCCEEDED, PAYMENT_FAILED... */
  @Column({ type: 'varchar', length: 40 })
  type: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  from_status: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  to_status: string | null;

  @Column({ type: 'int', nullable: true })
  from_plan_id: number | null;

  @Column({ type: 'int', nullable: true })
  to_plan_id: number | null;

  /** Quem causou o evento (null = sistema: rotina automática ou webhook). */
  @Column({ type: 'int', nullable: true })
  actor_user_id: number | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'actor_user_id',
    foreignKeyConstraintName: 'FK_subscription_events_actor',
  })
  actor?: Relation<User> | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  reason: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
