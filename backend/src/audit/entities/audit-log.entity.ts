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

/** De onde partiu a ação: superadmin da plataforma, equipe da loja, rotina do sistema ou anônimo. */
export type AuditActorScope = 'PLATFORM' | 'STORE' | 'SYSTEM' | 'ANONYMOUS';
export type AuditResult = 'SUCCESS' | 'FAILURE' | 'DENIED';

/**
 * Trilha de auditoria (ações administrativas e eventos de autenticação). Nunca guarda senhas,
 * tokens ou segredos: o AuditService remove essas chaves do metadata antes de gravar.
 */
@Entity('audit_logs')
@Index('IDX_audit_logs_store_created', ['store_id', 'created_at'])
@Index('IDX_audit_logs_actor_created', ['actor_user_id', 'created_at'])
@Index('IDX_audit_logs_action_created', ['action', 'created_at'])
// Página da auditoria do superpainel, mais novos primeiro (migration PerformanceIndexes)
@Index('IDX_audit_logs_created', ['created_at', 'id'])
export class AuditLog {
  @PrimaryGeneratedColumn()
  id: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @Column({ type: 'int', nullable: true })
  actor_user_id: number | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'actor_user_id',
    foreignKeyConstraintName: 'FK_audit_logs_actor',
  })
  actor?: Relation<User> | null;

  /** E-mail do operador no momento da ação (continua legível mesmo se a conta mudar). */
  @Column({ type: 'varchar', length: 160, nullable: true })
  actor_email: string | null;

  @Column({ type: 'varchar', length: 20 })
  actor_scope: AuditActorScope;

  /** Estabelecimento afetado (null = ação global da plataforma). */
  @Column({ type: 'int', nullable: true })
  store_id: number | null;

  @ManyToOne(() => Store, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'store_id',
    foreignKeyConstraintName: 'FK_audit_logs_store',
  })
  store?: Relation<Store> | null;

  /** Ex.: store.create, store.suspend, user.block, plan.update, auth.login.failure. */
  @Column({ type: 'varchar', length: 80 })
  action: string;

  @Column({ type: 'varchar', length: 40, nullable: true })
  target_type: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  target_id: string | null;

  @Column({ type: 'varchar', length: 20 })
  result: AuditResult;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  user_agent: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;
}
