import { FindOperator, Repository } from 'typeorm';
import { sha256Hex } from '../common/crypto/secret-box';
import {
  ACCOUNT_EMAIL_TOKEN_TTL_HOURS,
  AccountEmailTokensService,
} from './account-email-tokens.service';
import {
  AccountEmailToken,
  AccountEmailTokenPurpose,
} from './entities/account-email-token.entity';

type Where = Record<string, unknown>;

/** where do TypeORM em memória (os operadores usados pelo serviço). */
function check(value: unknown, condition: unknown): boolean {
  if (condition instanceof FindOperator) {
    const op = condition as FindOperator<unknown>;
    switch (op.type) {
      case 'isNull':
        return value === null || value === undefined;
      case 'in':
        return (op.value as unknown[]).includes(value);
      case 'not':
        return value !== op.value;
      case 'moreThan':
        return (
          value instanceof Date &&
          value.getTime() > (op.value as Date).getTime()
        );
      default:
        throw new Error(`Operador não suportado no teste: ${op.type}`);
    }
  }
  return value === condition;
}
const matches = (row: object, where: Where) =>
  Object.entries(where).every(([key, condition]) =>
    check((row as Where)[key], condition),
  );

function setup() {
  const rows: AccountEmailToken[] = [];
  // Limpeza oportunista: DELETE encadeado (delete().from().where().andWhere().execute())
  const deleteQuery: Record<
    'delete' | 'from' | 'where' | 'andWhere' | 'execute',
    jest.Mock
  > = {
    delete: jest.fn(),
    from: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    execute: jest.fn().mockResolvedValue({ affected: 0 }),
  };
  for (const step of ['delete', 'from', 'where', 'andWhere'] as const) {
    deleteQuery[step].mockReturnValue(deleteQuery);
  }
  const repo = {
    create: jest.fn((data: Partial<AccountEmailToken>) =>
      Object.assign(new AccountEmailToken(), data),
    ),
    save: jest.fn((row: AccountEmailToken) => {
      Object.assign(row, { id: rows.length + 1, created_at: new Date() });
      rows.push(row);
      return Promise.resolve(row);
    }),
    update: jest.fn((where: Where, partial: Where) => {
      const hit = rows.filter((row) => matches(row, where));
      hit.forEach((row) => Object.assign(row, partial));
      return Promise.resolve({ affected: hit.length });
    }),
    findOne: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(rows.find((row) => matches(row, where)) ?? null),
    ),
    exists: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(rows.some((row) => matches(row, where))),
    ),
    createQueryBuilder: jest.fn(() => deleteQuery),
    query: jest.fn().mockResolvedValue([]),
    manager: { getRepository: jest.fn() },
  };
  repo.manager.getRepository.mockReturnValue(repo);
  const service = new AccountEmailTokensService(
    repo as unknown as Repository<AccountEmailToken>,
  );
  return { service, rows, repo, deleteQuery };
}

const { VERIFY, CHANGE, REVERT } = AccountEmailTokenPurpose;

