import { Controller, Post, Body, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  async login(@Body() loginDto: LoginDto) {
    // 1. Verifica se o usuário existe e a senha bate
    const user = await this.authService.validateUser(
      loginDto.email,
      loginDto.password,
    );

    // 2. Se a validação falhar, retorna Erro 401 (Não Autorizado)
    if (!user) {
      throw new UnauthorizedException('Email ou senha inválidos');
    }

    // 3. Se deu certo, gera o Token JWT e devolve
    return this.authService.login(user);
  }
}