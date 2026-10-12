import { NestFactory } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
// Importar o AppModule já carrega o .env (ConfigModule.forRoot) para process.env
import { AppModule } from '../app.module';
import { isProduction } from '../config/env';
import { User } from '../users/entities/user.entity';
import { DEFAULT_USERS } from './seeds/default-users';
import { seedDefaultUsers } from './seeds/seed-default-users';

// npm run seed — cria/restaura os usuários padrão e redefine as senhas documentadas no README.
// Em produção (inclusive NODE_ENV vazio ou desconhecido) só roda com: npm run seed -- --force
async function main() {
  if (isProduction()) {
    if (!process.argv.includes('--force')) {
      console.error(
        [
          'Seed recusado: o ambiente é de produção (NODE_ENV vazio ou desconhecido também conta).',
          'Ele cria ou restaura contas com as senhas públicas do README e redefine as senhas delas.',
          '- Em uma máquina de desenvolvimento, defina NODE_ENV=development no .env.',
          '- Para recuperar o acesso em produção: npm run seed -- --force e troque as senhas logo em seguida.',
        ].join('\n'),
      );
      process.exit(1);
    }
    console.warn(
      '⚠ --force em produção: as contas padrão ficam com as senhas públicas do README. Troque-as em seguida.',
    );
  }

  // Este script faz o seed completo; o seed automático da subida fica desligado para o relatório sair fiel
  process.env.SEED_DEMO_USERS = 'false';

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const repo = app.get<Repository<User>>(getRepositoryToken(User));
    const report = await seedDefaultUsers(repo, { resetPasswords: true });
    report.forEach((line) => console.log(`✔ ${line}`));
    console.table(
      DEFAULT_USERS.map(({ role, email, password }) => ({
        perfil: role,
        email,
        senha: password,
      })),
    );
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('Falha ao executar o seed:', err);
  process.exit(1);
});
