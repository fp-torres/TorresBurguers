import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';
import { Address } from './entities/address.entity';
import { User } from '../users/entities/user.entity';

@Injectable()
export class AddressesService {
  private readonly logger = new Logger(AddressesService.name);

  constructor(
    @InjectRepository(Address)
    private addressRepository: Repository<Address>,
  ) {}

  // --- BUSCA CEP COM FALLBACK (ViaCEP -> BrasilAPI) ---
  async findCep(cep: string) {
    const cleanCep = cep.replace(/\D/g, '');
    
    if (cleanCep.length !== 8) {
      throw new BadRequestException('CEP inválido. O CEP deve conter exatamente 8 números.');
    }

    // --- TENTATIVA 1: ViaCEP ---
    try {
      this.logger.log(`Tentativa 1: ViaCEP -> ${cleanCep}`);
      const response = await fetch(`https://viacep.com.br/ws/${cleanCep}/json/`);
      
      if (response.ok) {
        const data = await response.json();
        if (!data.erro) {
          this.logger.log(`Sucesso via ViaCEP: ${data.localidade}`);
          return data;
        }
      }
      this.logger.warn(`ViaCEP falhou (Status: ${response.status}). Tentando Plano B...`);
    } catch (e) {
      this.logger.error(`Erro de conexão com ViaCEP: ${e.message}`);
    }

    // --- TENTATIVA 2: BrasilAPI (Fallback) ---
    try {
      this.logger.log(`Tentativa 2 (Fallback): BrasilAPI -> ${cleanCep}`);
      const response = await fetch(`https://brasilapi.com.br/api/cep/v1/${cleanCep}`);
      
      if (!response.ok) {
        throw new Error(`BrasilAPI retornou status ${response.status}`);
      }

      const data = await response.json();

      // NORMALIZAÇÃO: O BrasilAPI usa nomes em inglês. 
      // Convertemos para o padrão ViaCEP que seu Frontend já espera.
      return {
        logradouro: data.street || '',
        bairro: data.neighborhood || '',
        localidade: data.city || '',
        uf: data.state || '',
        cep: data.cep || cleanCep,
        complemento: '' // BrasilAPI v1 geralmente não traz complemento
      };

    } catch (error) {
      this.logger.error(`Todas as APIs de CEP falharam ou CEP não existe.`);
      throw new NotFoundException('Não foi possível localizar o CEP automaticamente. Digite o endereço manualmente.');
    }
  }

  // --- MÉTODOS CRUD ORIGINAIS ---

  async create(createAddressDto: CreateAddressDto, userId: number) {
    const address = this.addressRepository.create({
      ...createAddressDto,
      user: { id: userId } as User, 
    });
    return this.addressRepository.save(address);
  }

  async findAll(userId: number) {
    return this.addressRepository.find({
      where: { user: { id: userId } }, 
    });
  }

  async findOne(id: number, userId: number) {
    const address = await this.addressRepository.findOne({
      where: { id, user: { id: userId } }, 
    });

    if (!address) {
      throw new NotFoundException(`Endereço não encontrado ou acesso negado.`);
    }
    return address;
  }

  async update(id: number, updateAddressDto: UpdateAddressDto, userId: number) {
    const address = await this.findOne(id, userId); 
    
    this.addressRepository.merge(address, updateAddressDto);
    return this.addressRepository.save(address);
  }

  async remove(id: number, userId: number) {
    const address = await this.findOne(id, userId); 
    return this.addressRepository.remove(address);
  }
}