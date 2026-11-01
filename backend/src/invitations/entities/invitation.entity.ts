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
 * Convite para entrar na equipe de uma loja (ex.: responsável de um estabelecimento novo).
 * O token só aparece uma vez (no link); o banco guarda apenas o hash SHA-256.
 */
@Entity('invitations')
// Um único convite em aberto por loja + e-mail: índice único parcial
// (store_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL, criado pela migration TenancyIndexes
@Index('UQ_invitations_store_email_pending', { synchronize: false })
export class Invitation {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('IDX_invitations_store_id')
  @Column({ type: 'int' })
  store_id: number;

  @ManyToOne(() => Store, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'store_id',
    foreignKeyConstraintName: 'FK_invitations_store',
  })
  store?: Relation<Store>;

  @Index('IDX_invitations_email')
  @Column({ type: 'varchar', length: 160 })
  email: string;

  /** Perfil na loja: ADMIN, EMPLOYEE, KITCHEN ou COURIER. */
  @Column({ type: 'varchar', length: 20 })
  role: string;

  /** Torna este convidado o responsável principal (stores.owner_user_id) ao aceitar. */
  @Column({ default: false })
  make_owner: boolean;

  @Index('UQ_invitations_token_hash', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  token_hash: string;

  @Column({ type: 'timestamptz' })
  expires_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  accepted_at: Date | null;

  @Column({ type: 'int', nullable: true })
  accepted_user_id: number | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'accepted_user_id',
    foreignKeyConstraintName: 'FK_invitations_accepted_user',
  })
  accepted_user?: Relation<User> | null;

  @Column({ type: 'timestamptz', nullable: true })
  revoked_at: Date | null;

  @Column({ type: 'int', nullable: true })
  invited_by_user_id: number | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'invited_by_user_id',
    foreignKeyConstraintName: 'FK_invitations_invited_by',
  })
  invited_by?: Relation<User> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
