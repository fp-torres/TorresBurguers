import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AddressesService } from './addresses.service';
import { AddressesController } from './addresses.controller';
import { AddressLocationService } from './address-location.service';
import { CepLookupService } from './cep-lookup.service';
import { Address } from './entities/address.entity';

/**
 * Endereços dos clientes e busca de CEP. AddressLocationService (bairro, cidade e UF canônicos pelo CEP) é
 * exportado para o orçamento (OrderPricingModule) conferir os endereços antigos.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Address])],
  controllers: [AddressesController],
  providers: [AddressesService, CepLookupService, AddressLocationService],
  exports: [AddressesService, CepLookupService, AddressLocationService],
})
export class AddressesModule {}
