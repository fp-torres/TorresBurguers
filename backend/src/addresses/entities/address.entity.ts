import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { User } from '../../users/entities/user.entity';

@Entity('addresses')
export class Address {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  zipCode: string; // CEP (ex: 20000-000)

  @Column()
  street: string; // Logradouro

  @Column()
  number: string; // Número (string pois pode ser "S/N" ou "10B")

  @Column({ nullable: true })
  complement: string; // Apto 101, Fundos

  @Column()
  neighborhood: string; // Bairro

  @Column()
  city: string;

  @Column({ length: 2 })
  state: string; // UF (RJ, SP)

  @Column({ nullable: true })
  nickname: string; // "Casa", "Trabalho"

  // Relação: Muitos endereços pertencem a um Usuário
  @ManyToOne(() => User, (user) => user.addresses, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @CreateDateColumn()
  created_at: Date;
}