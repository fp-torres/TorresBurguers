import { 
  Entity, PrimaryGeneratedColumn, Column, 
  CreateDateColumn, UpdateDateColumn, OneToMany 
} from 'typeorm';
import { Order } from '../../orders/entities/order.entity';
import { Address } from '../../addresses/entities/address.entity'; // <--- Importe o novo Address

export enum UserRole {
  CLIENT = 'CLIENT',
  ADMIN = 'ADMIN',
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column({ unique: true })
  email: string;

  @Column({ name: 'password_hash' }) 
  password_hash: string;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.CLIENT })
  role: UserRole;

  @OneToMany(() => Order, (order) => order.user)
  orders: Order[];

  // --- NOVA RELAÇÃO: Um usuário tem vários endereços ---
  @OneToMany(() => Address, (address) => address.user)
  addresses: Address[];
  // ----------------------------------------------------

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}