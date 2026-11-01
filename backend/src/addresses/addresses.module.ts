import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Store } from '../store/entities/store.entity';
import { AddressesService } from './addresses.service';
import { AddressesController } from './addresses.controller';
import { AddressGeoService } from './address-geo.service';
import { AddressLocationService } from './address-location.service';
import { CepLookupService } from './cep-lookup.service';
import { Address } from './entities/address.entity';
import { GeocodingService } from './geocoding.service';

/**
 * Endereços dos clientes e busca de CEP. AddressLocationService (bairro, cidade e UF canônicos pelo CEP) é
 * exportado para o orçamento (OrderPricingModule) conferir os endereços antigos. GeocodingService e
 * AddressGeoService (coordenadas para a entrega por distância) também: o orçamento localiza os endereços e o
 * painel da loja localiza a loja e simula entregas. Store: só para saber se alguma loja cobra por distância.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Address, Store])],
  controllers: [AddressesController],
  providers: [
    AddressesService,
    CepLookupService,
    AddressLocationService,
    GeocodingService,
    AddressGeoService,
  ],
  exports: [
    AddressesService,
    CepLookupService,
    AddressLocationService,
    GeocodingService,
    AddressGeoService,
  ],
})
export class AddressesModule {}
