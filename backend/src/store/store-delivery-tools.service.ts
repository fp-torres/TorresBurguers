import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CepLookupService } from '../addresses/cep-lookup.service';
import type { GeoPrecision } from '../addresses/geocoding';
import { GeocodingService } from '../addresses/geocoding.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import {
  distanceDeliveryFor,
  maxDeliveryKm,
  storeDistanceSettings,
  straightDeliveryKm,
  validCoordinates,
  type DeliveryMode,
} from '../orders/delivery-distance';
import { DEFAULT_DELIVERY_ZONES } from '../orders/delivery-zones.config';
import {
  findDeliveryZone,
  formatBRL,
  outsideZonesPolicy,
  parseStoreOrderValueRules,
  storeDeliveryZones,
  type DeliveryEstimate,
  type OrderValueRules,
} from '../orders/order-rules';
import { STORE_NOT_FOUND_MESSAGE } from '../tenancy/tenant.service';
import type { TenantContext } from '../tenancy/tenant-context';
import {
  DeliverySimulationDto,
  GeocodeStoreDto,
} from './dto/delivery-tools.dto';
import { Store } from './entities/store.entity';

export const STORE_ZIP_REQUIRED_MESSAGE =
  'Informe o CEP da loja (seção Endereço) para localizá-la no mapa.';
export const STORE_GEOCODE_NOT_FOUND_MESSAGE =
  'Não encontramos este endereço no mapa. Confira o endereço da loja ou informe a latitude e a longitude manualmente.';
export const GEOCODE_UNAVAILABLE_MESSAGE =
  'O serviço de mapas não respondeu agora. Tente de novo em instantes ou informe a latitude e a longitude manualmente.';
export const SIMULATION_CONFIG_REQUIRED_MESSAGE =
  'Cadastre as zonas de entrega ou as faixas de distância para testar um endereço.';

/** POST /store/settings/geocode: o ponto encontrado (não é gravado). */
export interface StoreGeocodeView {
  latitude: number;
  longitude: number;
  /** ADDRESS (rua e número) ou ZIP_CENTER (centro do CEP: confira e ajuste o ponto). */
  precision: Exclude<GeoPrecision, 'MANUAL'>;
  source: string;
}

/** POST /store/settings/delivery-simulation. */
export interface DeliverySimulationView {
  mode: DeliveryMode;
  /** Endereço usado (o informado, completado pela busca do CEP). */
  address: {
    zip_code: string;
    street: string | null;
    neighborhood: string | null;
    city: string | null;
    state: string | null;
  };
  /** Modo distância: a loja tem local no mapa. */
  store_located: boolean;
  /** Modo distância: o endereço foi localizado no mapa. */
  located: boolean;
  precision: Exclude<GeoPrecision, 'MANUAL'> | null;
  distance_km: number | null;
  /** Raio máximo (modo distância). */
  max_km: number | null;
  /** Faixa atendida (1 = a primeira); null fora do raio ou no modo por zonas. */
  band: number | null;
  /** Km cobrados além da última faixa. */
  extra_km: number;
  /** Zona atendida (1 = a primeira); null fora das zonas ou no modo distância. */
  zone: number | null;
  /** Fora da área (zonas ou raio) ou não localizado. */
  outside: boolean;
  /** Fora da área numa loja que recusa: o cliente não consegue pedir. */
  refused: boolean;
  delivery_fee: number | null;
  estimated_delivery_time: string | null;
  /** Pedido mínimo e frete grátis que valem neste endereço (da faixa/zona ou da loja). */
  min_order: number | null;
  free_delivery_above: number | null;
  message: string;
}

const km = (value: number) =>
  `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km`;
const priceText = (estimate: DeliveryEstimate) =>
  `taxa ${estimate.fee > 0 ? formatBRL(estimate.fee) : 'grátis'}, prazo ${estimate.time}`;

