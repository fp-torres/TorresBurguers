import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
  type Relation,
} from 'typeorm';
import { Plan } from '../../billing/entities/plan.entity';
import { Store } from '../../store/entities/store.entity';
import { User } from '../../users/entities/user.entity';

/** Id da única linha de configurações globais. */
export const PLATFORM_SETTINGS_ID = 1;

/** Configurações globais da plataforma (linha única, editada no superpainel). */
@Entity('platform_settings')
export class PlatformSettings {
  @PrimaryColumn({ type: 'int' })
  id: number;

  /**
   * Loja das rotas antigas sem slug (/products, /store/status, /orders...), usadas pelo app mobile e
   * por integrações da versão de loja única. Null = rotas antigas indisponíveis (404).
   */
  @Column({ type: 'int', nullable: true })
  default_store_id: number | null;

  @ManyToOne(() => Store, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'default_store_id',
    foreignKeyConstraintName: 'FK_platform_settings_default_store',
  })
  default_store?: Relation<Store> | null;

  /** Dias de tolerância da inadimplência (PAST_DUE) antes da suspensão automática. */
  @Column({ type: 'int', default: 7 })
  grace_period_days: number;

  /** Duração das sessões de acesso assistido do suporte, em minutos. */
  @Column({ type: 'int', default: 30 })
  support_session_minutes: number;

  /** Estabelecimentos podem se cadastrar sozinhos pela página pública. */
  @Column({ default: false })
  store_self_signup_enabled: boolean;

  /** Plano usado no autoatendimento (precisa estar ativo e público). */
  @Column({ type: 'int', nullable: true })
  self_signup_plan_id: number | null;

  @ManyToOne(() => Plan, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'self_signup_plan_id',
    foreignKeyConstraintName: 'FK_platform_settings_self_signup_plan',
  })
  self_signup_plan?: Relation<Plan> | null;

  @Column({ type: 'int', nullable: true })
  updated_by_user_id: number | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'updated_by_user_id',
    foreignKeyConstraintName: 'FK_platform_settings_updated_by',
  })
  updated_by?: Relation<User> | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
