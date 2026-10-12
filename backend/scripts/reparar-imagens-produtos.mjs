// Repara as imagens de produtos que apontam para arquivos que não existem mais em uploads/.
// Caso comum: a otimização em massa (POST /maintenance/optimize-images) converteu "X.jpg" em
// "X-<timestamp>.webp" em outra máquina e só os arquivos novos vieram pelo git.
//
// Uso (na pasta backend/):
//   node scripts/reparar-imagens-produtos.mjs            # só mostra a prévia
//   node scripts/reparar-imagens-produtos.mjs --aplicar  # grava as correções
//
// Conexão: variáveis DB_* do ambiente ou do backend/.env (padrão: banco "comestra" em localhost).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, parse, resolve } from 'node:path';
import pg from 'pg';

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

loadDotEnv(resolve('.env'));
const apply = process.argv.includes('--aplicar');
const uploads = resolve(process.env.UPLOADS_DIR || 'uploads');
const files = existsSync(uploads) ? readdirSync(uploads) : [];

const client = new pg.Client({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_DATABASE || 'comestra',
});
await client.connect();

const { rows } = await client.query('SELECT id, name, image FROM products WHERE image IS NOT NULL ORDER BY id');
const fixes = [];
const missing = [];
for (const product of rows) {
  if (/^https?:\/\//i.test(product.image) || existsSync(join(uploads, product.image))) continue;
  const base = parse(product.image).name;
  const candidate = files.filter((f) => f.startsWith(`${base}-`) && f.endsWith('.webp')).sort().pop();
  if (candidate) fixes.push({ ...product, next: candidate });
  else missing.push(product);
}

console.log(`Pasta de imagens: ${uploads}`);
console.log(`\nCorreções encontradas: ${fixes.length}`);
for (const f of fixes) console.log(`  #${f.id} ${f.name}: ${f.image} -> ${f.next}`);
console.log(`\nSem arquivo correspondente (refaça o upload no painel): ${missing.length}`);
for (const m of missing) console.log(`  #${m.id} ${m.name}: ${m.image}`);

if (apply && fixes.length) {
  await client.query('BEGIN');
  for (const f of fixes) await client.query('UPDATE products SET image = $1 WHERE id = $2', [f.next, f.id]);
  await client.query('COMMIT');
  console.log(`\n${fixes.length} produto(s) atualizado(s).`);
} else if (fixes.length) {
  console.log('\nNada foi alterado. Rode com --aplicar para gravar as correções.');
}
await client.end();
