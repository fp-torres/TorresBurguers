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
import { User } from '../../users/entities/user.entity';

/**
 * Pedido de redefinição de senha: uso único e prazo curto. O token só existe no link enviado;
 * o banco guarda o hash SHA-256.
 */
@Entity('password_reset_tokens')
export class PasswordResetToken {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('IDX_password_reset_tokens_user_id')
  @Column({ type: 'int' })
  user_id: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_password_reset_tokens_user',
  })
  user?: Relation<User>;

  @Index('UQ_password_reset_tokens_token_hash', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  token_hash: string;

  @Column({ type: 'timestamptz' })
  expires_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  used_at: Date | null;

  /** Superadmin que gerou o link (null = o próprio usuário pediu em "Esqueci a senha"). */
  @Column({ type: 'int', nullable: true })
  created_by_user_id: number | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'created_by_user_id',
    foreignKeyConstraintName: 'FK_password_reset_tokens_created_by',
  })
  created_by?: Relation<User> | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  requested_ip: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
