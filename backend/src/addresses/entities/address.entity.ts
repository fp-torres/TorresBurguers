import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

@Entity('addresses')
export class Address {
  @PrimaryGeneratedColumn()
  id: number;

  // Novos cadastros guardam só os 8 dígitos (ex.: 22041001)
  @Column()
  zipCode: string;

  @Column()
  street: string;

  @Column()
  number: string;

  @Column({ nullable: true })
  complement: string;

  @Column()
  neighborhood: string;

  @Column()
  city: string;

  @Column({ length: 2 })
  state: string;

  @Column({ nullable: true })
  nickname: string;

  // --- NOVOS CAMPOS PARA MAPA E ROTA ---
  // Necessários para o cálculo de distância e visualização no mapa
  @Column({ type: 'float', nullable: true })
  latitude: number;

  @Column({ type: 'float', nullable: true })
  longitude: number;
  // -------------------------------------

  @ManyToOne(() => User, (user) => user.addresses, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @CreateDateColumn()
  created_at: Date;

  /**
   * Exclusão lógica feita pelo cliente (DELETE /addresses/:id).
   * Coluna comum (não @DeleteDateColumn) de propósito: pedidos antigos continuam carregando
   * o endereço normalmente, enquanto as consultas de endereços filtram deleted_at IS NULL.
   * Fica fora dos SELECTs (select: false) para não aparecer nas respostas.
   */
  @Column({ type: 'timestamp', nullable: true, select: false })
  deleted_at: Date | null;
}
