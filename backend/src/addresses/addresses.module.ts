import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm'; // <--- Importante
import { AddressesService } from './addresses.service';
import { AddressesController } from './addresses.controller';
import { Address } from './entities/address.entity'; // <--- Importante

@Module({
  imports: [TypeOrmModule.forFeature([Address])], // <--- Registra a tabela
  controllers: [AddressesController],
  providers: [AddressesService],
})
export class AddressesModule {}