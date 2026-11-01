import { type EntityManager, IsNull, MoreThan, Raw } from 'typeorm';
import { PasswordResetToken } from './entities/password-reset-token.entity';

/**
 * Vence AGORA os links de redefinição pendentes de toda a equipe de uma loja (inclusive a lixeira),
 * numa escrita só: o mesmo que expirePendingResetLinks para cada membro. Usado ao desativar a loja,
 * junto com o token_version + 1 da equipe (um link pendente devolveria o acesso numa reativação).
 */
export async function expirePendingResetLinksOfStoreTeam(
  manager: EntityManager,
  storeId: number,
  now: Date = new Date(),
): Promise<void> {
  await manager.getRepository(PasswordResetToken).update(
    {
      used_at: IsNull(),
      expires_at: MoreThan(now),
      user_id: Raw(
        (column) =>
          `${column} IN (SELECT "team"."id" FROM "users" "team" WHERE "team"."store_id" = :resetLinksStoreId AND "team"."role" <> 'CLIENT')`,
        { resetLinksStoreId: storeId },
      ),
    },
    { expires_at: now },
  );
}

/**
 * Vence AGORA os links de redefinição de senha pendentes da conta (não usados e no prazo).
 * Vale para todo evento que muda quem controla a conta: link novo, senha redefinida, troca de e-mail
 * ou de senha (pela própria pessoa ou pelo ADMIN), bloqueio, lixeira e "encerrar todas as sessões".
 * Sem isso, um link enviado à caixa ANTIGA continuaria redefinindo a senha depois da troca.
 */
export async function expirePendingResetLinks(
  manager: EntityManager,
  userId: number,
  now: Date = new Date(),
): Promise<void> {
  await manager
    .getRepository(PasswordResetToken)
    .update(
      { user_id: userId, used_at: IsNull(), expires_at: MoreThan(now) },
      { expires_at: now },
    );
}
