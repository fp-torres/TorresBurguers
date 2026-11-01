import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  type Relation,
} from 'typeorm';
import { Store } from '../../store/entities/store.entity';
import { Plan } from './plan.entity';

/**
 * Estados da assinatura (transições válidas em billing/subscription-rules.ts):
 * TRIALING → ACTIVE | PAST_DUE | CANCELED
 * ACTIVE → PAST_DUE | SUSPENDED | CANCELED
 * PAST_DUE → ACTIVE | SUSPENDED | CANCELED
 * SUSPENDED → ACTIVE | CANCELED
 * CANCELED → (final; nova contratação cria outra assinatura)
 */
export enum SubscriptionStatus {
  TRIALING = 'TRIALING',
  ACTIVE = 'ACTIVE',
  PAST_DUE = 'PAST_DUE',
  SUSPENDED = 'SUSPENDED',
  CANCELED = 'CANCELED',
}

/** Quem cobra a assinatura: registro manual pelo superadmin ou Mercado Pago (preapproval). */
export type BillingProviderCode = 'MANUAL' | 'MERCADO_PAGO';

/**
 * Origem da suspensão: PLATFORM = decisão do superadmin (só ele reativa; pagamento não desfaz);
 * BILLING = fim da tolerância da inadimplência (o pagamento das faturas vencidas reativa).
 */
export type SuspensionSource = 'PLATFORM' | 'BILLING';

/**
 * Quem agendou o cancelamento no fim do período: PLATFORM = superadmin (só ele desfaz); STORE = a
 * própria loja (ela mesma pode desistir). Null sem agendamento.
 */
export type CancelScheduleSource = 'PLATFORM' | 'STORE';

/**
 * Assinatura SaaS de uma loja (loja → plataforma). Uma loja tem no máximo uma assinatura não
 * cancelada (índice único parcial criado na migration); as canceladas ficam como histórico.
 */
@Entity('subscriptions')
// Índice único parcial (store_id) WHERE status <> 'CANCELED': criado pela migration MultiTenantFoundation.
// synchronize:false porque o TypeORM não compara o WHERE de forma estável (recriaria o índice a cada subida).
@Index('UQ_subscriptions_store_current', { synchronize: false })
@Check(
  'CHK_subscriptions_suspended_by',
  `"suspended_by" IS NULL OR "suspended_by" IN ('PLATFORM', 'BILLING')`,
)
@Check(
  'CHK_subscriptions_cancel_scheduled_by',
  `"cancel_scheduled_by" IS NULL OR "cancel_scheduled_by" IN ('PLATFORM', 'STORE')`,
)
export class Subscription {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('IDX_subscriptions_store_id')
  @Column({ type: 'int' })
  store_id: number;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'store_id',
    foreignKeyConstraintName: 'FK_subscriptions_store',
  })
  store?: Relation<Store>;

  @Index('IDX_subscriptions_plan_id')
  @Column({ type: 'int' })
  plan_id: number;

  @ManyToOne(() => Plan, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'plan_id',
    foreignKeyConstraintName: 'FK_subscriptions_plan',
  })
  plan?: Relation<Plan>;

  @Index('IDX_subscriptions_status')
  @Column({
    type: 'enum',
    enum: SubscriptionStatus,
  })
  status: SubscriptionStatus;

  @Column({ type: 'timestamptz', nullable: true })
  trial_ends_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  current_period_start: Date | null;

  /** Fim do período pago. Null = sem vencimento (planos gratuitos/internos). */
  @Column({ type: 'timestamptz', nullable: true })
  current_period_end: Date | null;

  /** Cancelamento agendado: a loja usa até o fim do período e a assinatura vira CANCELED. */
  @Column({ default: false })
  cancel_at_period_end: boolean;

  /** Origem do cancelamento agendado (CHECK no banco: PLATFORM ou STORE); null sem agendamento. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  cancel_scheduled_by: CancelScheduleSource | null;

  @Column({ type: 'timestamptz', nullable: true })
  canceled_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  past_due_since: Date | null;

  /** Fim da tolerância da inadimplência: depois dele a assinatura é suspensa. */
  @Column({ type: 'timestamptz', nullable: true })
  grace_period_ends_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  suspended_at: Date | null;

  /** Quem suspendeu (null fora da suspensão). CHECK no banco: PLATFORM ou BILLING. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  suspended_by: SuspensionSource | null;

  @Column({ type: 'varchar', length: 20, default: 'MANUAL' })
  billing_provider: BillingProviderCode;

  /** Id da assinatura no provedor (preapproval do Mercado Pago). */
  @Index('UQ_subscriptions_provider_subscription_id', { unique: true })
  @Column({ type: 'varchar', length: 80, nullable: true })
  provider_subscription_id: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  provider_status: string | null;

  /** Link de pagamento/autorização da assinatura no provedor. */
  @Column({ type: 'text', nullable: true })
  provider_checkout_url: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
