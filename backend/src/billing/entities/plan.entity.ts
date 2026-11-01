import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { numericTransformer } from '../../database/transformers';

export enum BillingInterval {
  MONTHLY = 'MONTHLY',
  YEARLY = 'YEARLY',
}

/** Disponibilidade do plano para novas contratações (assinaturas existentes não mudam). */
export enum PlanStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

/** Recursos que um plano pode liberar (lista fechada, validada nos DTOs). */
export interface PlanFeatures {
  /** PIX e cartão pela loja online (sem ele: só pagamento na entrega/retirada). */
  online_payments?: boolean;
  /** Gráficos e relatórios do dashboard da loja. */
  advanced_reports?: boolean;
  /** Logo e cor da loja na vitrine. */
  custom_branding?: boolean;
}

/**
 * Plano comercial da plataforma (configurável pelo superadministrador; nenhum preço é fixo no código).
 * Limites nulos = ilimitado.
 */
@Entity('plans')
export class Plan {
  @PrimaryGeneratedColumn()
  id: number;

  /** Identificador estável (ex.: "essencial"). */
  @Index('UQ_plans_code', { unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 80 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** Preço por período (BRL). 0 = plano gratuito/interno. */
  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  price: number;

  @Column({ type: 'varchar', length: 3, default: 'BRL' })
  currency: string;

  @Column({
    type: 'enum',
    enum: BillingInterval,
    default: BillingInterval.MONTHLY,
  })
  billing_interval: BillingInterval;

  /** Dias de avaliação gratuita para novas assinaturas. */
  @Column({ type: 'int', default: 0 })
  trial_days: number;

  /** Usuários da equipe (ADMIN, atendente, cozinha, entregador) ativos. */
  @Column({ type: 'int', nullable: true })
  max_staff_users: number | null;

  /** Produtos no cardápio (fora da lixeira). */
  @Column({ type: 'int', nullable: true })
  max_products: number | null;

  /** Pedidos por mês (calendário da loja). */
  @Column({ type: 'int', nullable: true })
  max_monthly_orders: number | null;

  /**
   * Armazenamento das imagens da loja em MB (1 MB = 1.048.576 bytes): soma dos arquivos s<storeId>- da
   * pasta de uploads (produtos, adicionais, logo e POST /uploads; fotos de perfil não contam).
   */
  @Column({ type: 'int', nullable: true })
  max_storage_mb: number | null;

  @Column({ type: 'jsonb' })
  features: PlanFeatures;

  @Column({
    type: 'enum',
    enum: PlanStatus,
    default: PlanStatus.ACTIVE,
  })
  status: PlanStatus;

  /** Aparece na página pública de planos e no autoatendimento. */
  @Column({ default: true })
  is_public: boolean;

  @Column({ type: 'int', default: 0 })
  sort_order: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
