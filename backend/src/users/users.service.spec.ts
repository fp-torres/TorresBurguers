import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { User, UserRole } from './entities/user.entity';
import { LAST_ADMIN_MESSAGE } from './users.policy';
import { UsersService } from './users.service';

function makeUser(
  id: number,
  role: UserRole,
  deleted_at: Date | null = null,
): User {
  return Object.assign(new User(), {
    id,
    role,
    deleted_at,
    name: `Usuário ${id}`,
    email: `u${id}@email.com`,
  });
}

/**
 * Repositório falso: as leituras usam a lista em memória e as escritas são espiãs.
 * A trava dos ADMINs (SELECT ... FOR UPDATE dentro da transação) devolve os ADMINs ativos.
 */
function setup(accounts: User[]) {
  const activeAdmins = () =>
    accounts
      .filter((u) => u.role === UserRole.ADMIN && !u.deleted_at)
      .map((u) => ({ id: u.id }));

  const lockQuery = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getMany: jest.fn(() => Promise.resolve(activeAdmins())),
  };
  const writes = () => ({
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    softDelete: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  });
  const tx = { ...writes(), createQueryBuilder: jest.fn(() => lockQuery) };
  const repo = {
    ...writes(),
    findOneBy: jest.fn(({ id }: { id: number }) =>
      Promise.resolve(
        accounts.find((u) => u.id === id && !u.deleted_at) ?? null,
      ),
    ),
    findOne: jest.fn(({ where }: { where: { id: number } }) =>
      Promise.resolve(accounts.find((u) => u.id === where.id) ?? null),
    ),
    exists: jest.fn().mockResolvedValue(false),
    manager: {
      transaction: jest.fn(
        (work: (manager: { getRepository: () => typeof tx }) => unknown) =>
          work({ getRepository: () => tx }),
      ),
    },
  };

  return {
    service: new UsersService(repo as unknown as Repository<User>),
    repo,
    tx,
    lockQuery,
  };
}

const lastAdminError = new BadRequestException(LAST_ADMIN_MESSAGE);

describe('UsersService: sempre resta um ADMIN ativo', () => {
  it('rebaixar o único ADMIN ativo → 400 e nada é gravado', async () => {
    const { service, repo, tx, lockQuery } = setup([
      makeUser(1, UserRole.ADMIN),
      makeUser(2, UserRole.ADMIN, new Date()), // na lixeira: não conta
      makeUser(10, UserRole.CLIENT),
    ]);

    await expect(service.update(1, { role: UserRole.CLIENT })).rejects.toThrow(
      lastAdminError,
    );
    expect(lockQuery.setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(tx.update).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('rebaixar um ADMIN quando existe outro → grava dentro da transação', async () => {
    const { service, tx } = setup([
      makeUser(1, UserRole.ADMIN),
      makeUser(2, UserRole.ADMIN),
    ]);

    await service.update(2, { role: UserRole.EMPLOYEE });
    expect(tx.update).toHaveBeenCalledWith(2, { role: UserRole.EMPLOYEE });
  });

  it('lixeira e exclusão definitiva do único ADMIN ativo → 400', async () => {
    const { service, repo, tx } = setup([
      makeUser(1, UserRole.ADMIN),
      makeUser(10, UserRole.CLIENT),
    ]);

    await expect(service.remove(1)).rejects.toThrow(lastAdminError);
    await expect(service.hardDelete(1)).rejects.toThrow(lastAdminError);
    expect(tx.softDelete).not.toHaveBeenCalled();
    expect(tx.delete).not.toHaveBeenCalled();
    expect(repo.softDelete).not.toHaveBeenCalled();
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('com outro ADMIN ativo, lixeira e exclusão definitiva seguem normalmente', async () => {
    const { service, tx } = setup([
      makeUser(1, UserRole.ADMIN),
      makeUser(2, UserRole.ADMIN),
    ]);

    await expect(service.remove(2)).resolves.toEqual({
      message: 'Usuário removido.',
    });
    expect(tx.softDelete).toHaveBeenCalledWith(2);

    await service.hardDelete(2);
    expect(tx.delete).toHaveBeenCalledWith(2);
  });

  it('contas que não são ADMIN ativo não abrem transação', async () => {
    const { service, repo } = setup([
      makeUser(1, UserRole.ADMIN),
      makeUser(5, UserRole.ADMIN, new Date()),
      makeUser(10, UserRole.CLIENT),
    ]);

    await service.remove(10);
    await service.hardDelete(5); // ADMIN que já estava na lixeira
    await service.update(10, { name: 'Novo Nome' });

    expect(repo.softDelete).toHaveBeenCalledWith(10);
    expect(repo.delete).toHaveBeenCalledWith(5);
    expect(repo.update).toHaveBeenCalledWith(10, { name: 'Novo Nome' });
    expect(repo.manager.transaction).not.toHaveBeenCalled();
  });

  it('PATCH com phone null grava null (remove o telefone)', async () => {
    const { service, repo } = setup([makeUser(10, UserRole.CLIENT)]);

    await service.update(10, { phone: null });
    expect(repo.update).toHaveBeenCalledWith(10, { phone: null });
  });
});
