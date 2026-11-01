import { NotFoundException, ValidationPipe } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth-user';
import type { TenantService } from '../tenancy/tenant.service';
import { UserRole } from '../users/entities/user.entity';
import { UpdateStoreStatusDto } from './dto/update-store-status.dto';
import type { Store } from './entities/store.entity';
import { StoreService } from './store.service';

const ADMIN: AuthUser = {
  id: 1,
  email: 'admin@loja7.com',
  role: UserRole.ADMIN,
  name: 'Admin',
  storeId: 7,
  platformRole: null,
};

type Row = Pick<
  Store,
  'id' | 'is_open' | 'opening_message' | 'closing_message'
> & { mp_access_token_encrypted?: string | null };

/** Banco falso com duas lojas: toda consulta precisa filtrar pelo id da loja. */
function setup() {
  const rows: Row[] = [
    { id: 7, is_open: true, opening_message: null, closing_message: null },
    {
      id: 8,
      is_open: false,
      opening_message: 'Loja 8',
      closing_message: 'Fechada',
      mp_access_token_encrypted: 'v1:cifrado',
    },
  ];
  const byId = (id: unknown) => rows.find((row) => row.id === id) ?? null;
  const stores = {
    findOne: jest.fn(({ where }: { where: { id: number } }) =>
      Promise.resolve(byId(where.id) ? { ...byId(where.id) } : null),
    ),
    update: jest.fn((criteria: { id: number }, changes: Partial<Row>) => {
      const row = byId(criteria.id);
      if (row) Object.assign(row, changes);
      return Promise.resolve({ affected: row ? 1 : 0 });
    }),
    exists: jest.fn(
      ({
        where,
      }: {
        where: { id: number; mp_access_token_encrypted: unknown };
      }) => Promise.resolve(!!byId(where.id)?.mp_access_token_encrypted),
    ),
  };
  const tenants = {
    defaultStore: jest.fn().mockResolvedValue({ id: 7, slug: 'loja-7' }),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new StoreService(
    stores as unknown as Repository<Store>,
    tenants as unknown as TenantService,
    audit as unknown as AuditService,
  );
  return { service, stores, tenants, audit, rows };
}

describe('StoreService (status por loja)', () => {
  it('GET devolve exatamente { id, is_open, opening_message, closing_message } da loja pedida', async () => {
    const { service, stores } = setup();
    const status = await service.getStatus(8);
    expect(status).toEqual({
      id: 8,
      is_open: false,
      opening_message: 'Loja 8',
      closing_message: 'Fechada',
    });
    expect(Object.keys(status).sort()).toEqual([
      'closing_message',
      'id',
      'is_open',
      'opening_message',
    ]);
    expect(stores.findOne.mock.calls[0][0]).toMatchObject({
      where: { id: 8 },
    });
  });

  it('loja inexistente → 404 (sem criar nada: o auto-create da loja única acabou)', async () => {
    const { service } = setup();
    await expect(service.getStatus(99)).rejects.toThrow(NotFoundException);
  });

  it('PATCH altera só a loja do contexto e só o que mudou, com auditoria sem as mensagens', async () => {
    const { service, stores, audit, rows } = setup();
    const result = await service.updateStatus(
      7,
      { is_open: false, closing_message: 'Voltamos às 18h.' },
      { user: ADMIN },
    );
    expect(result).toEqual({
      id: 7,
      is_open: false,
      opening_message: null,
      closing_message: 'Voltamos às 18h.',
    });
    expect(stores.update).toHaveBeenCalledWith(
      { id: 7 },
      { is_open: false, closing_message: 'Voltamos às 18h.' },
    );
    // A outra loja continua intacta
    expect(rows[1]).toMatchObject({
      is_open: false,
      closing_message: 'Fechada',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'store.status.update',
        storeId: 7,
        targetId: 7,
        actor: ADMIN,
        metadata: { fields: ['is_open', 'closing_message'], is_open: false },
      }),
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(
      'Voltamos às 18h.',
    );
  });

  it('corpo vazio ou valores iguais: nada é gravado nem auditado', async () => {
    const { service, stores, audit } = setup();
    await expect(service.updateStatus(7, {}, { user: ADMIN })).resolves.toEqual(
      {
        id: 7,
        is_open: true,
        opening_message: null,
        closing_message: null,
      },
    );
    await service.updateStatus(
      7,
      { is_open: true, opening_message: null },
      { user: ADMIN },
    );
    expect(stores.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('PATCH em loja que sumiu → 404 (critério { id } sem linha afetada)', async () => {
    const { service, stores } = setup();
    stores.findOne.mockResolvedValueOnce({
      id: 7,
      is_open: true,
      opening_message: null,
      closing_message: null,
    });
    stores.update.mockResolvedValueOnce({ affected: 0 });
    await expect(
      service.updateStatus(7, { is_open: false }, { user: ADMIN }),
    ).rejects.toThrow(NotFoundException);
  });

  it('isOpen por loja; loja inexistente conta como fechada', async () => {
    const { service } = setup();
    await expect(service.isOpen(7)).resolves.toBe(true);
    await expect(service.isOpen(8)).resolves.toBe(false);
    await expect(service.isOpen(99)).resolves.toBe(false);
  });

  it('loja padrão e credencial própria são conferidas pelo id da loja', async () => {
    const { service, stores } = setup();
    await expect(service.isDefaultStore(7)).resolves.toBe(true);
    await expect(service.isDefaultStore(8)).resolves.toBe(false);
    await expect(service.hasOwnPaymentCredentials(8)).resolves.toBe(true);
    await expect(service.hasOwnPaymentCredentials(7)).resolves.toBe(false);
    expect(stores.exists.mock.calls[0][0].where.id).toBe(8);
  });
});

describe('UpdateStoreStatusDto', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const validate = (body: object) =>
    pipe.transform(body, { type: 'body', metatype: UpdateStoreStatusDto });

  it('booleano obrigatório quando enviado, mensagens até 200 caracteres, vazio limpa', async () => {
    await expect(
      validate({ is_open: 'true', opening_message: '  ' }),
    ).resolves.toEqual({ is_open: true, opening_message: null });
    await expect(validate({ is_open: null })).rejects.toMatchObject({
      response: { message: ['is_open deve ser verdadeiro ou falso.'] },
    });
    await expect(
      validate({ closing_message: 'x'.repeat(201) }),
    ).rejects.toMatchObject({
      response: {
        message: [
          'A mensagem de loja fechada pode ter no máximo 200 caracteres.',
        ],
      },
    });
  });

  it('a loja nunca vem do corpo: store_id/slug são recusados', async () => {
    await expect(
      validate({ is_open: true, store_id: 8 }),
    ).rejects.toMatchObject({
      response: { message: ['property store_id should not exist'] },
    });
    await expect(validate({ slug: 'outra-loja' })).rejects.toMatchObject({
      status: 400,
    });
  });
});
