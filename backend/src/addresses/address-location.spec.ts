import { Logger } from '@nestjs/common';
import type { Repository } from 'typeorm';
import {
  ADDRESS_LOCATION_RETRY_MS,
  deliveryLocationOf,
  locationFromLookup,
  needsLocationRefresh,
} from './address-location';
import { AddressLocationService } from './address-location.service';
import type { CepLookupService } from './cep-lookup.service';
import type { Address } from './entities/address.entity';

const AT = new Date('2026-10-31T12:00:00Z');

const found = (bairro: string, localidade = 'Rio de Janeiro', uf = 'RJ') => ({
  status: 'found' as const,
  address: {
    cep: '22041-001',
    logradouro: 'Avenida Atlântica',
    complemento: '',
    bairro,
    localidade,
    uf,
  },
});

describe('localização da entrega pelo CEP (funções puras)', () => {
  it('CEP com bairro: bairro, cidade e UF canônicos (fonte CEP)', () => {
    expect(locationFromLookup(found('  Copacabana '), AT)).toEqual({
      canonical_neighborhood: 'Copacabana',
      canonical_city: 'Rio de Janeiro',
      canonical_state: 'RJ',
      neighborhood_source: 'CEP',
      cep_status: 'FOUND',
      cep_checked_at: AT,
    });
  });

  it('CEP geral da cidade (sem bairro): cidade e UF do CEP, bairro informado manualmente', () => {
    expect(locationFromLookup(found('', 'Cidade Única', 'mg'), AT)).toEqual({
      canonical_neighborhood: null,
      canonical_city: 'Cidade Única',
      canonical_state: 'MG',
      neighborhood_source: 'MANUAL',
      cep_status: 'NO_NEIGHBORHOOD',
      cep_checked_at: AT,
    });
  });

  it('CEP inexistente ou serviço fora do ar: nada canônico, bairro informado manualmente', () => {
    for (const [status, cepStatus] of [
      ['not_found', 'NOT_FOUND'],
      ['unavailable', 'UNAVAILABLE'],
    ] as const) {
      expect(locationFromLookup({ status }, AT)).toEqual({
        canonical_neighborhood: null,
        canonical_city: null,
        canonical_state: null,
        neighborhood_source: 'MANUAL',
        cep_status: cepStatus,
        cep_checked_at: AT,
      });
    }
  });

  it('UF desconhecida vira null; nomes longos são cortados no tamanho da coluna', () => {
    const fields = locationFromLookup(
      found(`Bairro ${'x'.repeat(150)}`, 'Cidade', 'XX'),
      AT,
    );
    expect(fields.canonical_state).toBeNull();
    expect(fields.canonical_neighborhood).toHaveLength(100);
  });

  it('zona de entrega: o canônico quando há; senão, o digitado (e o CEP para as faixas)', () => {
    const typed = {
      zipCode: '22041001',
      neighborhood: 'Centro',
      city: 'Rio',
    };
    expect(
      deliveryLocationOf({
        ...typed,
        canonical_neighborhood: 'Copacabana',
        canonical_city: 'Rio de Janeiro',
      }),
    ).toEqual({
      neighborhood: 'Copacabana',
      city: 'Rio de Janeiro',
      zipCode: '22041001',
    });
    expect(
      deliveryLocationOf({
        ...typed,
        canonical_neighborhood: null,
        canonical_city: 'Rio de Janeiro',
      }),
    ).toEqual({
      neighborhood: 'Centro',
      city: 'Rio de Janeiro',
      zipCode: '22041001',
    });
    expect(deliveryLocationOf(typed)).toEqual({
      neighborhood: 'Centro',
      city: 'Rio',
      zipCode: '22041001',
    });
  });

  it('orçamento confere de novo: nunca conferido, ou serviço fora do ar há mais de 1 h', () => {
    const base = { zipCode: '22041001', neighborhood: 'Centro', city: 'Rio' };
    expect(needsLocationRefresh(base, AT)).toBe(true);
    expect(needsLocationRefresh({ ...base, cep_status: null }, AT)).toBe(true);
    for (const cep_status of ['FOUND', 'NO_NEIGHBORHOOD', 'NOT_FOUND'] as const)
      expect(
        needsLocationRefresh({ ...base, cep_status, cep_checked_at: null }, AT),
      ).toBe(false);

    const recent = new Date(AT.getTime() - ADDRESS_LOCATION_RETRY_MS + 1000);
    const old = new Date(AT.getTime() - ADDRESS_LOCATION_RETRY_MS);
    expect(
      needsLocationRefresh(
        { ...base, cep_status: 'UNAVAILABLE', cep_checked_at: recent },
        AT,
      ),
    ).toBe(false);
    expect(
      needsLocationRefresh(
        { ...base, cep_status: 'UNAVAILABLE', cep_checked_at: old },
        AT,
      ),
    ).toBe(true);
  });
});

describe('AddressLocationService', () => {
  function setup(outcome = found('Copacabana')) {
    const cepLookup = { lookup: jest.fn().mockResolvedValue(outcome) };
    const repo = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    const service = new AddressLocationService(
      cepLookup as unknown as CepLookupService,
      repo as unknown as Repository<Address>,
    );
    return { service, cepLookup, repo };
  }

  const address = (extra: Partial<Address> = {}) =>
    ({
      id: 9,
      zipCode: '22041001',
      neighborhood: 'Centro',
      city: 'Rio de Janeiro',
      state: 'RJ',
      cep_status: null,
      ...extra,
    }) as Address;

  it('resolve consulta o CEP para a zona (prazo curto, sem internet nos testes sem o mapa)', async () => {
    const { service, cepLookup } = setup();
    await expect(service.resolve('22041-001')).resolves.toMatchObject({
      canonical_neighborhood: 'Copacabana',
      neighborhood_source: 'CEP',
    });
    expect(cepLookup.lookup).toHaveBeenCalledWith('22041-001', 'zone');
  });

  it('refresh (orçamento): endereço antigo é conferido e gravado só se o CEP não mudou', async () => {
    const { service, repo } = setup();
    const refreshed = await service.refresh(address());
    expect(refreshed).toMatchObject({
      id: 9,
      neighborhood: 'Centro',
      canonical_neighborhood: 'Copacabana',
      cep_status: 'FOUND',
    });
    expect(repo.update).toHaveBeenCalledWith(
      { id: 9, zipCode: '22041001' },
      expect.objectContaining({
        canonical_neighborhood: 'Copacabana',
        neighborhood_source: 'CEP',
      }),
    );
  });

  it('refresh não consulta endereço já conferido', async () => {
    const { service, cepLookup, repo } = setup();
    const current = address({ cep_status: 'FOUND' });
    await expect(service.refresh(current)).resolves.toBe(current);
    expect(cepLookup.lookup).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('falha ao gravar a conferência não impede o orçamento', async () => {
    const { service, repo } = setup({ status: 'unavailable' } as never);
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    repo.update.mockRejectedValueOnce(new Error('conexão perdida'));
    await expect(service.refresh(address())).resolves.toMatchObject({
      neighborhood_source: 'MANUAL',
      cep_status: 'UNAVAILABLE',
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('#9'));
    warn.mockRestore();
  });
});
