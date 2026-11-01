import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  type Relation,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Store } from './store.entity';

/** Tamanho máximo do motivo do bloqueio (aparece para a equipe da loja e vai para a auditoria). */
export const CUSTOMER_BLOCK_REASON_MAX_LENGTH = 300;

/**
 * Cliente bloqueado por UMA loja (abuso: pedidos falsos, trotes). O cliente é global: o bloqueio só vale
 * na loja que bloqueou, e ele continua comprando nas outras. Enquanto a linha existir, a loja recusa
 * orçamento, pedido pago na entrega e cobrança PIX/cartão desse cliente (403 com mensagem genérica).
 * Pagamentos já aprovados continuam virando pedido (a loja pode cancelar e estornar).
 *
 * Desbloquear apaga a linha; quem bloqueou, quando e por quê ficam também na auditoria
 * (store.customer.block / store.customer.unblock).
 */
@Entity('store_customer_blocks')
export class StoreCustomerBlock {
  @PrimaryColumn({
    type: 'int',
    primaryKeyConstraintName: 'PK_store_customer_blocks',
  })
  store_id: number;

  /** Conta do cliente (global). Índice próprio: o FK em users apaga os bloqueios da conta excluída. */
  @PrimaryColumn({
    type: 'int',
    primaryKeyConstraintName: 'PK_store_customer_blocks',
  })
  @Index('IDX_store_customer_blocks_user_id')
  user_id: number;

  @Column({ type: 'varchar', length: CUSTOMER_BLOCK_REASON_MAX_LENGTH })
  reason: string;

  /** ADMIN da loja que bloqueou (null se a conta dele for excluída de vez). */
  @Column({ type: 'int', nullable: true })
  blocked_by_user_id: number | null;

  @CreateDateColumn({ name: 'blocked_at', type: 'timestamptz' })
  blocked_at: Date;

  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'store_id',
    foreignKeyConstraintName: 'FK_store_customer_blocks_store',
  })
  store?: Relation<Store>;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_store_customer_blocks_user',
  })
  user?: Relation<User>;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'blocked_by_user_id',
    foreignKeyConstraintName: 'FK_store_customer_blocks_blocked_by',
  })
  blocked_by?: Relation<User> | null;
}
