import 'reflect-metadata';
import { config } from 'dotenv';
import { DataSource } from 'typeorm';
import { typeOrmOptions } from './typeorm.config';

// CLI do TypeORM (npm run migration:*): lê o mesmo .env da API; variáveis do ambiente têm prioridade.
config({ quiet: true });

/** DataSource do CLI: nunca roda synchronize nem migrations sozinho (o próprio comando decide). */
export default new DataSource({
  ...typeOrmOptions(),
  migrationsRun: false,
  synchronize: false,
});
