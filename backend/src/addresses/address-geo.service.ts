import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Store } from '../store/entities/store.entity';
import { Address } from './entities/address.entity';
import {
  EMPTY_GEO_FIELDS,
  geoFieldsFromOutcome,
  needsGeoRefresh,
  type AddressGeoFields,
  type GeocodeQuery,
} from './geocoding';
import { GeocodingService } from './geocoding.service';

/** Por quanto tempo a resposta "alguma loja cobra por distância?" vale (por instância). */
export const DISTANCE_MODE_CHECK_TTL_MS = 30_000;

/** Endereço do cliente → pergunta para a cadeia de provedores. */
export function geocodeQueryOf(address: {
  zipCode: string;
  street?: string | null;
  number?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  state?: string | null;
}): GeocodeQuery {
  return {
    zipCode: address.zipCode,
    street: address.street,
    number: address.number,
    neighborhood: address.neighborhood,
    city: address.city,
    state: address.state,
  };
}

/**
 * Coordenadas dos endereços dos clientes (colunas geo_*), usadas só pela entrega por distância. Nunca impede
 * salvar o endereço nem orçar: sem resposta dos provedores, o endereço fica marcado (geo_status) e o orçamento
 * tenta de novo depois de 1 h; sem coordenadas, vale a política de fora da área da loja.
 *
 * O PADRÃO não muda nada: enquanto nenhuma loja cobra por distância, o cadastro do endereço não consulta
 * nenhum serviço externo (o endereço é localizado no primeiro orçamento por distância).
 */
@Injectable()
export class AddressGeoService {
  private readonly logger = new Logger(AddressGeoService.name);
  private distanceModeCache: { value: boolean; expiresAt: number } | null =
    null;

  constructor(
    private readonly geocoder: GeocodingService,
    @InjectRepository(Address)
    private readonly addressRepository: Repository<Address>,
    @InjectRepository(Store)
    private readonly storeRepository: Repository<Store>,
  ) {}

  /** Alguma loja ativa cobra a entrega por distância? (cache curto; falha de leitura = não). */
  async distanceModeInUse(): Promise<boolean> {
    const now = Date.now();
    if (this.distanceModeCache && this.distanceModeCache.expiresAt > now)
      return this.distanceModeCache.value;
    let value = false;
    try {
      value = await this.storeRepository
        .createQueryBuilder('store')
        .where(`store.delivery_zones ->> 'mode' = 'distance'`)
        .andWhere('store.delivery_enabled = true')
        .getExists();
    } catch (error) {
      this.logger.warn(
        `Não foi possível conferir se alguma loja cobra por distância: ${(error as Error).message}`,
      );
    }
    this.distanceModeCache = {
      value,
      expiresAt: now + DISTANCE_MODE_CHECK_TTL_MS,
    };
    return value;
  }

  /**
   * Cadastro e edição do endereço: localiza o endereço quando alguma loja cobra por distância; senão, deixa
   * as coordenadas vazias (localizadas no primeiro orçamento por distância).
   */
  async resolveForSave(
    address: Parameters<typeof geocodeQueryOf>[0],
  ): Promise<AddressGeoFields> {
    if (!(await this.distanceModeInUse())) return { ...EMPTY_GEO_FIELDS };
    const outcome = await this.geocoder.geocode(
      geocodeQueryOf(address),
      'save',
    );
    return geoFieldsFromOutcome(outcome, new Date());
  }

  /**
   * Orçamento por distância: localiza o endereço ainda não localizado (ou cujos provedores estavam fora do ar
   * há 1 h ou mais), grava o resultado — só se o endereço não mudou nesse meio-tempo — e devolve o endereço
   * atualizado. Falha ao gravar não impede o orçamento.
   */
  async refresh(address: Address): Promise<Address> {
    if (!needsGeoRefresh(address, new Date())) return address;
    const outcome = await this.geocoder.geocode(
      geocodeQueryOf(address),
      'quote',
    );
    const fields = geoFieldsFromOutcome(outcome, new Date());
    try {
      await this.addressRepository.update(
        {
          id: address.id,
          zipCode: address.zipCode,
          street: address.street,
          number: address.number,
        },
        fields,
      );
    } catch (error) {
      this.logger.warn(
        `Não foi possível gravar as coordenadas do endereço #${address.id}: ${(error as Error).message}`,
      );
    }
    return Object.assign(address, fields);
  }
}