describe('AccountEmailTokensService', () => {
  it('emite o código (base64url, 43 caracteres) e grava só o SHA-256, com o prazo do propósito', async () => {
    const { service, rows } = setup();
    const now = new Date('2026-10-31T12:00:00Z');
    const { token, record } = await service.issue({
      userId: 7,
      purpose: CHANGE,
      email: ' Novo@Email.com ',
      previousEmail: 'Antigo@Email.com',
      ip: '10.0.0.1',
      now,
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(record.token_hash).toBe(sha256Hex(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(record).toMatchObject({
      user_id: 7,
      purpose: CHANGE,
      email: 'novo@email.com',
      previous_email: 'antigo@email.com',
      requested_ip: '10.0.0.1',
      used_at: null,
      revoked_at: null,
    });
    expect(record.expires_at.getTime() - now.getTime()).toBe(
      ACCOUNT_EMAIL_TOKEN_TTL_HOURS[CHANGE] * 3_600_000,
    );
    expect(ACCOUNT_EMAIL_TOKEN_TTL_HOURS).toEqual({
      VERIFY: 48,
      CHANGE: 24,
      REVERT: 7 * 24,
    });
  });

  it('VERIFY e CHANGE: o link novo cancela o anterior do mesmo propósito; REVERT acumula (cadeia A→B→C)', async () => {
    const { service, rows } = setup();
    await service.issue({ userId: 7, purpose: VERIFY, email: 'a@x.com' });
    await service.issue({ userId: 7, purpose: VERIFY, email: 'a@x.com' });
    expect(
      rows.filter((r) => r.purpose === VERIFY && !r.revoked_at),
    ).toHaveLength(1);
    expect(rows[0].revoked_at).toBeInstanceOf(Date);
    expect(rows[0].previous_email).toBeNull();

    await service.issue({
      userId: 7,
      purpose: REVERT,
      email: 'a@x.com',
      previousEmail: 'b@x.com',
    });
    await service.issue({
      userId: 7,
      purpose: REVERT,
      email: 'b@x.com',
      previousEmail: 'c@x.com',
    });
    expect(
      rows.filter((r) => r.purpose === REVERT && !r.revoked_at),
    ).toHaveLength(2);
    // Conta de outra pessoa não é afetada
    await service.issue({ userId: 8, purpose: VERIFY, email: 'z@x.com' });
    expect(
      rows.filter(
        (r) => r.user_id === 7 && r.purpose === VERIFY && !r.revoked_at,
      ),
    ).toHaveLength(1);
  });

  it('cada emissão apaga as linhas mortas da conta há mais de 1 dia (limpeza oportunista)', async () => {
    const { service, deleteQuery } = setup();
    const now = new Date('2026-10-31T12:00:00Z');
    await service.issue({ userId: 7, purpose: VERIFY, email: 'a@x.com', now });
    expect(deleteQuery.where).toHaveBeenCalledWith('"user_id" = :userId', {
      userId: 7,
    });
    expect(deleteQuery.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('"expires_at" < :cutoff'),
      { cutoff: new Date('2026-10-30T12:00:00Z') },
    );
    expect(deleteQuery.execute).toHaveBeenCalled();
  });

  it('limpeza global em lote das linhas mortas de todas as contas: no máximo uma por hora por instância, sem atrasar a emissão', async () => {
    const { service, repo } = setup();
    const now = new Date('2026-10-31T12:00:00Z');
    await service.issue({ userId: 7, purpose: VERIFY, email: 'a@x.com', now });
    expect(repo.query).toHaveBeenCalledTimes(1);
    const [sql, params] = repo.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('DELETE FROM "account_email_tokens"');
    expect(sql).toContain('LIMIT');
    expect(params).toEqual([new Date('2026-10-30T12:00:00Z'), 1000]);

    // Dentro da mesma hora: só a limpeza da própria conta
    await service.issue({
      userId: 8,
      purpose: VERIFY,
      email: 'b@x.com',
      now: new Date('2026-10-31T12:59:00Z'),
    });
    expect(repo.query).toHaveBeenCalledTimes(1);
    await service.issue({
      userId: 8,
      purpose: VERIFY,
      email: 'b@x.com',
      now: new Date('2026-10-31T13:01:00Z'),
    });
    expect(repo.query).toHaveBeenCalledTimes(2);

    // Falha na limpeza global não derruba a emissão
    repo.query.mockRejectedValueOnce(new Error('banco ocupado'));
    await expect(
      service.issue({
        userId: 9,
        purpose: VERIFY,
        email: 'c@x.com',
        now: new Date('2026-10-31T15:00:00Z'),
      }),
    ).resolves.toHaveProperty('token', expect.any(String) as unknown);
  });

  it('findUsable: formato inválido nem consulta o banco; vencido, usado, cancelado ou de outro propósito → null', async () => {
    const { service, repo, rows } = setup();
    await expect(service.findUsable('curto', VERIFY)).resolves.toBeNull();
    await expect(
      service.findUsable('x'.repeat(300), VERIFY),
    ).resolves.toBeNull();
    expect(repo.findOne).not.toHaveBeenCalled();

    const { token } = await service.issue({
      userId: 7,
      purpose: VERIFY,
      email: 'a@x.com',
    });
    await expect(service.findUsable(token, VERIFY)).resolves.toMatchObject({
      user_id: 7,
    });
    await expect(service.findUsable(token, CHANGE)).resolves.toBeNull();
    expect(repo.findOne).toHaveBeenLastCalledWith({
      where: { token_hash: sha256Hex(token), purpose: CHANGE },
    });

    rows[0].expires_at = new Date(Date.now() - 1);
    await expect(service.findUsable(token, VERIFY)).resolves.toBeNull();
    rows[0].expires_at = new Date(Date.now() + 60_000);
    rows[0].used_at = new Date();
    await expect(service.findUsable(token, VERIFY)).resolves.toBeNull();
    rows[0].used_at = null;
    rows[0].revoked_at = new Date();
    await expect(service.findUsable(token, VERIFY)).resolves.toBeNull();
  });

  it('findUsable com lock trava a linha (FOR UPDATE) na transação de quem usa o link', async () => {
    const { service, repo } = setup();
    const { token } = await service.issue({
      userId: 7,
      purpose: CHANGE,
      email: 'n@x.com',
      previousEmail: 'a@x.com',
    });
    const manager = { getRepository: jest.fn(() => repo) };
    await service.findUsable(token, CHANGE, {
      manager: manager as never,
      lock: true,
    });
    expect(repo.findOne).toHaveBeenLastCalledWith({
      where: { token_hash: sha256Hex(token), purpose: CHANGE },
      lock: { mode: 'pessimistic_write' },
    });
    expect(manager.getRepository).toHaveBeenCalledWith(AccountEmailToken);
  });

  it('markUsed só marca um link ainda em aberto (uso único sob concorrência)', async () => {
    const { service, rows } = setup();
    await service.issue({ userId: 7, purpose: VERIFY, email: 'a@x.com' });
    await expect(service.markUsed(rows[0].id)).resolves.toBe(true);
    await expect(service.markUsed(rows[0].id)).resolves.toBe(false);
  });

  it('isReserved: REVERT em aberto e no prazo de OUTRA conta; ignora a própria conta e as linhas vencidas', async () => {
    const { service, rows } = setup();
    await service.issue({
      userId: 7,
      purpose: REVERT,
      email: 'Antigo@x.com',
      previousEmail: 'novo@x.com',
    });
    await expect(service.isReserved(' antigo@X.com ')).resolves.toBe(true);
    await expect(service.isReserved('antigo@x.com', 8)).resolves.toBe(true);
    await expect(service.isReserved('antigo@x.com', 7)).resolves.toBe(false);
    rows[0].expires_at = new Date(Date.now() - 1);
    await expect(service.isReserved('antigo@x.com')).resolves.toBe(false);
    rows[0].expires_at = new Date(Date.now() + 60_000);
    rows[0].used_at = new Date();
    await expect(service.isReserved('antigo@x.com')).resolves.toBe(false);
    // Verificação e troca não reservam o endereço
    await service.issue({ userId: 9, purpose: VERIFY, email: 'outro@x.com' });
    await expect(service.isReserved('outro@x.com')).resolves.toBe(false);
  });

  it('revokeOpen e findOpenChange: só os links em aberto dos propósitos pedidos', async () => {
    const { service } = setup();
    await service.issue({
      userId: 7,
      purpose: CHANGE,
      email: 'n@x.com',
      previousEmail: 'a@x.com',
    });
    await service.issue({ userId: 7, purpose: VERIFY, email: 'a@x.com' });
    await expect(service.findOpenChange(7)).resolves.toMatchObject({
      email: 'n@x.com',
    });
    await expect(service.revokeOpen(7, [CHANGE])).resolves.toBe(1);
    await expect(service.findOpenChange(7)).resolves.toBeNull();
    await expect(service.revokeOpen(7, [CHANGE])).resolves.toBe(0);
    await expect(service.revokeOpen(7, [])).resolves.toBe(0);
    await expect(service.revokeOpen(7, [VERIFY, REVERT])).resolves.toBe(1);
  });
});
