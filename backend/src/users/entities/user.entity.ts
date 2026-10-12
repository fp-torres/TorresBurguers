import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  OneToMany,
} from 'typeorm';
import { Order } from '../../orders/entities/order.entity';
import { Address } from '../../addresses/entities/address.entity';

export enum UserRole {
  CLIENT = 'CLIENT', // Cliente da loja
  ADMIN = 'ADMIN', // Administrador: acesso total
  KITCHEN = 'KITCHEN', // Cozinha
  COURIER = 'COURIER', // Entregador
  EMPLOYEE = 'EMPLOYEE', // Atendente: pedidos e loja, sem financeiro/produtos/usuários
}

@Entity('users')
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

  // Garantia extra: mesmo que o hash seja carregado, ele nunca sai no JSON das respostas
  toJSON(): Partial<User> {
    const data: Partial<User> = { ...this };
    delete data.password_hash;
    return data;
  }
}
