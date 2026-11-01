// Repara as imagens de produtos que apontam para arquivos que não existem mais em uploads/.
// Caso comum: a otimização em massa (POST /platform/maintenance/optimize-images) converteu "X.jpg"
// em "X-<timestamp>.webp" — ou, para imagens antigas sem dono, em "s<loja>-X-<timestamp>.webp" —
// em outra máquina e só os arquivos novos vieram pelo git.
//
// Multi-tenant: atua SOMENTE na loja padrão da plataforma — a mesma das rotas antigas da API:
// DEFAULT_STORE_SLUG (se definido no ambiente/.env) ou platform_settings.default_store_id (a loja
// inicial criada pela migração da instalação de loja única). Produtos das outras lojas nunca são
// lidos nem alterados, e só são aceitos arquivos sem prefixo de loja ou com o prefixo da loja padrão.
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

/** Loja padrão: DEFAULT_STORE_SLUG ou platform_settings.default_store_id (como na API). */
async function defaultStore() {
  const slug = process.env.DEFAULT_STORE_SLUG?.trim().toLowerCase();
  const { rows } = slug
    ? await client.query('SELECT id, slug, name FROM stores WHERE slug = $1', [slug])
    : await client.query(
        `SELECT s.id, s.slug, s.name FROM platform_settings ps
         JOIN stores s ON s.id = ps.default_store_id WHERE ps.id = 1`,
      );
  return rows[0] ?? null;
}

const store = await defaultStore();
if (!store) {
  console.log('Nenhuma loja padrão definida (DEFAULT_STORE_SLUG ou platform_settings.default_store_id). Nada a fazer.');
  await client.end();
  process.exit(0);
}

const ownPrefix = `s${store.id}-`;
/** Arquivo que a loja padrão pode usar: sem prefixo de loja ou com o prefixo dela. */
const usable = (file) => !/^s\d+-/.test(file) || file.startsWith(ownPrefix);

const { rows } = await client.query(
  'SELECT id, name, image FROM products WHERE store_id = $1 AND image IS NOT NULL ORDER BY id',
  [store.id],
);
const fixes = [];
const missing = [];
for (const product of rows) {
  if (/^https?:\/\//i.test(product.image) || existsSync(join(uploads, product.image))) continue;
  const base = parse(product.image).name;
  // Nome convertido: "<base>-<timestamp>.webp" ou, para imagem antiga sem dono, "s<loja>-<base>-<timestamp>.webp"
  const starts = [`${base}-`, `${ownPrefix}${base}-`];
  const candidate = files
    .filter((f) => f.endsWith('.webp') && usable(f) && starts.some((start) => f.startsWith(start)))
    .sort()
    .pop();
  if (candidate) fixes.push({ ...product, next: candidate });
  else missing.push(product);
}

console.log(`Loja padrão: #${store.id} ${store.name} (${store.slug})`);
console.log(`Pasta de imagens: ${uploads}`);
console.log(`\nCorreções encontradas: ${fixes.length}`);
for (const f of fixes) console.log(`  #${f.id} ${f.name}: ${f.image} -> ${f.next}`);
console.log(`\nSem arquivo correspondente (refaça o upload no painel): ${missing.length}`);
for (const m of missing) console.log(`  #${m.id} ${m.name}: ${m.image}`);

if (apply && fixes.length) {
  await client.query('BEGIN');
  let updated = 0;
  for (const f of fixes) {
    // Critério composto: o produto da loja padrão que ainda aponta para a imagem lida
    const result = await client.query(
      'UPDATE products SET image = $1 WHERE id = $2 AND store_id = $3 AND image = $4',
      [f.next, f.id, store.id, f.image],
    );
    updated += result.rowCount ?? 0;
  }
  await client.query('COMMIT');
  console.log(`\n${updated} produto(s) atualizado(s).`);
} else if (fixes.length) {
  console.log('\nNada foi alterado. Rode com --aplicar para gravar as correções.');
}
await client.end();
