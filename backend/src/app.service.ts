import { Injectable } from '@nestjs/common';

/**
 * Resposta pública de GET /health: só a situação. Nome do sistema e versão não saem (a rota é pública e
 * não deve ajudar a identificar a versão em produção); a versão continua no Swagger e no log da subida.
 */
export interface HealthStatus {
  status: 'ok';
}

@Injectable()
export class AppService {
  // Usado por monitoramento, balanceadores e pelos testes para saber se a API está no ar
  getHealth(): HealthStatus {
    return { status: 'ok' };
  }
}
