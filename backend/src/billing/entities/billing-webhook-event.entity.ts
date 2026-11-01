import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Notificação recebida do provedor de cobrança SaaS (idempotência): a mesma notificação
 * (provider + event_key) só é processada uma vez. Separada do webhook do delivery (/payment/webhook).
 */
@Entity('billing_webhook_events')
@Index('UQ_billing_webhook_events_key', ['provider', 'event_key'], {
  unique: true,
})
export class BillingWebhookEvent {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 20 })
  provider: string;

  /** Chave da notificação (ex.: "subscription_authorized_payment:123456:payment.created"). */
  @Column({ type: 'varchar', length: 200 })
  event_key: string;

  @Column({ type: 'varchar', length: 60, nullable: true })
  topic: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  resource_id: string | null;

  /** RECEIVED | PROCESSED | IGNORED | FAILED */
  @Column({ type: 'varchar', length: 20, default: 'RECEIVED' })
  status: string;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  received_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  processed_at: Date | null;
}
