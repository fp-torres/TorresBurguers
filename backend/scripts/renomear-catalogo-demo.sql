-- Renomeia o cardápio de demonstração herdado do antigo nome "TorresBurgers".
-- Opcional: os nomes de produtos são dados da loja (não do sistema). Rode só se quiser
-- apresentar o Comestra com um cardápio neutro.
--
-- Multi-tenant: atua SOMENTE na loja padrão da plataforma (platform_settings.default_store_id),
-- que é a loja inicial criada pela migração da instalação de loja única (ou a loja demo do seed).
-- Produtos das demais lojas nunca são tocados. Sem loja padrão definida, nada é alterado.
-- (Se a API usa DEFAULT_STORE_SLUG no .env, confira na prévia se a loja mostrada é a mesma.)
--
-- Uso (PostgreSQL):
--   psql -U postgres -d comestra -f backend/scripts/renomear-catalogo-demo.sql
--
-- O script mostra a loja e a prévia, aplica em uma transação e mostra o resultado.
-- Pedidos antigos não são afetados: cada item de pedido guarda o próprio retrato de preço.

\set ON_ERROR_STOP on

\echo '--- Loja padrão (única afetada) ---'
SELECT s.id, s.slug, s.name
FROM platform_settings ps
JOIN stores s ON s.id = ps.default_store_id
WHERE ps.id = 1;

\echo '--- Prévia (antes -> depois) ---'
SELECT id,
       name AS antes,
       CASE
         WHEN name ~* '^X-Torres Bacon$' THEN 'X-Bacon da Casa'
         WHEN name ~* '^X-Torres$'       THEN 'X-Burger da Casa'
         WHEN name ~* '^Torres Salad$'   THEN 'Salad Burger'
         ELSE regexp_replace(name, '^Torres\s+', '', 'i')
       END AS depois
FROM products
WHERE name ~* 'torres'
  AND store_id = (SELECT default_store_id FROM platform_settings WHERE id = 1)
ORDER BY id;

BEGIN;

UPDATE products
SET name = CASE
             WHEN name ~* '^X-Torres Bacon$' THEN 'X-Bacon da Casa'
             WHEN name ~* '^X-Torres$'       THEN 'X-Burger da Casa'
             WHEN name ~* '^Torres Salad$'   THEN 'Salad Burger'
             ELSE regexp_replace(name, '^Torres\s+', '', 'i')
           END,
    updated_at = now()
WHERE name ~* 'torres'
  AND store_id = (SELECT default_store_id FROM platform_settings WHERE id = 1);

UPDATE products
SET description = regexp_replace(description, '\mTorres\M', 'da casa', 'gi'),
    updated_at = now()
WHERE description ~* '\mtorres\M'
  AND store_id = (SELECT default_store_id FROM platform_settings WHERE id = 1);

COMMIT;

\echo '--- Restantes com "torres" na loja padrão (deve ser 0) ---'
SELECT count(*) AS restantes
FROM products
WHERE (name ~* 'torres' OR description ~* 'torres')
  AND store_id = (SELECT default_store_id FROM platform_settings WHERE id = 1);
