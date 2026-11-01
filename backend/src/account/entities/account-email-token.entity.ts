import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * Para que serve o link enviado por e-mail:
 * - VERIFY: confirmar que a pessoa recebe e-mails no endereço da conta (48 h);
 * - CHANGE: confirmar a troca do e-mail da conta, no endereço NOVO (24 h);
 * - REVERT: "Não fui eu", enviado ao endereço ANTIGO depois de uma troca (7 dias). Enquanto está
 *   aberto, o endereço antigo fica reservado para a conta (ninguém mais se cadastra com ele).
 */
export enum AccountEmailTokenPurpose {
  VERIFY = 'VERIFY',
  CHANGE = 'CHANGE',
  REVERT = 'REVERT',
}

/** Condição dos links em aberto (não usados nem cancelados), a mesma dos índices parciais. */
const OPEN = `"used_at" IS NULL AND "revoked_at" IS NULL`;

/**
 * Link de uso único das ações de e-mail da conta (verificação, troca e "Não fui eu"). O código só existe
 * no link enviado (randomToken); o banco guarda o SHA-256. Migration AccountEmailVerification.
 *
 * - email: endereço que recebeu o link (normalizado). No REVERT é o endereço antigo, reservado.
 * - previous_email: no CHANGE, o e-mail da conta no momento do pedido (a confirmação só vale se a conta
 *   ainda tiver esse e-mail); no REVERT, o e-mail que substituiu o antigo. Vazio só no VERIFY (CHECK).
 * - Um único pedido de troca em aberto por conta (UQ parcial) e a reserva dos endereços antigos
 *   (índice parcial por e-mail dos REVERT em aberto).
 */
@Entity('account_email_tokens')
@Check(
  'CHK_account_email_tokens_purpose',
  `"purpose" IN ('VERIFY', 'CHANGE', 'REVERT')`,
)
@Check(
  'CHK_account_email_tokens_previous',
  `("purpose" = 'VERIFY') = ("previous_email" IS NULL)`,
)
@Index('UQ_account_email_tokens_token_hash', ['token_hash'], { unique: true })
@Index('IDX_account_email_tokens_user_purpose_created', [
  'user_id',
  'purpose',
  'created_at',
])
@Index('IDX_account_email_tokens_expires', ['expires_at'])
@Index('UQ_account_email_tokens_open_change', ['user_id'], {
  unique: true,
  where: `"purpose" = 'CHANGE' AND ${OPEN}`,
})
@Index('IDX_account_email_tokens_reserved', ['email'], {
  where: `"purpose" = 'REVERT' AND ${OPEN}`,
})
export class AccountEmailToken {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_account_email_tokens',
  })
  id: number;

  @Column({ type: 'int' })
  user_id: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_account_email_tokens_user',
  })
  user?: Relation<User>;

  @Column({ type: 'varchar', length: 16 })
  purpose: AccountEmailTokenPurpose;

  @Column({ type: 'varchar', length: 320 })
  email: string;

  @Column({ type: 'varchar', length: 320, nullable: true })
  previous_email: string | null;

  @Column({ type: 'varchar', length: 64 })
  token_hash: string;

  @Column({ type: 'timestamptz' })
  expires_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  used_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  revoked_at: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  requested_ip: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
