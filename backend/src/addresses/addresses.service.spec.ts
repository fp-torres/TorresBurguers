import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  Logger,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { IsNull, Repository } from 'typeorm';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import type { AddressLocationFields } from './address-location';
import type { AddressLocationService } from './address-location.service';
import {
  ADDRESSES_LIMIT_MESSAGE,
  ADDRESSES_LIST_LIMIT,
  AddressesService,
  MAX_ADDRESSES_PER_USER,
} from './addresses.service';
import { CepLookupService } from './cep-lookup.service';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';
import { Address } from './entities/address.entity';

const CHECKED_AT = new Date('2026-10-31T12:00:00Z');
/** Conferência do CEP com bairro (FOUND) e sem resposta do serviço (UNAVAILABLE). */
const FOUND: AddressLocationFields = {
  canonical_neighborhood: 'Copacabana',
  canonical_city: 'Rio de Janeiro',
  canonical_state: 'RJ',
  neighborhood_source: 'CEP',
  cep_status: 'FOUND',
  cep_checked_at: CHECKED_AT,
};
const UNAVAILABLE: AddressLocationFields = {
  canonical_neighborhood: null,
  canonical_city: null,
  canonical_state: null,
  neighborhood_source: 'MANUAL',
  cep_status: 'UNAVAILABLE',
  cep_checked_at: CHECKED_AT,
};

const json = (status: number, body: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    body: { cancel: () => Promise.resolve() },
  }) as unknown as Response;

