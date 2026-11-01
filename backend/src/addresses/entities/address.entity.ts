import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Check,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import type { CepStatus, NeighborhoodSource } from '../address-location';

@Entity('addresses')
@Check(
  'CHK_addresses_neighborhood_source',
  `"neighborhood_source" IN ('CEP', 'MANUAL')`,
)
@Check(
  'CHK_addresses_cep_status',
  `"cep_status" IN ('FOUND', 'NO_NEIGHBORHOOD', 'NOT_FOUND', 'UNAVAILABLE')`,
)
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

  // --- LOCALIZAÇÃO PELO CEP (zona de entrega; ver address-location.ts) ---
  // O que o cliente digitou continua em neighborhood/city/state (é o que aparece no pedido); a zona de
  // entrega usa o bairro e a cidade canônicos do CEP quando conferidos.

  /** Bairro do CEP (só quando o CEP tem bairro: neighborhood_source = CEP). */
  @Column({ type: 'varchar', length: 100, nullable: true })
  canonical_neighborhood: string | null;

  /** Cidade do CEP (CEP encontrado, com ou sem bairro). */
  @Column({ type: 'varchar', length: 100, nullable: true })
  canonical_city: string | null;

  /** UF do CEP (CEP encontrado, com ou sem bairro). */
  @Column({ type: 'varchar', length: 2, nullable: true })
  canonical_state: string | null;

  /**
   * CEP: bairro confirmado pelo CEP · MANUAL: bairro informado manualmente (CEP inexistente, sem bairro ou
   * serviço de CEP fora do ar) · null: endereço ainda não conferido (cadastrado antes da conferência).
   */
  @Column({ type: 'varchar', length: 10, nullable: true })
  neighborhood_source: NeighborhoodSource | null;

  /** FOUND, NO_NEIGHBORHOOD, NOT_FOUND ou UNAVAILABLE (null = ainda não conferido). */
  @Column({ type: 'varchar', length: 16, nullable: true })
  cep_status: CepStatus | null;

  /** Quando o CEP foi conferido (UNAVAILABLE: o orçamento tenta de novo depois de 1 h). */
  @Column({ type: 'timestamptz', nullable: true })
  cep_checked_at: Date | null;
  // -------------------------------------

  // Lista de endereços do cliente e checkout (migration PerformanceIndexes)
  @Index('IDX_addresses_user_id')
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