/**
 * Ferramentas da entrega no painel (ADMIN): localizar a loja no mapa pelo endereço e testar um endereço com a
 * configuração em edição. Nada é gravado. Cada uma consulta serviços externos (CEP e mapas): limite de
 * tentativas por loja (política CEP_LOOKUP).
 */
@Injectable()
export class StoreDeliveryToolsService {
  constructor(
    @InjectRepository(Store)
    private readonly stores: Repository<Store>,
    private readonly geocoder: GeocodingService,
    private readonly cepLookup: CepLookupService,
    private readonly rateLimit: RateLimitService,
  ) {}

  async geocodeStore(
    tenant: TenantContext,
    dto: GeocodeStoreDto,
  ): Promise<StoreGeocodeView> {
    this.rateLimit.consume('CEP_LOOKUP', `store-delivery:${tenant.storeId}`);
    const store = await this.loadStore(tenant.storeId);
    const query = dto.zip_code
      ? {
          zipCode: dto.zip_code,
          street: dto.street,
          number: dto.number,
          neighborhood: dto.neighborhood,
          city: dto.city,
          state: dto.state,
        }
      : {
          zipCode: store.address_zip_code ?? '',
          street: store.address_street,
          number: store.address_number,
          neighborhood: store.address_neighborhood,
          city: store.address_city,
          state: store.address_state,
        };
    if (!query.zipCode)
      throw new BadRequestException(STORE_ZIP_REQUIRED_MESSAGE);
    const outcome = await this.geocoder.geocode(query, 'panel');
    if (outcome.status === 'not_found')
      throw new NotFoundException(STORE_GEOCODE_NOT_FOUND_MESSAGE);
    if (outcome.status === 'unavailable')
      throw new BadGatewayException(GEOCODE_UNAVAILABLE_MESSAGE);
    return {
      latitude: outcome.lat,
      longitude: outcome.lng,
      precision: outcome.precision,
      source: outcome.source,
    };
  }

