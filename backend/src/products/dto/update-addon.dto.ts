import { PartialType } from '@nestjs/swagger';
import { CreateAddonDto } from './create-addon.dto';

/**
 * Atualização parcial do adicional: envie só o que mudou. Corpo vazio não altera nada.
 * null é recusado em nome/preço/categoria/available e aceito em description/image (limpa o campo).
 */
export class UpdateAddonDto extends PartialType(CreateAddonDto, {
  skipNullProperties: false,
}) {}
