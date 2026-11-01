import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

/** Rotinas de manutenção da plataforma que rodam em segundo plano (uma execução por vez de cada tipo). */
export enum MaintenanceJobKind {
  OPTIMIZE_IMAGES = 'optimize_images',
  /** Limpeza dos arquivos de /uploads que nenhum cadastro usa (só verificar ou apagar). */
  CLEANUP_UPLOADS = 'cleanup_uploads',
}

export enum MaintenanceJobStatus {
  RUNNING = 'RUNNING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
}

/** Contagens da otimização de imagens (parciais durante a execução, finais ao terminar). */
export interface ImageOptimizationCounts {
  /** Total de imagens convertidas para WebP (produtos + adicionais + avatares). */
  items_processed: number;
  products: number;
  addons: number;
  avatars: number;
  /** Arquivo ausente no disco, ilegível ou nome fora da pasta de uploads. */
  skipped: number;
}

/** Modo da limpeza de arquivos: check = só relatório (nada é apagado); delete = apaga os arquivos sem uso. */
export type UploadsCleanupMode = 'check' | 'delete';

/**
 * Contagens da limpeza de arquivos sem uso (parciais durante a execução, finais ao terminar).
 * Só números: nunca nomes de arquivo nem caminhos.
 */
export interface UploadsCleanupCounts {
  mode: UploadsCleanupMode;
  /** Idade mínima (pela data de modificação) para um arquivo sem uso entrar na limpeza, em horas. */
  min_age_hours: number;
  /** Imagens examinadas no primeiro nível da pasta de uploads. */
  files_scanned: number;
  /** Usadas por algum cadastro (produtos e adicionais, inclusive na lixeira, fotos de perfil e logos): mantidas. */
  in_use: number;
  /** Sem uso, mas modificadas há menos de min_age_hours (um envio ainda não salvo no cadastro): mantidas. */
  recent: number;
  /** Sem uso e antigas: o que a limpeza apaga (no modo delete, as apagadas + as que falharam ao final). */
  orphans: number;
  /** Tamanho somado das sem uso, em bytes. */
  orphan_bytes: number;
  /** Apagadas (só no modo delete). */
  deleted: number;
  deleted_bytes: number;
  /** Não foi possível apagar (erro do disco): continuam na pasta. */
  failed: number;
  /** Ignoradas e nunca apagadas: pastas, atalhos, ocultos, nomes fora do padrão e arquivos que não são imagem. */
  skipped: number;
}

/** Resumo gravado na execução (o formato depende do tipo). */
export type MaintenanceJobSummary =
  | ImageOptimizationCounts
  | UploadsCleanupCounts;

/**
 * Execução de uma rotina de manutenção (ex.: otimização das imagens de uploads), iniciada pelo
 * superadmin e processada em segundo plano. A trava é do banco, não da memória: o índice único parcial
 * (kind) WHERE status = 'RUNNING' garante UMA execução por vez de cada tipo entre todas as instâncias
 * da API. A rotina renova heartbeat_at a cada lote; uma execução RUNNING com o heartbeat parado (instância
 * que caiu) é marcada FAILED ("interrompida") quando alguém consulta ou tenta iniciar outra.
 */
@Entity('maintenance_jobs')
@Check(
  'CHK_maintenance_jobs_status',
  `"status" IN ('RUNNING', 'SUCCEEDED', 'FAILED')`,
)
// Índice único parcial (kind) WHERE status = 'RUNNING': criado pela migration MaintenanceJobs.
// synchronize:false porque o TypeORM não compara o WHERE de forma estável (recriaria o índice a cada subida).
@Index('UQ_maintenance_jobs_kind_running', { synchronize: false })
export class MaintenanceJob {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 40 })
  kind: MaintenanceJobKind;

  @Column({ type: 'varchar', length: 20 })
  status: MaintenanceJobStatus;

  /** Superadmin que iniciou (null se a conta for apagada). */
  @Column({ type: 'int', nullable: true })
  started_by_user_id: number | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'started_by_user_id',
    foreignKeyConstraintName: 'FK_maintenance_jobs_started_by',
  })
  started_by?: Relation<User> | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  started_at: Date;

  /** Última notícia da execução (renovada a cada lote). Parado há muito tempo = instância caiu. */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  heartbeat_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  finished_at: Date | null;

  /** Contagens (parciais enquanto RUNNING). Nunca guarda caminhos, nomes de arquivo ou segredos. */
  @Column({ type: 'jsonb', nullable: true })
  summary: MaintenanceJobSummary | null;

  /** Motivo curto da falha (sem stack, caminhos ou segredos: os detalhes ficam no log da API). */
  @Column({ type: 'varchar', length: 300, nullable: true })
  error: string | null;
}
