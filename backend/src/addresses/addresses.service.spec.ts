import {
  BadGatewayException,
  BadRequestException,
  Logger,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { IsNull, Repository } from 'typeorm';
import { AddressesService } from './addresses.service';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';
import { Address } from './entities/address.entity';

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
  const service = new AddressesService(repo as unknown as Repository<Address>);
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('findCep', () => {
    it('CEP com formato inválido → 400, sem consultar os serviços', async () => {
      await expect(service.findCep('123')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(fetchMock).not.toHaveBeenCalled();
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
