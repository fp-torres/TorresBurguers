import { User } from './entities/user.entity';

/** Usuário como sai nas respostas da API: nunca com password_hash. */
export type PublicUser = Omit<User, 'password_hash' | 'toJSON'>;

export function toPublicUser(user: User): PublicUser {
  const data: Partial<User> = { ...user };
  delete data.password_hash;
  return data as PublicUser;
}
