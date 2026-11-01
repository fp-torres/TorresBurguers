import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { demoSuperadminSeedAllowed, demoUsersSeedMode } from '../config/env';
import { ensureDemoStore } from './seeds/demo-store';
import {
  demoSuperadminsWithPublicPassword,
  seedDefaultUsers,
} from './seeds/seed-default-users';

/**
 * Cria os dados de demonstração na subida da API, se ainda não existirem: a loja demo (só quando o
 * banco não tem nenhuma loja) e os usuários padrão (um por perfil da loja + cliente).
 * Só em NODE_ENV=development ou test (desligue com SEED_DEMO_USERS=false).
 * O superadmin de demonstração (papel global, senha pública) só entra em test ou com
 * SEED_DEMO_SUPERADMIN=true em development (config/env.ts → demoSuperadminSeedAllowed).
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
      const { store, created } = await ensureDemoStore(this.users.manager);
      if (created) {
        this.logger.log(
          `Loja de demonstração criada: ${store.name} (/loja/${store.slug}).`,
        );
      }
      const includeSuperadmin = demoSuperadminSeedAllowed();
      const report = await seedDefaultUsers(this.users, {
        resetPasswords: false,
        storeId: store.id,
        includeSuperadmin,
      });
      report.forEach((line) => this.logger.log(`Usuário padrão ${line}`));
      if (!includeSuperadmin) await this.warnPublicSuperadmin();
    } catch (error) {
      this.logger.error(
        `Não foi possível criar os dados de demonstração: ${(error as Error).message}`,
      );
    }
  }

  /** Superadmin de demonstração criado por uma versão anterior, ainda com a senha pública do código. */
  private async warnPublicSuperadmin(): Promise<void> {
    const exposed = await demoSuperadminsWithPublicPassword(this.users);
    for (const email of exposed) {
      this.logger.warn(
        `A conta ${email} tem papel de SUPERADMIN com a senha pública de demonstração. Qualquer pessoa que ` +
          'alcance esta API (rede local, túnel) administra a plataforma inteira. Troque a senha ou remova o papel: ' +
          `npm run platform:superadmin -- --email=${email} --revoke`,
      );
    }
  }
}
