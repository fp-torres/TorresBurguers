import {
  BadGatewayException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { CepLookupService } from '../addresses/cep-lookup.service';
import type { GeocodingService } from '../addresses/geocoding.service';
import type { RateLimitService } from '../common/rate-limit/rate-limit.service';
import type { TenantContext } from '../tenancy/tenant-context';
import type { DeliverySimulationDto } from './dto/delivery-tools.dto';
import type { Store } from './entities/store.entity';
import {
  GEOCODE_UNAVAILABLE_MESSAGE,
  SIMULATION_CONFIG_REQUIRED_MESSAGE,
  STORE_GEOCODE_NOT_FOUND_MESSAGE,
  STORE_ZIP_REQUIRED_MESSAGE,
  StoreDeliveryToolsService,
} from './store-delivery-tools.service';

const ORIGIN = { lat: -22.9035, lng: -43.2096 };
/** Ponto "km" quilômetros ao norte da loja, em linha reta. */
const north = (km: number) => ({
  lat: ORIGIN.lat + km / 111.19492664,
  lng: ORIGIN.lng,
});

const DISTANCE_CONFIG = {
  zones: [{ neighborhoods: ['Centro'], fee: 3, time: '20 min' }],
  fallback: { fee: 15, time: '60-70 min' },
  min_order: 20,
  mode: 'distance',
  distance: {
    bands: [
      { up_to_km: 2, fee: 5, time: '25-35 min' },
      { up_to_km: 5, fee: 8, time: '35-45 min', min_order: 40 },
    ],
    max_km: 8,
    extra_km_fee: 2,
    route_factor: 1.3,
  },
};

function setup(store: Partial<Store> = {}) {
  const row = {
    id: 7,
    address_zip_code: '20040003',
    address_street: 'Av. Rio Branco',
    address_number: '100',
    address_neighborhood: 'Centro',
    address_city: 'Rio de Janeiro',
    address_state: 'RJ',
    latitude: ORIGIN.lat,
    longitude: ORIGIN.lng,
    delivery_zones: DISTANCE_CONFIG,
    ...store,
  } as unknown as Store;
  const stores = { findOne: jest.fn().mockResolvedValue(row) };
  const geocoder = {
    geocode: jest.fn(),
    roadDistanceKm: jest.fn().mockResolvedValue(null),
  };
  const cepLookup = {
    lookup: jest.fn().mockResolvedValue({
      status: 'found',
      address: {
        cep: '22041-001',
        logradouro: 'Rua do CEP',
        complemento: '',
        bairro: 'Copacabana',
        localidade: 'Rio de Janeiro',
        uf: 'RJ',
      },
    }),
  };
  const rateLimit = { consume: jest.fn() };
  const service = new StoreDeliveryToolsService(
    stores as unknown as Repository<Store>,
    geocoder as unknown as GeocodingService,
    cepLookup as unknown as CepLookupService,
    rateLimit as unknown as RateLimitService,
  );
  const tenant = { storeId: 7 } as TenantContext;
  return { service, geocoder, cepLookup, rateLimit, tenant, stores };
}

const found = (point: { lat: number; lng: number }, precision = 'ADDRESS') => ({
  status: 'found',
  ...point,
  precision,
  source: 'FAKE',
});

describe('StoreDeliveryToolsService — localizar a loja', () => {
  it('sem CEP no corpo, localiza o endereço salvo da loja (limite de tentativas por loja)', async () => {
    const { service, geocoder, rateLimit, tenant } = setup();
    geocoder.geocode.mockResolvedValue(found(ORIGIN));
    await expect(service.geocodeStore(tenant, {})).resolves.toEqual({
      latitude: ORIGIN.lat,
      longitude: ORIGIN.lng,
      precision: 'ADDRESS',
      source: 'FAKE',
    });
    expect(geocoder.geocode).toHaveBeenCalledWith(
      expect.objectContaining({
        zipCode: '20040003',
        street: 'Av. Rio Branco',
        number: '100',
      }),
      'panel',
    );
    expect(rateLimit.consume).toHaveBeenCalledWith(
      'CEP_LOOKUP',
      'store-delivery:7',
    );
  });

  it('com o endereço no corpo (ainda não salvo), usa o informado', async () => {
    const { service, geocoder, tenant } = setup();
    geocoder.geocode.mockResolvedValue(found(ORIGIN, 'ZIP_CENTER'));
    await expect(
      service.geocodeStore(tenant, {
        zip_code: '22041001',
        street: 'Rua Nova',
      }),
    ).resolves.toMatchObject({ precision: 'ZIP_CENTER' });
    expect(geocoder.geocode).toHaveBeenCalledWith(
      expect.objectContaining({ zipCode: '22041001', street: 'Rua Nova' }),
      'panel',
    );
  });

  it('sem CEP salvo → 400; não encontrado → 404; serviço fora do ar → 502', async () => {
    const empty = setup({ address_zip_code: null });
    await expect(empty.service.geocodeStore(empty.tenant, {})).rejects.toThrow(
      new BadRequestException(STORE_ZIP_REQUIRED_MESSAGE),
    );
    const { service, geocoder, tenant } = setup();
    geocoder.geocode.mockResolvedValueOnce({ status: 'not_found' });
    await expect(service.geocodeStore(tenant, {})).rejects.toThrow(
      new NotFoundException(STORE_GEOCODE_NOT_FOUND_MESSAGE),
    );
    geocoder.geocode.mockResolvedValueOnce({ status: 'unavailable' });
    await expect(service.geocodeStore(tenant, {})).rejects.toThrow(
      new BadGatewayException(GEOCODE_UNAVAILABLE_MESSAGE),
    );
  });
});

describe('StoreDeliveryToolsService — testar um endereço', () => {
  const dto = (extra: Partial<DeliverySimulationDto> = {}) =>
    ({ zip_code: '22041001', number: '10', ...extra }) as DeliverySimulationDto;

  it('modo distância: distância, faixa, taxa, prazo e as regras da faixa (endereço completado pelo CEP)', async () => {
    const { service, geocoder, tenant } = setup();
    geocoder.geocode.mockResolvedValue(found(north(3))); // 3,9 km
    const result = await service.simulate(tenant, dto());
    expect(result).toEqual({
      mode: 'distance',
      address: {
        zip_code: '22041001',
        street: 'Rua do CEP',
        neighborhood: 'Copacabana',
        city: 'Rio de Janeiro',
        state: 'RJ',
      },
      store_located: true,
      located: true,
      precision: 'ADDRESS',
      distance_km: 3.9,
      max_km: 8,
      band: 2,
      extra_km: 0,
      zone: null,
      outside: false,
      refused: false,
      delivery_fee: 8,
      estimated_delivery_time: '35-45 min',
      min_order: 40,
      free_delivery_above: null,
      message:
        'A 3,9 km da loja (faixa 2: até 5 km): taxa R$ 8,00, prazo 35-45 min.',
    });
    expect(geocoder.geocode).toHaveBeenCalledWith(
      expect.objectContaining({
        street: 'Rua do CEP',
        number: '10',
        city: 'Rio de Janeiro',
      }),
      'panel',
    );
  });

  it('km adicional e além do raio (taxa padrão ou recusa); o rascunho da tela vale no lugar do salvo', async () => {
    const { service, geocoder, tenant } = setup();
    geocoder.geocode.mockResolvedValue(found(north(5))); // 6,5 km → 2 km além de 5
    await expect(service.simulate(tenant, dto())).resolves.toMatchObject({
      band: 2,
      extra_km: 2,
      delivery_fee: 12,
      min_order: 40,
    });
    geocoder.geocode.mockResolvedValue(found(north(10))); // 13 km
    await expect(service.simulate(tenant, dto())).resolves.toMatchObject({
      outside: true,
      refused: false,
      delivery_fee: 15,
      min_order: 20,
      message:
        'A 13 km da loja, além do raio de 8 km: o cliente paga a taxa padrão (taxa R$ 15,00, prazo 60-70 min).',
    });
    const refusing = await service.simulate(
      tenant,
      dto({
        delivery_zones: {
          ...DISTANCE_CONFIG,
          outside_zones: 'refuse',
        } as never,
      }),
    );
    expect(refusing).toMatchObject({
      outside: true,
      refused: true,
      delivery_fee: null,
      estimated_delivery_time: null,
    });
    expect(refusing.message).toContain('a entrega é recusada');
  });

  it('local da loja do rascunho; sem local, avisa; endereço não localizado → política de fora da área', async () => {
    const { service, geocoder, tenant } = setup({
      latitude: null,
      longitude: null,
    });
    await expect(service.simulate(tenant, dto())).resolves.toMatchObject({
      store_located: false,
      located: false,
      outside: true,
      message: 'Informe o local da loja no mapa para calcular a distância.',
    });
    expect(geocoder.geocode).not.toHaveBeenCalled();

    geocoder.geocode.mockResolvedValue(found(north(1), 'ZIP_CENTER'));
    await expect(
      service.simulate(
        tenant,
        dto({ latitude: ORIGIN.lat, longitude: ORIGIN.lng }),
      ),
    ).resolves.toMatchObject({
      located: true,
      precision: 'ZIP_CENTER',
      distance_km: 1.3,
      band: 1,
      message:
        'A 1,3 km da loja, pelo centro do CEP (faixa 1: até 2 km): taxa R$ 5,00, prazo 25-35 min.',
    });

    geocoder.geocode.mockResolvedValue({ status: 'unavailable' });
    const missing = await service.simulate(
      tenant,
      dto({ latitude: ORIGIN.lat, longitude: ORIGIN.lng }),
    );
    expect(missing).toMatchObject({
      located: false,
      outside: true,
      delivery_fee: 15,
    });
    expect(missing.message).toContain('O serviço de mapas não respondeu agora');
  });

  it('distância por rua quando a loja pede (com queda para a linha reta)', async () => {
    const { service, geocoder, tenant } = setup({
      delivery_zones: {
        ...DISTANCE_CONFIG,
        distance: { ...DISTANCE_CONFIG.distance, road_distance: true },
      } as never,
    });
    geocoder.geocode.mockResolvedValue(found(north(1)));
    geocoder.roadDistanceKm.mockResolvedValueOnce(4.4);
    await expect(service.simulate(tenant, dto())).resolves.toMatchObject({
      distance_km: 4.4,
      band: 2,
    });
    await expect(service.simulate(tenant, dto())).resolves.toMatchObject({
      distance_km: 1.3,
      band: 1,
    });
  });

  it('modo por zonas: a zona pelo bairro do CEP (sem localizar no mapa)', async () => {
    const { service, geocoder, tenant } = setup({
      delivery_zones: {
        zones: [
          { neighborhoods: ['Centro'], fee: 3, time: '20 min' },
          {
            neighborhoods: ['Copacabana'],
            fee: 7,
            time: '40 min',
            free_delivery_above: 50,
          },
        ],
        fallback: { fee: 12, time: '60 min' },
      },
    });
    await expect(service.simulate(tenant, dto())).resolves.toMatchObject({
      mode: 'zones',
      zone: 2,
      outside: false,
      delivery_fee: 7,
      free_delivery_above: 50,
      message: 'Zona 2 (bairro Copacabana): taxa R$ 7,00, prazo 40 min.',
    });
    expect(geocoder.geocode).not.toHaveBeenCalled();
  });

  it('sem configuração de entrega (nem no rascunho) → 400', async () => {
    const { service, tenant } = setup({ delivery_zones: null });
    await expect(service.simulate(tenant, dto())).rejects.toThrow(
      SIMULATION_CONFIG_REQUIRED_MESSAGE,
    );
  });
});
