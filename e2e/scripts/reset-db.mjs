// Recria do zero o banco usado pelos testes E2E (nunca o banco de desenvolvimento).
// O schema é criado pelo backend (TypeORM synchronize) e os usuários padrão pelo seed na subida.
import pg from 'pg';

const database = process.env.E2E_DB_DATABASE ?? 'comestra_e2e';
if (!/_e2e$/.test(database)) {
  console.error(`Recusado: "${database}" não termina com _e2e. Este script só apaga bancos de teste.`);
  process.exit(1);
}

const client = new pg.Client({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USERNAME ?? 'postgres',
  password: process.env.DB_PASSWORD ?? '',
  database: 'postgres',
});

await client.connect();
await client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
await client.query(`CREATE DATABASE "${database}"`);
await client.end();
console.log(`Banco de testes "${database}" recriado.`);
