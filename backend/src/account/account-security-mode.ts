/**
 * ACCOUNT_SECURITY_MODE (plano email-verification):
 * - compat (padrão): as rotas antigas usadas pelo app mobile mantêm o contrato (cadastro e troca de
 *   e-mail imediatos, com os avisos e a verificação em segundo plano);
 * - strict: recusa os caminhos antigos sem prova de posse do e-mail. Depende do app atualizado e é da
 *   fase 1b: nesta versão ele AINDA NÃO existe, então o valor strict é aceito na leitura mas a API segue
 *   em compat, com aviso na subida (STRICT_MODE_AVAILABLE).
 * Valor vazio ou inválido → compat.
 */
export type AccountSecurityMode = 'compat' | 'strict';

/** O modo strict já foi implementado nesta versão da API? (fase 1b) */
export const STRICT_MODE_AVAILABLE = false;

/** Valor configurado (sem considerar se o strict existe nesta versão). */
export function configuredAccountSecurityMode(
  env: NodeJS.ProcessEnv = process.env,
): AccountSecurityMode | 'invalid' {
  const raw = env.ACCOUNT_SECURITY_MODE?.trim().toLowerCase();
  if (!raw || raw === 'compat') return 'compat';
  if (raw === 'strict') return 'strict';
  return 'invalid';
}

/** Modo em vigor (o que a API aplica e o que GET /account/security informa). */
export function accountSecurityMode(
  env: NodeJS.ProcessEnv = process.env,
): AccountSecurityMode {
  return STRICT_MODE_AVAILABLE &&
    configuredAccountSecurityMode(env) === 'strict'
    ? 'strict'
    : 'compat';
}

/** Avisos da subida da API (AccountModule.onModuleInit), sem valores sensíveis. */
export function accountSecurityModeWarnings(
  env: NodeJS.ProcessEnv,
  mailConfigured: boolean,
): string[] {
  const configured = configuredAccountSecurityMode(env);
  if (configured === 'invalid') {
    return [
      'ACCOUNT_SECURITY_MODE inválido: use compat ou strict. A API segue no modo compat.',
    ];
  }
  if (configured !== 'strict') return [];
  if (!STRICT_MODE_AVAILABLE) {
    return [
      'ACCOUNT_SECURITY_MODE=strict ainda não está disponível nesta versão da API (fase 1b do plano de verificação de e-mail): a API segue no modo compat.',
    ];
  }
  return mailConfigured
    ? []
    : [
        'ACCOUNT_SECURITY_MODE=strict sem SMTP configurado: cadastros e trocas de e-mail não serão concluídos, porque os links não saem por e-mail.',
      ];
}
