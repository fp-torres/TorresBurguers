import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, IsNull, Repository } from 'typeorm';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { omitUndefined } from '../common/transforms';
import { AddressGeoService } from './address-geo.service';
import { AddressLocationService } from './address-location.service';
import { CepLookupService, type CepLookupResult } from './cep-lookup.service';
import { GEO_ADDRESS_FIELDS } from './geocoding';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';
import { Address } from './entities/address.entity';

export type { CepLookupResult } from './cep-lookup.service';

/** Endereços ativos por conta (os excluídos não contam). */
export const MAX_ADDRESSES_PER_USER = 20;
/** Teto da lista GET /addresses (contas antigas podem ter mais que o limite de criação). */
export const ADDRESSES_LIST_LIMIT = 100;
export const ADDRESSES_LIMIT_MESSAGE = `Limite de endereços atingido: cada conta pode ter até ${MAX_ADDRESSES_PER_USER} endereços. Exclua um endereço que não usa mais para cadastrar outro.`;

export const CEP_INVALID_MESSAGE =
  'CEP inválido. Informe os 8 dígitos (ex.: 22041-001).';
export const CEP_NOT_FOUND_MESSAGE =
  'CEP não encontrado. Confira o número ou preencha o endereço manualmente.';
export const CEP_UNAVAILABLE_MESSAGE =
  'Não foi possível consultar o CEP agora. Preencha o endereço manualmente.';

@Injectable()
export class AddressesService {
  constructor(
    @InjectRepository(Address)
    private readonly addressRepository: Repository<Address>,
    private readonly rateLimit: RateLimitService,
    private readonly cepLookup: CepLookupService,
    private readonly locations: AddressLocationService,
    private readonly geo: AddressGeoService,
  ) {}

  // --- BUSCA DE CEP (ViaCEP com fallback para a BrasilAPI; ver CepLookupService) ---

  /**
   * 400: CEP com formato inválido · 404: CEP inexistente · 502: serviços de CEP fora do ar ·
   * 429: muitas consultas do mesmo IP (a rota é pública e repassa a consulta a serviços externos).
   * clientIp: IP de quem chamou (ver common/request-meta.ts).
   */
  async findCep(
    cep: string,
    clientIp: string | null = null,
  ): Promise<CepLookupResult> {
    const digits = (cep ?? '').replace(/\D/g, '');
    if (digits.length !== 8) {
      throw new BadRequestException(CEP_INVALID_MESSAGE);
    }
    this.rateLimit.consume('CEP_LOOKUP', clientIp ?? 'desconhecido');

    const outcome = await this.cepLookup.lookup(digits, 'public');
    if (outcome.status === 'found') return outcome.address;
    if (outcome.status === 'not_found')
      throw new NotFoundException(CEP_NOT_FOUND_MESSAGE);
    throw new BadGatewayException(CEP_UNAVAILABLE_MESSAGE);
  }

  // --- ENDEREÇOS DO USUÁRIO LOGADO (endereço de outra pessoa → 404) ---

  /**
   * 429: muitas criações/edições da mesma conta (ADDRESS_WRITE) · 400: a conta já tem
   * MAX_ADDRESSES_PER_USER endereços (os excluídos não contam). Limite "suave": duas criações
   * simultâneas no limite exato podem passar por uma unidade (o limite de tentativas segura o resto).
   * O bairro, a cidade e a UF do CEP são conferidos e guardados (canonical_*): a zona de entrega usa esses
   * valores. Sem resposta do serviço de CEP, o endereço é salvo assim mesmo (neighborhood_source = MANUAL).
   */
  async create(createAddressDto: CreateAddressDto, userId: number) {
    this.rateLimit.consume('ADDRESS_WRITE', `user:${userId}`);
    const active = await this.addressRepository.count({
      where: { user: { id: userId }, deleted_at: IsNull() },
    });
    if (active >= MAX_ADDRESSES_PER_USER) {
      throw new BadRequestException(ADDRESSES_LIMIT_MESSAGE);
    }
    // CEP (zona) e coordenadas (entrega por distância) em paralelo; nenhum dos dois impede salvar
    const [location, coordinates] = await Promise.all([
      this.locations.resolve(createAddressDto.zipCode),
      this.geo.resolveForSave(createAddressDto),
    ]);
    const address = this.addressRepository.create({
      ...omitUndefined(createAddressDto),
      ...location,
      ...coordinates,
      user: { id: userId },
    } as DeepPartial<Address>);
    const saved = await this.addressRepository.save(address);
    return this.findOne(saved.id, userId);
  }

  /** Endereços da conta (os mais antigos primeiro), no máximo ADDRESSES_LIST_LIMIT. */
  findAll(userId: number) {
    return this.addressRepository.find({
      where: { user: { id: userId }, deleted_at: IsNull() },
      order: { id: 'ASC' },
      take: ADDRESSES_LIST_LIMIT,
    });
  }

  async findOne(id: number, userId: number) {
    const address = await this.addressRepository.findOne({
      where: { id, user: { id: userId }, deleted_at: IsNull() },
    });
    if (!address) {
      throw new NotFoundException('Endereço não encontrado.');
    }
    return address;
  }

  /**
   * Edição parcial. O CEP é conferido de novo quando muda, quando o endereço ainda não tinha sido conferido
   * ou quando a última conferência pegou o serviço de CEP fora do ar. Nada mudou (corpo vazio ou os
   * mesmos valores): devolve o endereço como está, sem gravar nem consultar o CEP de novo.
   */
  async update(id: number, updateAddressDto: UpdateAddressDto, userId: number) {
    this.rateLimit.consume('ADDRESS_WRITE', `user:${userId}`);
    const address = await this.findOne(id, userId);
    const changes = omitUndefined(updateAddressDto) as Record<string, unknown>;
    const current = address as unknown as Record<string, unknown>;
    const changed = Object.entries(changes).some(
      ([key, value]) => (current[key] ?? null) !== (value ?? null),
    );
    if (!changed) return address;
    const zipChanged =
      updateAddressDto.zipCode !== undefined &&
      updateAddressDto.zipCode !== address.zipCode;
    // Rua, número, bairro, cidade, UF ou CEP mudou: as coordenadas antigas não valem mais
    const placeChanged = GEO_ADDRESS_FIELDS.some(
      (field) =>
        updateAddressDto[field] !== undefined &&
        updateAddressDto[field] !== address[field],
    );
    this.addressRepository.merge(
      address,
      omitUndefined(updateAddressDto) as DeepPartial<Address>,
    );
    const [location, coordinates] = await Promise.all([
      zipChanged || !address.cep_status || address.cep_status === 'UNAVAILABLE'
        ? this.locations.resolve(address.zipCode)
        : null,
      placeChanged ? this.geo.resolveForSave(address) : null,
    ]);
    if (location) Object.assign(address, location);
    if (coordinates) Object.assign(address, coordinates);
    await this.addressRepository.save(address);
    return this.findOne(id, userId);
  }

  /**
   * Exclusão lógica: o endereço some da lista do cliente, mas pedidos antigos
   * continuam exibindo onde foram entregues (nunca falha por estar em uso).
   */
  async remove(id: number, userId: number) {
    const address = await this.findOne(id, userId);
    await this.addressRepository.update(address.id, { deleted_at: new Date() });
    return { id: address.id, message: 'Endereço removido.' };
  }
}
