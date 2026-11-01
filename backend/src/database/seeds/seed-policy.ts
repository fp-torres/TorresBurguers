import { demoSuperadminSeedAllowed, isProduction } from '../../config/env';

/**
 * Regras do `npm run seed` (database/seed.ts), separadas para teste: o script cria/restaura contas com
 * as senhas públicas do README, redefine as senhas delas e desbloqueia contas de e-mail coincidente.
 */
export const SEED_REFUSED_IN_PRODUCTION = [
  'Seed recusado: o ambiente é de produção (NODE_ENV vazio ou desconhecido também conta), com ou sem --force.',
  'Ele cria ou restaura contas com as senhas públicas do README, redefine as senhas delas e desbloqueia contas.',
  '- Em uma máquina de desenvolvimento, defina NODE_ENV=development no .env.',
  '- Primeiro superadministrador em produção: npm run platform:superadmin -- --email=<e-mail> (senha aleatória exibida uma vez).',
  '- Superadmin sem acesso: npm run platform:superadmin -- --email=<e-mail> --reset-password (nova senha e sessões encerradas).',
  '- Demais contas: o superpainel gera o link de redefinição de senha (Usuários → Redefinir senha).',
].join('\n');

/** O seed pode rodar? Produção nunca (o antigo --force não muda isso). */
export function seedAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isProduction(env);
}

/**
 * Incluir o superadmin de demonstração (papel global, senha pública) nesta execução? Só fora de
 * produção e com opção explícita: --with-superadmin ou SEED_DEMO_SUPERADMIN=true (em test, por padrão).
 */
export function seedIncludesSuperadmin(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const explicit = argv.includes('--with-superadmin');
  return demoSuperadminSeedAllowed(
    explicit ? { ...env, SEED_DEMO_SUPERADMIN: 'true' } : env,
  );
}
