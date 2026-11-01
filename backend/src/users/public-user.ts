import { User } from './entities/user.entity';

/**
 * Campos internos da conta que nunca saem nas respostas: hash da senha, versão das sessões,
 * bloqueio, último acesso e papel na plataforma. As respostas de conta usam session-user.ts
 * (lista de campos permitidos); este corte vale para quem ainda serializa a entidade.
 */
export const INTERNAL_USER_FIELDS = [
  'password_hash',
  'token_version',
  'blocked_at',
  'blocked_reason',
  'last_login_at',
  'platform_role',
] as const;

/** Usuário como sai nas respostas da API: sem os campos internos. */
export type PublicUser = Omit<
  User,
  (typeof INTERNAL_USER_FIELDS)[number] | 'toJSON'
>;

export function toPublicUser(user: User): PublicUser {
  const data: Partial<User> = { ...user };
  for (const field of INTERNAL_USER_FIELDS) delete data[field];
  return data as PublicUser;
}
