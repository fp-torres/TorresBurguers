import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/** Configuração única da loja (a linha de menor id é a vigente). */
@Entity('store_config')
export class StoreConfig {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ default: false })
  is_open: boolean;

  // Mensagens opcionais exibidas na vitrine (loja aberta / fechada)
  @Column({ type: 'varchar', nullable: true })
  opening_message: string | null;

  @Column({ type: 'varchar', nullable: true })
  closing_message: string | null;
}
