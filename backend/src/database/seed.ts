import { NestFactory } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
// Importar o AppModule já carrega o .env (ConfigModule.forRoot) para process.env
import { AppModule } from '../app.module';
import { User } from '../users/entities/user.entity';
import { ensureDemoStore } from './seeds/demo-store';
import { defaultUsersFor, seedDefaultUsers } from './seeds/seed-default-users';
import {
  SEED_REFUSED_IN_PRODUCTION,
  seedAllowed,
  seedIncludesSuperadmin,
} from './seeds/seed-policy';

// npm run seed — cria/restaura os usuários padrão (development/test) e redefine as senhas documentadas no
// README. Nunca roda em produção (inclusive NODE_ENV vazio ou desconhecido), nem com --force.
// O superadmin de demonstração só entra com --with-superadmin ou SEED_DEMO_SUPERADMIN=true (test: padrão).
async function main() {
  if (!seedAllowed()) {
    console.error(SEED_REFUSED_IN_PRODUCTION);
    process.exit(1);
  }
  const includeSuperadmin = seedIncludesSuperadmin();

  // Este script faz o seed completo; o seed automático da subida fica desligado para o relatório sair fiel
  process.env.SEED_DEMO_USERS = 'false';

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const repo = app.get<Repository<User>>(getRepositoryToken(User));
    const { store, created } = await ensureDemoStore(repo.manager);
    console.log(
      `✔ loja da equipe demo: ${store.name} (/loja/${store.slug})${created ? ' — criada agora' : ''}`,
    );
    const report = await seedDefaultUsers(repo, {
      resetPasswords: true,
      storeId: store.id,
      includeSuperadmin,
    });
    report.forEach((line) => console.log(`✔ ${line}`));
    console.table(
      defaultUsersFor(includeSuperadmin).map(
        ({ role, platformRole, email, password }) => ({
          perfil: platformRole ?? role,
          email,
          senha: password,
        }),
      ),
    );
    if (!includeSuperadmin) {
      console.log(
        'ℹ Superadmin de demonstração não incluído (papel global com senha pública). Para criá-lo nesta ' +
          'máquina de desenvolvimento: npm run seed -- --with-superadmin (ou SEED_DEMO_SUPERADMIN=true).',
      );
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('Falha ao executar o seed:', err);
  process.exit(1);
});
