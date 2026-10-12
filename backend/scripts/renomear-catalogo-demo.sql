-- Renomeia o cardápio de demonstração herdado do antigo nome "TorresBurgers".
-- Opcional: os nomes de produtos são dados da loja (não do sistema). Rode só se quiser
-- apresentar o Comestra com um cardápio neutro.
--
-- Uso (PostgreSQL):
--   psql -U postgres -d comestra -f backend/scripts/renomear-catalogo-demo.sql
--
-- O script mostra a prévia, aplica em uma transação e mostra o resultado.
-- Pedidos antigos não são afetados: cada item de pedido guarda o próprio retrato de preço.

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
WHERE name ~* 'torres';

UPDATE products
SET description = regexp_replace(description, '\mTorres\M', 'da casa', 'gi'),
    updated_at = now()
WHERE description ~* '\mtorres\M';

COMMIT;

\echo '--- Restantes com "torres" (deve ser 0) ---'
SELECT count(*) AS restantes FROM products WHERE name ~* 'torres' OR description ~* 'torres';
