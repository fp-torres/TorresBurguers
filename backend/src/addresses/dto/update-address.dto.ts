import { PartialType } from '@nestjs/swagger';
import { CreateAddressDto } from './create-address.dto';

/**
 * Atualização parcial do endereço: envie só o que mudou.
 * null é recusado nos campos obrigatórios e aceito nos opcionais (apelido, complemento, coordenadas).
 */
export class UpdateAddressDto extends PartialType(CreateAddressDto, {
  skipNullProperties: false,
}) {}
