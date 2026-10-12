import { Injectable } from '@nestjs/common';
import { BRAND } from './config/brand';
import { APP_VERSION } from './config/version';

export interface HealthStatus {
  status: 'ok';
  name: string;
  version: string;
}

@Injectable()
export class AppService {
  // Usado por monitoramento, balanceadores e pelos testes para saber se a API está no ar
  getHealth(): HealthStatus {
    return { status: 'ok', name: BRAND.name, version: APP_VERSION };
  }
}
