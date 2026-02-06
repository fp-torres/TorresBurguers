import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';
import { Address } from './entities/address.entity';
import { User } from '../users/entities/user.entity';

@Injectable()
export class AddressesService {
  constructor(
    @InjectRepository(Address)
    private addressRepository: Repository<Address>,
  ) {}

  async create(createAddressDto: CreateAddressDto, userId: number) {
    const address = this.addressRepository.create({
      ...createAddressDto,
      user: { id: userId } as User, // Associa ao usuário logado
    });
    return this.addressRepository.save(address);
  }

  async findAll(userId: number) {
    return this.addressRepository.find({
      where: { user: { id: userId } }, // Filtra só os endereços DESTE usuário
    });
  }

  async findOne(id: number, userId: number) {
    const address = await this.addressRepository.findOne({
      where: { id, user: { id: userId } }, // Garante que pertence ao usuário
    });

    if (!address) {
      throw new NotFoundException(`Endereço não encontrado ou acesso negado.`);
    }
    return address;
  }

  async update(id: number, updateAddressDto: UpdateAddressDto, userId: number) {
    const address = await this.findOne(id, userId); // Reusa a lógica de segurança
    
    this.addressRepository.merge(address, updateAddressDto);
    return this.addressRepository.save(address);
  }

  async remove(id: number, userId: number) {
    const address = await this.findOne(id, userId); // Reusa a lógica de segurança
    return this.addressRepository.remove(address);
  }
}