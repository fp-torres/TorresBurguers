import 'reflect-metadata';
import dataSource from '../../database/data-source';
import { runSuperadminCommand } from './superadmin-command';

/**
 * Bootstrap controlado do superadministrador da plataforma (o único jeito de conceder o papel global;
 * nenhuma rota HTTP faz isso). Roda no servidor, com acesso direto ao banco:
 *
 *   npm run platform:superadmin -- --email=ops@empresa.com --name="Nome Sobrenome"
 *   npm run platform:superadmin -- --email=ops@empresa.com --promote-existing
 *   npm run platform:superadmin -- --email=ops@empresa.com --reset-password
 *   npm run platform:superadmin -- --email=ops@empresa.com --revoke
 *
 * - Conta inexistente: é criada com uma senha forte aleatória, exibida UMA vez (ou com a senha de
 *   SUPERADMIN_PASSWORD, se definida no ambiente) — troque-a no primeiro acesso.
 * - Conta existente de cliente: recusada, com os dados da conta (o cadastro é público: pode ter sido
 *   plantada por outra pessoa). Com --promote-existing recebe o papel global com SENHA NOVA, sessões
 *   encerradas e links de redefinição pendentes invalidados.
 * - Superadmin existente: --reset-password troca a senha e encerra as sessões (recuperação de acesso).
 * - Conta da equipe de uma loja não pode ser superadmin (papéis separados): use outro e-mail.
 * Toda concessão/revogação fica na auditoria (escopo SYSTEM). Regras em superadmin-command.ts.
 */

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length).trim();
  const index = process.argv.indexOf(`--${name}`);
  const next = index >= 0 ? process.argv[index + 1] : undefined;
  return next && !next.startsWith('--') ? next.trim() : undefined;
}

async function main(): Promise<void> {
  const options = {
    email: arg('email'),
    name: arg('name'),
    revoke: process.argv.includes('--revoke'),
    promoteExisting: process.argv.includes('--promote-existing'),
    resetPassword: process.argv.includes('--reset-password'),
    password: process.env.SUPERADMIN_PASSWORD,
  };
  if (!options.email) {
    // Mesma mensagem de uso do comando, sem abrir conexão com o banco
    process.exit(await runSuperadminCommand(dataSource, options, console));
  }

  await dataSource.initialize();
  let exitCode = 1;
  try {
    if (await dataSource.showMigrations()) {
      console.error(
        'Há migrations pendentes. Rode "npm run migration:run" (ou suba a API uma vez) antes de configurar o superadmin.',
      );
    } else {
      exitCode = await runSuperadminCommand(dataSource, options, console);
    }
  } finally {
    await dataSource.destroy();
  }
  process.exit(exitCode);
}

main().catch((error: unknown) => {
  console.error(
    'Falha ao configurar o superadmin:',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
