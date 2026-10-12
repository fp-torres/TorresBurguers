import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, IsNull, Repository } from 'typeorm';
import { omitUndefined } from '../common/transforms';
import { BRAND } from '../config/brand';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';
import { Address } from './entities/address.entity';

/** Tempo máximo de espera por cada serviço de CEP. */
const CEP_TIMEOUT_MS = 5000;

/** Endereço do CEP no formato do ViaCEP (o que os front-ends já usam). */
export interface CepLookupResult {
  cep: string;
  logradouro: string;
  complemento: string;
  bairro: string;
  localidade: string;
  uf: string;
}

interface JsonResponse {
  status: number;
  data: Record<string, unknown> | null;
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value : '';

const formatCep = (digits: string) =>
  `${digits.slice(0, 5)}-${digits.slice(5)}`;

@Injectable()
export class AddressesService {
  private readonly logger = new Logger(AddressesService.name);

  constructor(
    @InjectRepository(Address)
    private readonly addressRepository: Repository<Address>,
  ) {}

  // --- BUSCA DE CEP (ViaCEP com fallback para a BrasilAPI) ---

  /**
   * 400: CEP com formato inválido · 404: CEP inexistente · 502: serviços de CEP fora do ar.
   */
  async findCep(cep: string): Promise<CepLookupResult> {
    const digits = (cep ?? '').replace(/\D/g, '');
    if (digits.length !== 8) {
      throw new BadRequestException(
        'CEP inválido. Informe os 8 dígitos (ex.: 22041-001).',
      );
    }

    let notFound = false;

    // 1ª tentativa: ViaCEP (responde 200 com { erro: true } quando o CEP não existe)
    try {
      const { status, data } = await this.getJson(
        `https://viacep.com.br/ws/${digits}/json/`,
      );
      if (status === 200 && data && !data.erro) {
        return {
          cep: formatCep(text(data.cep).replace(/\D/g, '') || digits),
          logradouro: text(data.logradouro),
          complemento: text(data.complemento),
          bairro: text(data.bairro),
          localidade: text(data.localidade),
          uf: text(data.uf),
        };
      }
      if (status === 200) notFound = true;
      else this.logger.warn(`ViaCEP respondeu HTTP ${status}.`);
    } catch (error) {
      this.logger.warn(`ViaCEP indisponível: ${(error as Error).message}`);
    }

    // 2ª tentativa: BrasilAPI (responde 404 quando o CEP não existe)
    try {
      const { status, data } = await this.getJson(
        `https://brasilapi.com.br/api/cep/v1/${digits}`,
      );
      if (status === 200 && data) {
        return {
          cep: formatCep(text(data.cep).replace(/\D/g, '') || digits),
          logradouro: text(data.street),
          complemento: '',
          bairro: text(data.neighborhood),
          localidade: text(data.city),
          uf: text(data.state),
        };
      }
      if (status === 404) notFound = true;
      else this.logger.warn(`BrasilAPI respondeu HTTP ${status}.`);
    } catch (error) {
      this.logger.warn(`BrasilAPI indisponível: ${(error as Error).message}`);
    }

    if (notFound) {
      throw new NotFoundException(
        'CEP não encontrado. Confira o número ou preencha o endereço manualmente.',
      );
    }
    throw new BadGatewayException(
      'Não foi possível consultar o CEP agora. Preencha o endereço manualmente.',
    );
  }

  private async getJson(url: string): Promise<JsonResponse> {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': `${BRAND.slug}-api`,
      },
      signal: AbortSignal.timeout(CEP_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status, data: null };
    }
    const data = (await response.json()) as unknown;
    return {
      status: response.status,
      data:
        data && typeof data === 'object'
          ? (data as Record<string, unknown>)
          : null,
    };
  }

  // --- ENDEREÇOS DO USUÁRIO LOGADO (endereço de outra pessoa → 404) ---

  async create(createAddressDto: CreateAddressDto, userId: number) {
    const address = this.addressRepository.create({
      ...omitUndefined(createAddressDto),
      user: { id: userId },
    } as DeepPartial<Address>);
    const saved = await this.addressRepository.save(address);
    return this.findOne(saved.id, userId);
  }

  findAll(userId: number) {
    return this.addressRepository.find({
      where: { user: { id: userId }, deleted_at: IsNull() },
      order: { id: 'ASC' },
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

  async update(id: number, updateAddressDto: UpdateAddressDto, userId: number) {
    const address = await this.findOne(id, userId);
    this.addressRepository.merge(
      address,
      omitUndefined(updateAddressDto) as DeepPartial<Address>,
    );
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
