import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  OneToMany,
  ManyToOne,
  JoinColumn,
  Index,
  Check,
  type Relation,
} from 'typeorm';
import { Order } from '../../orders/entities/order.entity';
import { Address } from '../../addresses/entities/address.entity';
import { Store } from '../../store/entities/store.entity';

export enum UserRole {
  CLIENT = 'CLIENT', // Cliente: conta global, compra em qualquer loja
  ADMIN = 'ADMIN', // Administrador da loja: acesso total à própria loja
  KITCHEN = 'KITCHEN', // Cozinha
  COURIER = 'COURIER', // Entregador
  EMPLOYEE = 'EMPLOYEE', // Atendente: pedidos e loja, sem financeiro/produtos/usuários
}

/**
 * Papel GLOBAL na plataforma, separado do perfil operacional da loja (role).
 * Só é concedido pelo comando de bootstrap (npm run platform:superadmin), nunca por uma requisição HTTP.
 */
export enum PlatformRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
}

/**
 * Conta de acesso. Clientes (CLIENT) são globais: store_id nulo. A equipe (ADMIN, EMPLOYEE,
 * KITCHEN, COURIER) pertence a exatamente uma loja: store_id obrigatório (garantido pelo CHECK).
 */
@Entity('users')
// Busca por e-mail sem diferenciar maiúsculas (login, cadastro, "esqueci a senha"): índice de expressão
// (LOWER("email")), NÃO único (contas antigas podem diferir só na caixa), criado pela migration
// PerformanceIndexes. synchronize:false porque o TypeORM não compara expressões.
@Index('IDX_users_email_lower', { synchronize: false })
// Busca de contas do superpainel (ILIKE '%termo%'): GIN de trigramas em name e email, criados pela
// migration PerformanceIndexes só quando a extensão pg_trgm está disponível (synchronize:false)
@Index('IDX_users_name_trgm', { synchronize: false })
@Index('IDX_users_email_trgm', { synchronize: false })
@Check(
  'CHK_users_store_membership',
  `("role" = 'CLIENT' AND "store_id" IS NULL) OR ("role" <> 'CLIENT' AND "store_id" IS NOT NULL)`,
)
// Papel global (SUPER_ADMIN) só em conta CLIENT sem loja (migration PlatformIntegrity)
@Check(
  'CHK_users_platform_role',
  `"platform_role" IS NULL OR ("role" = 'CLIENT' AND "store_id" IS NULL)`,
)
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  // Gravado sem espaços e em minúsculas (ver users/email.ts)
  @Column({ unique: true })
  email: string;

  // select:false → o hash nunca é carregado nas consultas (nem em relações como order.user / order.driver).
  // Só o login pede a coluna explicitamente (UsersService.findForLogin).
  @Column({ name: 'password_hash', select: false })
  password_hash: string;

  // varchar(20) opcional; null = sem telefone (o tipo explícito mantém o schema igual)
  @Column({ type: 'varchar', length: 20, nullable: true })
  phone: string | null;

  @Column({ nullable: true })
  avatar: string;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.CLIENT })
  role: UserRole;

  /** Loja da equipe (null para clientes e para a equipe da plataforma). */
  @Index('IDX_users_store_id')
  @Column({ type: 'int', nullable: true })
  store_id: number | null;

  @ManyToOne(() => Store, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'store_id', foreignKeyConstraintName: 'FK_users_store' })
  store?: Relation<Store> | null;

  /** Superadministrador da plataforma (null = sem privilégio global). */
  @Column({
    type: 'enum',
    enum: PlatformRole,
    nullable: true,
  })
  platform_role: PlatformRole | null;

  /** Conta bloqueada (ex.: comprometida): não entra e os tokens deixam de valer. */
  @Column({ type: 'timestamptz', nullable: true })
  blocked_at: Date | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  blocked_reason: string | null;

  /**
   * Versão das sessões: vai no JWT (claim "tv"). Incrementar invalida todos os tokens já emitidos
   * (redefinição de senha, bloqueio, "encerrar sessões").
   */
  @Column({ type: 'int', default: 0 })
  token_version: number;

  @Column({ type: 'timestamptz', nullable: true })
  last_login_at: Date | null;

  /**
   * Quando a pessoa confirmou que recebe e-mails neste endereço (link de verificação, troca confirmada,
   * "Não fui eu" ou redefinição de senha pedida por e-mail). null = não confirmado. Trocar o e-mail sem
   * confirmação (rota antiga PATCH /users/:id) volta para null. Migration AccountEmailVerification.
   */
  @Column({ type: 'timestamptz', nullable: true })
  email_verified_at: Date | null;

  @OneToMany(() => Order, (order) => order.user)
  orders: Order[];

  @OneToMany(() => Address, (address) => address.user)
  addresses: Address[];

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @DeleteDateColumn()
  deleted_at: Date;

  // Garantia extra para entidades serializadas direto (ex.: order.user / order.driver): nunca saem o
  // hash da senha nem os campos internos da conta (versão das sessões, bloqueio, último acesso, papel
  // na plataforma), e a loja vai só como resumo. As respostas de conta usam users/session-user.ts.
  toJSON(): Partial<User> {
    const data: Partial<User> = { ...this };
    delete data.password_hash;
    delete data.token_version;
    delete data.blocked_at;
    delete data.blocked_reason;
    delete data.last_login_at;
    delete data.platform_role;
    // Situação do e-mail: só em GET /account/security (as respostas usadas pelo app não mudam)
    delete data.email_verified_at;
    if (data.store) {
      const { id, slug, name, logo } = data.store;
      data.store = { id, slug, name, logo } as Store;
    }
    return data;
  }
}
