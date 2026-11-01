import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  type Relation,
} from 'typeorm';
import type { StoreDeliveryZonesConfig } from '../../orders/order-rules';
import { User } from '../../users/entities/user.entity';

/**
 * Situação da loja na plataforma (definida pelo superadministrador):
 * - ACTIVE: opera normalmente;
 * - SUSPENDED: suspensa (ex.: política ou inadimplência); dados preservados, sem novos pedidos;
 * - INACTIVE: desativada; some da vitrine e a equipe não entra no painel. Pode ser restaurada.
 */
export enum StoreAccountStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  INACTIVE = 'INACTIVE',
}

/** Horário de funcionamento informativo de um dia da semana (0 = domingo). */
export interface OpeningHoursEntry {
  day: number;
  open: string; // HH:MM
  close: string; // HH:MM (menor que open = vira a madrugada)
}

/**
 * Estabelecimento (tenant). Cada loja tem a própria equipe, cardápio, pedidos, pagamentos,
 * configurações de entrega e identidade visual. A marca da plataforma (Comestra) fica em config/brand.ts.
 */
@Entity('stores')
export class Store {
  @PrimaryGeneratedColumn()
  id: number;

  /** Identificador público na URL (/loja/<slug>): minúsculas, números e hífens. */
  @Index('UQ_stores_slug', { unique: true })
  @Column({ type: 'varchar', length: 60 })
  slug: string;

  /** Nome comercial exibido na vitrine e no painel. */
  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 160, nullable: true })
  legal_name: string | null;

  /** CNPJ (14 dígitos) ou CPF (11 dígitos), só números. */
  @Column({ type: 'varchar', length: 14, nullable: true })
  document: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  email: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phone: string | null;

  /** Texto curto de apresentação na vitrine. */
  @Column({ type: 'varchar', length: 300, nullable: true })
  description: string | null;

  // --- Identidade visual da loja ---

  /** Nome do arquivo do logo em /uploads, com o prefixo da loja (ex.: s3-compressed-....webp; ver common/uploads/store-files.ts). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  logo: string | null;

  /** Cor principal no formato #RRGGBB. */
  @Column({ type: 'varchar', length: 7, nullable: true })
  primary_color: string | null;

  // --- Endereço ---

  @Column({ type: 'varchar', length: 8, nullable: true })
  address_zip_code: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  address_street: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  address_number: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  address_complement: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  address_neighborhood: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  address_city: string | null;

  @Column({ type: 'varchar', length: 2, nullable: true })
  address_state: string | null;

  /**
   * Local da loja no mapa (graus decimais), ponto de partida da entrega por distância. Obtido no painel
   * localizando o endereço acima (com ajuste manual); as duas juntas ou nenhuma.
   */
  @Column({ type: 'double precision', nullable: true })
  latitude: number | null;

  @Column({ type: 'double precision', nullable: true })
  longitude: number | null;

  // --- Situação na plataforma ---

  @Column({
    type: 'enum',
    enum: StoreAccountStatus,
    default: StoreAccountStatus.ACTIVE,
  })
  account_status: StoreAccountStatus;

  /** Motivo da última suspensão/desativação (exibido à equipe e no superpainel). */
  @Column({ type: 'varchar', length: 300, nullable: true })
  status_reason: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  status_changed_at: Date | null;

  // --- Operação ---

  /** Loja aberta para novos pedidos agora (interruptor da equipe). */
  @Column({ default: false })
  is_open: boolean;

  @Column({ type: 'varchar', length: 200, nullable: true })
  opening_message: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  closing_message: string | null;

  @Column({ default: true })
  delivery_enabled: boolean;

  @Column({ default: true })
  takeout_enabled: boolean;

  /**
   * Taxas e prazos de entrega por bairro ou faixa de CEP, e a política para endereços fora das zonas
   * (outside_zones). Null = padrão da plataforma (DELIVERY_ZONES_*), só na loja padrão.
   */
  @Column({ type: 'jsonb', nullable: true })
  delivery_zones: StoreDeliveryZonesConfig | null;

  /** Prazo da retirada no balcão (ex.: "15-20 min"). Null = padrão. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  takeout_estimate: string | null;

  /** Horários de funcionamento exibidos na vitrine. */
  @Column({ type: 'jsonb', nullable: true })
  opening_hours: OpeningHoursEntry[] | null;

  /** Fuso do "hoje" e dos gráficos da loja. */
  @Column({ type: 'varchar', length: 64, default: 'America/Sao_Paulo' })
  time_zone: string;

  // --- Pagamentos online (conta Mercado Pago da própria loja) ---

  /** Chave PÚBLICA (tokenização do cartão no navegador). */
  @Column({ type: 'varchar', length: 120, nullable: true })
  mp_public_key: string | null;

  /** Access Token criptografado (AES-256-GCM). Nunca sai nas respostas da API. */
  @Column({ type: 'text', nullable: true, select: false })
  mp_access_token_encrypted: string | null;

  /** Domínio próprio (evolução futura; ainda não roteado automaticamente). */
  @Index('UQ_stores_custom_domain', { unique: true })
  @Column({ type: 'varchar', length: 253, nullable: true })
  custom_domain: string | null;

  /** Responsável principal pela loja. */
  @Column({ type: 'int', nullable: true })
  owner_user_id: number | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'owner_user_id',
    foreignKeyConstraintName: 'FK_stores_owner_user',
  })
  owner?: Relation<User> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
