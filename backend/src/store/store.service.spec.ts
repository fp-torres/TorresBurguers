import { Logger, ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Repository } from 'typeorm';
import { RolesGuard } from '../auth/roles.guard';
import { UpdateStoreDto } from './dto/update-store.dto';
import { StoreConfig } from './entities/store-config.entity';
import { StoreController } from './store.controller';
import { StoreService } from './store.service';

describe('StoreService', () => {
  const rows: StoreConfig[] = [];
  const repo = {
    find: jest.fn(() => Promise.resolve(rows.slice(0, 1))),
    create: jest.fn(
      (data: Partial<StoreConfig>) => ({ ...data }) as StoreConfig,
    ),
    save: jest.fn((config: StoreConfig) => {
      if (!config.id) {
        config.id = rows.length + 1;
        rows.push(config);
      }
      return Promise.resolve(config);
    }),
    merge: jest.fn((target: StoreConfig, changes: Partial<StoreConfig>) =>
      Object.assign(target, changes),
    ),
  };
  const service = new StoreService(repo as unknown as Repository<StoreConfig>);

  beforeEach(() =>
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
  );
  afterEach(() => jest.restoreAllMocks());

  it('GET sempre devolve uma configuração: cria a padrão (aberta) se não existir', async () => {
    await expect(service.getStatus()).resolves.toEqual({
      id: 1,
      is_open: true,
      opening_message: null,
      closing_message: null,
    });
    await service.getStatus();
    expect(rows).toHaveLength(1);
    await expect(service.isOpen()).resolves.toBe(true);
  });

  it('PATCH altera só o que foi enviado', async () => {
    await service.updateStatus({ closing_message: 'Voltamos às 18h.' });
    await service.updateStatus({ is_open: false });
    expect(rows[0]).toMatchObject({
      is_open: false,
      closing_message: 'Voltamos às 18h.',
    });
    await expect(service.isOpen()).resolves.toBe(false);
  });

  it('PATCH /store/status liberado para ADMIN e EMPLOYEE', () => {
    const handler = (
      StoreController.prototype as unknown as Record<string, object>
    ).updateStatus;
    expect(Reflect.getMetadata('roles', handler)).toEqual([
      'ADMIN',
      'EMPLOYEE',
    ]);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(RolesGuard);
  });

  it('UpdateStoreDto: booleano obrigatório quando enviado, mensagens até 200 caracteres', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const validate = (body: object) =>
      pipe.transform(body, { type: 'body', metatype: UpdateStoreDto });

    await expect(
      validate({ is_open: 'true', opening_message: '' }),
    ).resolves.toEqual({
      is_open: true,
      opening_message: null,
    });
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
});