describe('AddressesService', () => {
  const repo = {
    findOne: jest.fn(),
    update: jest.fn(),
  };
  const originalEnv = { ...process.env };
  let service: AddressesService;
  let fetchMock: jest.SpyInstance;
  const locations = { resolve: jest.fn() };

  beforeEach(() => {
    process.env = { ...originalEnv, RATE_LIMIT_ENABLED: 'true' };
    delete process.env.RATE_LIMIT_CEP_LOOKUP;
    delete process.env.CEP_LOOKUP_FAKE;
    locations.resolve.mockReset().mockResolvedValue(FOUND);
    // Limite de tentativas e cache de CEP novos a cada teste (em memória)
    service = new AddressesService(
      repo as unknown as Repository<Address>,
      new RateLimitService(),
      new CepLookupService(),
      locations as unknown as AddressLocationService,
    );
    fetchMock = jest.spyOn(global, 'fetch');
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => {
    process.env = originalEnv;
  });

  describe('findCep', () => {
    it('CEP com formato inválido → 400, sem consultar os serviços', async () => {
      await expect(service.findCep('123')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('muitas consultas do mesmo IP → 429 sem chamar os serviços de CEP (outro IP segue)', async () => {
      process.env.RATE_LIMIT_CEP_LOOKUP = '2/60';
      fetchMock.mockResolvedValue(
        json(200, { cep: '20040-002', logradouro: 'Rua A', uf: 'RJ' }),
      );
      await service.findCep('20040002', '10.0.0.1');
      await service.findCep('20040002', '10.0.0.1');
      fetchMock.mockClear();

      const limited = await service
        .findCep('20040002', '10.0.0.1')
        .catch((error: unknown) => error);
      expect((limited as HttpException).getStatus()).toBe(429);
      expect(fetchMock).not.toHaveBeenCalled();

      await expect(
        service.findCep('20040002', '10.0.0.2'),
      ).resolves.toMatchObject({ cep: '20040-002' });
    });

    it('a política padrão CEP_LOOKUP é 60 consultas por minuto por IP', async () => {
      fetchMock.mockResolvedValue(json(200, { cep: '20040-002' }));
      for (let i = 0; i < 60; i++) {
        await service.findCep('20040002', '10.0.0.3');
      }
      await expect(
        service.findCep('20040002', '10.0.0.3'),
      ).rejects.toBeInstanceOf(HttpException);
    });

    it('ViaCEP encontrou → endereço no formato do ViaCEP', async () => {
      fetchMock.mockResolvedValueOnce(
        json(200, {
          cep: '20040-002',
          logradouro: 'Rua A',
          bairro: 'Centro',
          localidade: 'Rio de Janeiro',
          uf: 'RJ',
        }),
      );
      await expect(service.findCep('20040-002')).resolves.toEqual({
        cep: '20040-002',
        logradouro: 'Rua A',
        complemento: '',
        bairro: 'Centro',
        localidade: 'Rio de Janeiro',
        uf: 'RJ',
      });
    });

    it('ViaCEP fora do ar → usa a BrasilAPI', async () => {
      fetchMock
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce(
          json(200, {
            cep: '01001000',
            street: 'Praça da Sé',
            neighborhood: 'Sé',
            city: 'São Paulo',
            state: 'SP',
          }),
        );
      await expect(service.findCep('01001000')).resolves.toMatchObject({
        cep: '01001-000',
        logradouro: 'Praça da Sé',
        uf: 'SP',
      });
    });

    it('CEP inexistente → 404', async () => {
      fetchMock
        .mockResolvedValueOnce(json(200, { erro: 'true' }))
        .mockResolvedValueOnce(json(404, { message: 'CEP não encontrado' }));
      await expect(service.findCep('99999999')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('serviços de CEP indisponíveis → 502', async () => {
      fetchMock
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce(json(500, {}));
      await expect(service.findCep('20040002')).rejects.toBeInstanceOf(
        BadGatewayException,
      );
    });
  });

  describe('escopo do usuário e exclusão', () => {
    it('busca sempre pelo dono e ignora endereços excluídos (outro usuário → 404)', async () => {
      repo.findOne.mockResolvedValueOnce(null);
      await expect(service.findOne(5, 42)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: 5, user: { id: 42 }, deleted_at: IsNull() },
      });
    });

    it('excluir marca deleted_at (pedidos antigos continuam com o endereço)', async () => {
      repo.findOne.mockResolvedValueOnce({ id: 5 });
      await expect(service.remove(5, 42)).resolves.toMatchObject({ id: 5 });
      expect(repo.update).toHaveBeenCalledWith(5, {
        deleted_at: expect.any(Date) as unknown,
      });
    });
  });

  describe('limites por conta', () => {
    const dto = {
      street: 'Rua A',
      number: '1',
      neighborhood: 'Centro',
      city: 'Rio de Janeiro',
      state: 'RJ',
      zipCode: '20000000',
    } as CreateAddressDto;

    beforeEach(() => {
      Object.assign(repo, {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn((data: object) => data),
        save: jest.fn(() => Promise.resolve({ id: 77 })),
        find: jest.fn().mockResolvedValue([]),
        merge: jest.fn(),
      });
      repo.findOne.mockResolvedValue({ id: 77 });
      delete process.env.RATE_LIMIT_ADDRESS_WRITE;
    });

    const repoMock = () =>
      repo as unknown as Record<'count' | 'save' | 'find', jest.Mock>;

    it(`até ${MAX_ADDRESSES_PER_USER} endereços ativos por conta (os excluídos não contam); acima → 400 sem gravar`, async () => {
      repoMock().count.mockResolvedValueOnce(MAX_ADDRESSES_PER_USER - 1);
      await expect(service.create(dto, 42)).resolves.toMatchObject({
        id: 77,
      });
      expect(repoMock().count).toHaveBeenCalledWith({
        where: { user: { id: 42 }, deleted_at: IsNull() },
      });

      repoMock().count.mockResolvedValueOnce(MAX_ADDRESSES_PER_USER);
      repoMock().save.mockClear();
      const failure = service.create(dto, 42);
      await expect(failure).rejects.toBeInstanceOf(BadRequestException);
      await expect(failure).rejects.toThrow(ADDRESSES_LIMIT_MESSAGE);
      expect(repoMock().save).not.toHaveBeenCalled();
    });

    it('criar e editar consomem o limite de tentativas da conta (ADDRESS_WRITE) → 429', async () => {
      process.env.RATE_LIMIT_ADDRESS_WRITE = '2/600';
      await service.create(dto, 42);
      await service.update(77, { number: '2' }, 42);
      const blocked = service.create(dto, 42);
      await expect(blocked).rejects.toBeInstanceOf(HttpException);
      await expect(blocked).rejects.toMatchObject({ status: 429 });
      await expect(
        service.update(77, { number: '3' }, 42),
      ).rejects.toMatchObject({ status: 429 });
      // Outra conta segue
      await expect(service.create(dto, 43)).resolves.toMatchObject({ id: 77 });
    });

    it(`a lista devolve no máximo ${ADDRESSES_LIST_LIMIT} endereços`, async () => {
      await service.findAll(42);
      expect(repoMock().find).toHaveBeenCalledWith({
        where: { user: { id: 42 }, deleted_at: IsNull() },
        order: { id: 'ASC' },
        take: ADDRESSES_LIST_LIMIT,
      });
    });
  });

  describe('conferência do CEP (bairro, cidade e UF canônicos)', () => {
    const dto = {
      street: 'Av. Atlântica',
      number: '1500',
      neighborhood: 'Centro', // digitado errado: o CEP é de Copacabana
      city: 'Rio de Janeiro',
      state: 'RJ',
      zipCode: '22041001',
    } as CreateAddressDto;
    let saved: Record<string, unknown>;

    beforeEach(() => {
      saved = {};
      Object.assign(repo, {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn((data: object) => ({ ...data })),
        save: jest.fn((data: Record<string, unknown>) => {
          saved = { ...data };
          return Promise.resolve({ id: 77, ...data });
        }),
        merge: jest.fn((target: object, data: object) =>
          Object.assign(target, data),
        ),
      });
      repo.findOne.mockImplementation(() =>
        Promise.resolve({ id: 77, ...saved }),
      );
    });

    it('cadastro guarda o canônico do CEP ao lado do que o cliente digitou', async () => {
      const created = await service.create(dto, 42);
      expect(locations.resolve).toHaveBeenCalledWith('22041001');
      expect(saved).toMatchObject({
        neighborhood: 'Centro',
        canonical_neighborhood: 'Copacabana',
        canonical_city: 'Rio de Janeiro',
        canonical_state: 'RJ',
        neighborhood_source: 'CEP',
        cep_status: 'FOUND',
        user: { id: 42 },
      });
      expect(created).toMatchObject({
        id: 77,
        neighborhood: 'Centro',
        canonical_neighborhood: 'Copacabana',
      });
    });

    it('serviço de CEP fora do ar nunca impede salvar: vale o digitado, marcado como manual', async () => {
      locations.resolve.mockResolvedValueOnce(UNAVAILABLE);
      await expect(service.create(dto, 42)).resolves.toMatchObject({
        id: 77,
        neighborhood: 'Centro',
        neighborhood_source: 'MANUAL',
        cep_status: 'UNAVAILABLE',
        canonical_neighborhood: null,
      });
    });

    it('limite de endereços atingido: recusa antes de consultar o CEP', async () => {
      (repo as unknown as { count: jest.Mock }).count.mockResolvedValueOnce(
        MAX_ADDRESSES_PER_USER,
      );
      await expect(service.create(dto, 42)).rejects.toThrow(
        ADDRESSES_LIMIT_MESSAGE,
      );
      expect(locations.resolve).not.toHaveBeenCalled();
    });

    it('edição: confere de novo quando o CEP muda, quando nunca foi conferido ou quando o serviço estava fora do ar', async () => {
      // CEP igual e já conferido: não consulta
      saved = { ...dto, ...FOUND };
      await service.update(77, { number: '10', zipCode: '22041001' }, 42);
      expect(locations.resolve).not.toHaveBeenCalled();
      expect(saved).toMatchObject({ number: '10', cep_status: 'FOUND' });

      // CEP novo: consulta o CEP novo
      locations.resolve.mockResolvedValueOnce(UNAVAILABLE);
      await service.update(77, { zipCode: '20040002' }, 42);
      expect(locations.resolve).toHaveBeenLastCalledWith('20040002');
      expect(saved).toMatchObject({
        zipCode: '20040002',
        cep_status: 'UNAVAILABLE',
        canonical_neighborhood: null,
      });

      // Serviço estava fora do ar: qualquer edição tenta de novo
      await service.update(77, { complement: 'Fundos' }, 42);
      expect(locations.resolve).toHaveBeenCalledTimes(2);
      expect(saved).toMatchObject({ cep_status: 'FOUND' });

      // Endereço antigo, nunca conferido
      saved = { ...dto, cep_status: null };
      await service.update(77, { number: '11' }, 42);
      expect(locations.resolve).toHaveBeenCalledTimes(3);
    });

    it('edição sem mudança (corpo vazio ou os mesmos valores): não grava nem consulta o CEP de novo', async () => {
      const checkedAt = new Date('2026-10-31T10:00:00Z');
      saved = { ...dto, ...UNAVAILABLE, cep_checked_at: checkedAt };
      const save = (repo as unknown as { save: jest.Mock }).save;
      save.mockClear();

      const same = await service.update(77, {}, 42);
      await service.update(
        77,
        { number: saved.number as string, zipCode: saved.zipCode as string },
        42,
      );
      expect(locations.resolve).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      expect(same).toMatchObject({
        cep_status: 'UNAVAILABLE',
        cep_checked_at: checkedAt,
      });
    });
  });
});

describe('DTOs de endereço', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const validate = (
    metatype: typeof CreateAddressDto | typeof UpdateAddressDto,
    body: object,
  ) => pipe.transform(body, { type: 'body', metatype });

  it('normaliza CEP, UF e textos', async () => {
    const dto: unknown = await validate(CreateAddressDto, {
      zipCode: '22041-001',
      street: ' Av. Atlântica ',
      number: 1500,
      neighborhood: 'Copacabana',
      city: 'Rio de Janeiro',
      state: 'rj',
      complement: '',
      latitude: '-22.97',
    });
    expect(dto).toMatchObject({
      zipCode: '22041001',
      street: 'Av. Atlântica',
      number: '1500',
      state: 'RJ',
      complement: null,
      latitude: -22.97,
    });
  });

  it('recusa CEP/UF inválidos e null em campo obrigatório no PATCH', async () => {
    await expect(
      validate(CreateAddressDto, {
        zipCode: '123',
        street: 'Rua',
        number: '1',
        neighborhood: 'Centro',
        city: 'Rio',
        state: 'XX',
      }),
    ).rejects.toMatchObject({
      response: {
        message: [
          'CEP inválido. Informe os 8 dígitos (ex.: 22041-001).',
          'UF inválida. Use a sigla do estado com 2 letras (ex.: RJ).',
        ],
      },
    });
    await expect(
      validate(UpdateAddressDto, { street: null }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      validate(UpdateAddressDto, { complement: null }),
    ).resolves.toEqual({
      complement: null,
    });
  });
});
