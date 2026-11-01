import {
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
import { numericTransformer } from '../../database/transformers';
import { Store } from '../../store/entities/store.entity';
import { Plan } from './plan.entity';
import { Subscription, type BillingProviderCode } from './subscription.entity';

export enum InvoiceStatus {
  OPEN = 'OPEN',
  PAID = 'PAID',
  FAILED = 'FAILED',
  VOID = 'VOID',
}

/**
 * Fatura da assinatura SaaS (loja → plataforma). Receita da Comestra: nunca se mistura com os
 * pagamentos do delivery (tabela payments, consumidor → loja).
 */
@Entity('subscription_invoices')
@Index('IDX_subscription_invoices_store_created', ['store_id', 'created_at'])
// Uma fatura válida por período da assinatura: índice único parcial
// (subscription_id, period_start) WHERE status <> 'VOID', criado pela migration TenancyIndexes
@Index('UQ_subscription_invoices_subscription_period', { synchronize: false })
export class SubscriptionInvoice {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('IDX_subscription_invoices_subscription_id')
  @Column({ type: 'int' })
  subscription_id: number;

  @ManyToOne(() => Subscription, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'subscription_id',
    foreignKeyConstraintName: 'FK_subscription_invoices_subscription',
  })
  subscription?: Relation<Subscription>;

  @Column({ type: 'int' })
  store_id: number;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'store_id',
    foreignKeyConstraintName: 'FK_subscription_invoices_store',
  })
  store?: Relation<Store>;

  @Column({ type: 'int' })
  plan_id: number;

  @ManyToOne(() => Plan, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'plan_id',
    foreignKeyConstraintName: 'FK_subscription_invoices_plan',
  })
  plan?: Relation<Plan>;

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: numericTransformer,
  })
  amount: number;

  @Column({ type: 'varchar', length: 3, default: 'BRL' })
  currency: string;

  @Index('IDX_subscription_invoices_status')
  @Column({
    type: 'enum',
    enum: InvoiceStatus,
    default: InvoiceStatus.OPEN,
  })
  status: InvoiceStatus;

  @Column({ type: 'timestamptz' })
  period_start: Date;

  @Column({ type: 'timestamptz' })
  period_end: Date;

  @Column({ type: 'timestamptz' })
  due_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  paid_at: Date | null;

  @Column({ type: 'varchar', length: 20, default: 'MANUAL' })
  billing_provider: BillingProviderCode;

  /** Id do pagamento no provedor: uma notificação repetida nunca quita duas faturas. */
  @Index('UQ_subscription_invoices_provider_payment_id', { unique: true })
  @Column({ type: 'varchar', length: 80, nullable: true })
  provider_payment_id: string | null;

  /** Forma de pagamento informada (PIX, boleto, cartão, transferência...). */
  @Column({ type: 'varchar', length: 40, nullable: true })
  payment_method: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  notes: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  failure_reason: string | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