  async simulate(
    tenant: TenantContext,
    dto: DeliverySimulationDto,
  ): Promise<DeliverySimulationView> {
    this.rateLimit.consume('CEP_LOOKUP', `store-delivery:${tenant.storeId}`);
    const store = await this.loadStore(tenant.storeId);
    const raw =
      dto.delivery_zones !== undefined
        ? dto.delivery_zones
        : store.delivery_zones;
    if (!raw) throw new BadRequestException(SIMULATION_CONFIG_REQUIRED_MESSAGE);
    const { config } = storeDeliveryZones(raw, DEFAULT_DELIVERY_ZONES);
    const storeRules = parseStoreOrderValueRules(raw);
    const refuses = outsideZonesPolicy(config) === 'refuse';

    // Endereço: o informado, completado pela busca do CEP (bairro e cidade do CEP valem para as zonas)
    const cep = await this.cepLookup.lookup(dto.zip_code, 'zone');
    const found = cep.status === 'found' ? cep.address : null;
    const address = {
      zip_code: dto.zip_code,
      street: dto.street ?? (found?.logradouro || null),
      neighborhood: found?.bairro || dto.neighborhood || null,
      city: found?.localidade || dto.city || null,
      state: found?.uf || dto.state || null,
    };

    const base = {
      address,
      store_located: false,
      located: false,
      precision: null,
      distance_km: null,
      max_km: null,
      band: null,
      extra_km: 0,
      zone: null,
    };
    const result = (
      outside: boolean,
      estimate: DeliveryEstimate | null,
      area: OrderValueRules | null,
      message: string,
    ) => ({
      outside,
      refused: outside && refuses,
      delivery_fee: outside && refuses ? null : (estimate?.fee ?? null),
      estimated_delivery_time:
        outside && refuses ? null : (estimate?.time ?? null),
      min_order:
        outside && refuses
          ? null
          : (area?.min_order ?? storeRules.min_order ?? 0) || null,
      free_delivery_above:
        outside && refuses
          ? null
          : (area?.free_delivery_above ??
            storeRules.free_delivery_above ??
            null),
      message,
    });
    const outsideText = refuses
      ? 'a entrega é recusada (o cliente vê o aviso no carrinho).'
      : `o cliente paga a taxa padrão (${priceText(config.fallback)}).`;

    const distance = storeDistanceSettings(raw);
    if (!distance) {
      const match = findDeliveryZone(
        {
          neighborhood: address.neighborhood,
          city: address.city,
          zipCode: dto.zip_code,
        },
        config,
      );
      const zoneIndex = match ? config.zones.indexOf(match) : -1;
      if (zoneIndex < 0)
        return {
          mode: 'zones',
          ...base,
          ...result(
            true,
            config.fallback,
            null,
            `Fora das zonas cadastradas: ${outsideText}`,
          ),
        };
      const zone = config.zones[zoneIndex];
      return {
        mode: 'zones',
        ...base,
        zone: zoneIndex + 1,
        ...result(
          false,
          zone,
          zone,
          `Zona ${zoneIndex + 1}${address.neighborhood ? ` (bairro ${address.neighborhood})` : ''}: ${priceText(zone)}.`,
        ),
      };
    }

    const maxKm = maxDeliveryKm(distance);
    const latitude = dto.latitude !== undefined ? dto.latitude : store.latitude;
    const longitude =
      dto.longitude !== undefined ? dto.longitude : store.longitude;
    const origin = validCoordinates(latitude, longitude);
    if (!origin)
      return {
        mode: 'distance',
        ...base,
        max_km: maxKm,
        ...result(
          true,
          config.fallback,
          null,
          'Informe o local da loja no mapa para calcular a distância.',
        ),
      };

    const outcome = await this.geocoder.geocode(
      {
        zipCode: dto.zip_code,
        street: address.street,
        number: dto.number,
        neighborhood: address.neighborhood,
        city: address.city,
        state: address.state,
      },
      'panel',
    );
    if (outcome.status !== 'found')
      return {
        mode: 'distance',
        ...base,
        store_located: true,
        max_km: maxKm,
        ...result(
          true,
          config.fallback,
          null,
          `${outcome.status === 'unavailable' ? 'O serviço de mapas não respondeu agora' : 'Não encontramos este endereço no mapa'}: ${outsideText}`,
        ),
      };

    const destination = { lat: outcome.lat, lng: outcome.lng };
    const road = distance.road_distance
      ? await this.geocoder.roadDistanceKm(origin, destination)
      : null;
    const distanceKm =
      road ?? straightDeliveryKm(origin, destination, distance.route_factor);
    const located = {
      mode: 'distance' as const,
      ...base,
      store_located: true,
      located: true,
      precision: outcome.precision,
      distance_km: distanceKm,
      max_km: maxKm,
    };
    const approx =
      outcome.precision === 'ZIP_CENTER' ? ', pelo centro do CEP' : '';
    const pick = distanceDeliveryFor(distanceKm, distance);
    if (!pick)
      return {
        ...located,
        ...result(
          true,
          config.fallback,
          null,
          `A ${km(distanceKm)} da loja${approx}, além do raio de ${km(maxKm)}: ${outsideText}`,
        ),
      };
    const where = pick.extraKm
      ? `${pick.extraKm} km além da última faixa`
      : `faixa ${pick.band}: até ${km(distance.bands[pick.band - 1].up_to_km)}`;
    return {
      ...located,
      band: pick.band,
      extra_km: pick.extraKm,
      ...result(
        false,
        pick,
        pick.area,
        `A ${km(distanceKm)} da loja${approx} (${where}): ${priceText(pick)}.`,
      ),
    };
  }

  private async loadStore(storeId: number): Promise<Store> {
    const store = await this.stores.findOne({ where: { id: storeId } });
    if (!store) throw new NotFoundException(STORE_NOT_FOUND_MESSAGE);
    return store;
  }
}
