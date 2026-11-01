import { createHash, randomBytes } from 'node:crypto';
import { expect } from '@playwright/test';
import { sql } from '../billing/helpers';

/**
 * Apoio dos testes de conta (verificação e troca de e-mail, "Não fui eu"). Os links saem por e-mail (driver
 * de log nos testes) e o banco guarda só o SHA-256 do código: o teste "planta" um código conhecido na linha
 * em aberto mais recente (só no banco *_e2e desta execução; ver sql()).
 */
export type AccountTokenPurpose = 'VERIFY' | 'CHANGE' | 'REVERT';

export interface AccountTokenRow {
  id: number;
  purpose: AccountTokenPurpose;
  email: string;
  previous_email: string | null;
  used_at: string | null;
  revoked_at: string | null;
}

function newCode(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: createHash('sha256').update(token, 'utf8').digest('hex') };
}

/**
 * Troca o hash do link em aberto mais recente da conta (do propósito pedido e, se informado, do endereço)
 * pelo SHA-256 de um código gerado aqui e devolve o código. Espera o link aparecer (alguns nascem em
 * segundo plano, como a verificação do cadastro).
 */
export async function plantAccountToken(userId: number, purpose: AccountTokenPurpose, email?: string): Promise<string> {
  const { token, hash } = newCode();
  await expect
    .poll(
      async () => {
        const params: unknown[] = [hash, userId, purpose];
        if (email) params.push(email.toLowerCase());
        const rows = await sql<{ id: number }>(
          `UPDATE "account_email_tokens" SET "token_hash" = $1 WHERE "id" = (
             SELECT "id" FROM "account_email_tokens"
             WHERE "user_id" = $2 AND "purpose" = $3 AND "used_at" IS NULL AND "revoked_at" IS NULL AND "expires_at" > now()
             ${email ? 'AND "email" = $4' : ''}
             ORDER BY "id" DESC LIMIT 1
           ) RETURNING "id"`,
          params,
        );
        return rows.length;
      },
      { message: `link ${purpose} em aberto da conta #${userId}`, timeout: 10_000 },
    )
    .toBe(1);
  return token;
}

/** Links da conta (mais recentes primeiro). */
export function accountTokens(userId: number): Promise<AccountTokenRow[]> {
  return sql<AccountTokenRow>(
    `SELECT "id", "purpose", "email", "previous_email", "used_at", "revoked_at" FROM "account_email_tokens" WHERE "user_id" = $1 ORDER BY "id" DESC`,
    [userId],
  );
}

/** Links em aberto da conta, por propósito. */
export async function openAccountTokens(userId: number, purpose: AccountTokenPurpose): Promise<AccountTokenRow[]> {
  return (await accountTokens(userId)).filter((row) => row.purpose === purpose && !row.used_at && !row.revoked_at);
}

/** users.email_verified_at da conta (null = não confirmado). */
export async function emailVerifiedAt(userId: number): Promise<string | null> {
  const [row] = await sql<{ email_verified_at: string | null }>(`SELECT "email_verified_at" FROM "users" WHERE "id" = $1`, [userId]);
  return row?.email_verified_at ?? null;
}

/**
 * Link de "Esqueci minha senha" pedido pela própria pessoa (created_by nulo): espera a linha nascer (o envio
 * é em segundo plano) e troca o hash da mais recente por um código conhecido.
 */
export async function plantForgotPasswordToken(userId: number): Promise<string> {
  const { token, hash } = newCode();
  await expect
    .poll(
      async () =>
        (
          await sql<{ id: number }>(
            `UPDATE "password_reset_tokens" SET "token_hash" = $1 WHERE "id" = (
               SELECT "id" FROM "password_reset_tokens"
               WHERE "user_id" = $2 AND "created_by_user_id" IS NULL AND "used_at" IS NULL AND "expires_at" > now()
               ORDER BY "id" DESC LIMIT 1
             ) RETURNING "id"`,
            [hash, userId],
          )
        ).length,
      { message: `link de redefinição da conta #${userId}`, timeout: 10_000 },
    )
    .toBe(1);
  return token;
}

/** Links de "Esqueci minha senha" pedidos pela pessoa nas últimas 24 h. */
export async function forgotPasswordLinksSent(userId: number): Promise<number> {
  const [row] = await sql<{ total: number }>(
    `SELECT COUNT(*)::int AS "total" FROM "password_reset_tokens" WHERE "user_id" = $1 AND "created_by_user_id" IS NULL AND "created_at" > now() - interval '24 hours'`,
    [userId],
  );
  return Number(row?.total ?? 0);
}
