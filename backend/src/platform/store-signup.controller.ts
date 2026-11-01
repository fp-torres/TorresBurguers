import { Body, Controller, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { StoreSignupDto } from './dto/store-signup.dto';
import { StoreSignupService } from './store-signup.service';

/**
 * Autoatendimento de novos estabelecimentos (público). Só a rota POST /stores/signup: as rotas GET de
 * /stores (diretório e vitrine) ficam no StoresController. "signup" é um endereço reservado: nenhuma
 * loja pode usá-lo como slug.
 */
@ApiTags('Cadastro de estabelecimentos')
@Controller('stores')
export class StoreSignupController {
  constructor(private readonly signupService: StoreSignupService) {}

  /**
   * { store: { name, slug }, owner: { name, email, password, phone? }, accept_terms: true } →
   * { access_token, user } (mesmo formato do login). Desabilitado → 404; e-mail ou endereço em uso → 409;
   * limite de tentativas por IP → 429.
   */
  @Post('signup')
  signup(@Body() dto: StoreSignupDto, @Req() req: Request) {
    return this.signupService.signup(dto, req);
  }
}
