import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from '../../users/entities/user.entity';
import { emailEquals, normalizeEmail } from '../../users/email';
import { DEFAULT_USERS } from './default-users';

/**
 * Garante que os usuários padrão existam.
 * - resetPasswords=false (subida da API): só cria os que faltam, nunca altera contas existentes.
 * - resetPasswords=true (npm run seed): também restaura da lixeira e redefine nome, perfil e senha.
 * A busca ignora maiúsculas/minúsculas e inclui contas na lixeira, como no cadastro.
 */
export async function seedDefaultUsers(
  repo: Repository<User>,
  { resetPasswords }: { resetPasswords: boolean },
): Promise<string[]> {
  const report: string[] = [];

  for (const u of DEFAULT_USERS) {
    const email = normalizeEmail(u.email);
    const existing = await repo.findOne({
      where: { email: emailEquals(email) },
      withDeleted: true,
      order: { id: 'ASC' },
    });

    if (!existing) {
      const password_hash = await bcrypt.hash(u.password, 10);
      await repo.save(
        repo.create({
          name: u.name,
          email,
          phone: u.phone,
          role: u.role,
          password_hash,
        }),
      );
      report.push(`criado: ${email} (${u.role})`);
      continue;
    }

    if (resetPasswords) {
      const password_hash = await bcrypt.hash(u.password, 10);
      if (existing.deleted_at) await repo.restore(existing.id);
      await repo.update(existing.id, {
        name: u.name,
        role: u.role,
        password_hash,
      });
      report.push(`redefinido: ${email} (${u.role})`);
    }
  }

  return report;
}
