import { FindOperator } from 'typeorm';
import { PasswordResetToken } from './entities/password-reset-token.entity';
import {
  expirePendingResetLinks,
  expirePendingResetLinksOfStoreTeam,
} from './reset-links';

type Where = Record<string, FindOperator<unknown> | number>;

function fakeManager() {
  const repo = { update: jest.fn().mockResolvedValue({ affected: 2 }) };
  const manager = { getRepository: jest.fn(() => repo) };
  return { repo, manager };
}

describe('links de redefinição pendentes', () => {
  const NOW = new Date('2026-10-31T12:00:00Z');

  it('expirePendingResetLinks vence só os links da conta ainda em aberto e no prazo', async () => {
    const { repo, manager } = fakeManager();
    await expirePendingResetLinks(manager as never, 7, NOW);
    expect(manager.getRepository).toHaveBeenCalledWith(PasswordResetToken);
    const [where, set] = repo.update.mock.calls[0] as [Where, unknown];
    expect(where.user_id).toBe(7);
    expect((where.used_at as FindOperator<unknown>).type).toBe('isNull');
    expect((where.expires_at as FindOperator<unknown>).type).toBe('moreThan');
    expect(set).toEqual({ expires_at: NOW });
  });

  it('expirePendingResetLinksOfStoreTeam vence os links de toda a equipe da loja numa escrita só', async () => {
    const { repo, manager } = fakeManager();
    await expirePendingResetLinksOfStoreTeam(manager as never, 42, NOW);
    expect(repo.update).toHaveBeenCalledTimes(1);
    const [where, set] = repo.update.mock.calls[0] as [Where, unknown];
    const team = where.user_id as FindOperator<unknown>;
    expect(team.type).toBe('raw');
    // Subconsulta da equipe (nunca clientes), com a loja como parâmetro (sem interpolar o valor)
    const sql = (team.getSql as (alias: string) => string)('"user_id"');
    expect(sql).toBe(
      `"user_id" IN (SELECT "team"."id" FROM "users" "team" WHERE "team"."store_id" = :resetLinksStoreId AND "team"."role" <> 'CLIENT')`,
    );
    expect(team.objectLiteralParameters).toEqual({ resetLinksStoreId: 42 });
    expect((where.used_at as FindOperator<unknown>).type).toBe('isNull');
    expect((where.expires_at as FindOperator<unknown>).type).toBe('moreThan');
    expect(set).toEqual({ expires_at: NOW });
  });
});
