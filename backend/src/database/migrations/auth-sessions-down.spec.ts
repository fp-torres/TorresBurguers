import type { QueryRunner } from 'typeorm';
import { AuthSessions1792964108700 } from './1792964108700-AuthSessions';

/** QueryRunner falso: registra os comandos na ordem. */
function fakeRunner() {
  const statements: string[] = [];
  const runner = {
    query: jest.fn((sql: string) => {
      statements.push(sql);
      return Promise.resolve([]);
    }),
  };
  return { runner: runner as unknown as QueryRunner, statements };
}

describe('AuthSessions.down(): reverter não ressuscita sessões encerradas', () => {
  it('muda a versão das sessões de todas as contas ANTES de apagar auth_sessions', async () => {
    // A API anterior ignora o "jti": sem isso, o token de um aparelho encerrado (logout, "encerrar
    // sessão") voltaria a valer até expirar. As linhas revogadas podem até já ter sido limpas, então a
    // única forma segura é derrubar todos os tokens emitidos até aqui (token_version + 1).
    const { runner, statements } = fakeRunner();
    await new AuthSessions1792964108700().down(runner);

    const bump = statements.findIndex((sql) =>
      /UPDATE "users" SET "token_version" = "token_version" \+ 1/.test(sql),
    );
    const drop = statements.findIndex((sql) =>
      /DROP TABLE "auth_sessions"/.test(sql),
    );
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(drop).toBeGreaterThan(bump);
    // Sem WHERE: vale para todas as contas (inclusive as que já limparam as sessões revogadas)
    expect(statements[bump]).not.toMatch(/WHERE/i);
  });
});
