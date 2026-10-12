import { PartialType } from '@nestjs/swagger';
import { CreateProductDto } from './create-product.dto';

/**
 * Atualização parcial: envie só o que mudou (JSON ou multipart, como no cadastro).
 * skipNullProperties: false → null em campo obrigatório (nome, preço, categoria...) é recusado,
 * enquanto os opcionais aceitam null para limpar (promotion_price, image).
 */
export class UpdateProductDto extends PartialType(CreateProductDto, {
  skipNullProperties: false,
}) {}
