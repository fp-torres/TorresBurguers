import { 
  Entity, PrimaryGeneratedColumn, Column, 
  CreateDateColumn, UpdateDateColumn, DeleteDateColumn,
  OneToMany 
} from 'typeorm';
import { Order } from '../../orders/entities/order.entity';
import { Address } from '../../addresses/entities/address.entity';

export enum UserRole {
  CLIENT = 'CLIENT',     
  ADMIN = 'ADMIN',       
  KITCHEN = 'KITCHEN',   
  COURIER = 'COURIER',   
  EMPLOYEE = 'EMPLOYEE', 
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column({ unique: true })
  email: string;

  // Nome da coluna no banco é 'password_hash', na classe é 'password_hash'
  @Column({ name: 'password_hash' }) 
  password_hash: string;

  @Column({ length: 20, nullable: true }) 
  phone: string;

  // --- CORREÇÃO: Coluna avatar presente ---
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
}