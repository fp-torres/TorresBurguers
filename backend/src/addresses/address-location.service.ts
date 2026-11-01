import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  locationFromLookup,
  needsLocationRefresh,
  type AddressLocationFields,
} from './address-location';
import { CepLookupService } from './cep-lookup.service';
import { Address } from './entities/address.entity';

/**
 * Bairro, cidade e UF canônicos dos endereços pelo CEP (a zona de entrega usa esses valores).
 * Nunca impede salvar o endereço nem orçar: sem resposta do serviço de CEP, vale o que o cliente digitou
 * e o endereço fica marcado como "bairro informado manualmente" (neighborhood_source = MANUAL).
 */
@Injectable()
export class AddressLocationService {
  private readonly logger = new Logger(AddressLocationService.name);

  constructor(
    private readonly cepLookup: CepLookupService,
    @InjectRepository(Address)
    private readonly addressRepository: Repository<Address>,
  ) {}

  /** Campos canônicos do CEP informado (cadastro e edição do endereço). */
  async resolve(zipCode: string): Promise<AddressLocationFields> {
    const outcome = await this.cepLookup.lookup(zipCode, 'zone');
    return locationFromLookup(outcome, new Date());
  }

  /**
   * Orçamento: confere o CEP dos endereços ainda não conferidos (cadastrados antes) ou cuja conferência
   * pegou o serviço fora do ar há mais de 1 h, grava o resultado (só se o CEP não mudou nesse meio-tempo)
   * e devolve o endereço atualizado. Falha ao gravar não impede o orçamento.
   */
  async refresh(address: Address): Promise<Address> {
    if (!needsLocationRefresh(address, new Date())) return address;
    const fields = await this.resolve(address.zipCode);
    try {
      await this.addressRepository.update(
        { id: address.id, zipCode: address.zipCode },
        fields,
      );
    } catch (error) {
      this.logger.warn(
        `Não foi possível gravar a conferência do CEP do endereço #${address.id}: ${(error as Error).message}`,
      );
    }
    return Object.assign(address, fields);
  }
}
