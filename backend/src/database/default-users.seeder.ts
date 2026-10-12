import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { demoUsersSeedMode } from '../config/env';
import { seedDefaultUsers } from './seeds/seed-default-users';

/**
 * Cria os usuários padrão (um por perfil) na subida da API, se ainda não existirem.
 * Só em NODE_ENV=development ou test (desligue com SEED_DEMO_USERS=false).
 * Em produção nunca cria: as senhas são públicas. SEED_DEMO_USERS=true lá só gera um erro no log.
 */
@Injectable()
export class DefaultUsersSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(DefaultUsersSeeder.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  async onApplicationBootstrap() {
    const mode = demoUsersSeedMode();
    if (mode === 'off') return;

    if (mode === 'refused') {
      this.logger.error(
        'SEED_DEMO_USERS=true ignorado: os usuários padrão têm senhas públicas e nunca são criados em produção ' +
          '(NODE_ENV vazio ou desconhecido também conta como produção). Em máquinas de desenvolvimento use NODE_ENV=development.',
      );
      return;
    }

    // Falha no seed não derruba a API: só registra no log
    try {
      const report = await seedDefaultUsers(this.users, {
        resetPasswords: false,
      });
      report.forEach((line) => this.logger.log(`Usuário padrão ${line}`));
    } catch (error) {
      this.logger.error(
        `Não foi possível criar os usuários padrão: ${(error as Error).message}`,
      );
    }
  }
}
