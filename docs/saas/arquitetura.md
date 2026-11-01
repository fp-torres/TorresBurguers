# Comestra SaaS — Arquitetura multi-tenant

> Documento de referência da transformação da Comestra (antiga instalação de loja única) em uma
> plataforma SaaS multi-tenant. Descreve as decisões, o modelo de dados, o isolamento entre lojas,
> os papéis, os contratos de API e as regras de operação. Escopo desta fase: **backend + frontend web**.
> O app mobile (`frontend-mobile/`) não foi alterado; a compatibilidade com ele está na seção 10.
> Instalação, migração, configuração e operação: [`operacao.md`](operacao.md).

## 1. Visão geral

- A **Comestra** é a dona da plataforma. O **superadministrador** (papel global `SUPER_ADMIN`)
  administra todas as lojas pelo superpainel web (`/platform`).
- Cada **estabelecimento** (`stores`) tem equipe, cardápio, pedidos, pagamentos, configurações de
  entrega, identidade visual e assinatura próprios.
- **Clientes** têm conta global (um e-mail) e compram em qualquer loja. Os pedidos ficam sempre
  associados à loja em que foram feitos.
- A **equipe** (ADMIN, atendente, cozinha, entregador) pertence a exatamente uma loja.
- Pagamentos do **delivery** (consumidor → loja) e cobrança da **assinatura SaaS** (loja → Comestra)
  são fluxos, tabelas, credenciais e webhooks separados.

## 2. Decisões principais

| Tema | Decisão | Motivo |
|---|---|---|
| Tenant | Coluna `store_id` nas tabelas operacionais + resolução do tenant no servidor | Simples, indexável e compatível com o TypeORM/pool de conexões atual |
| Row-Level Security | **Não adotado nesta fase** | O app usa repositórios fora de transação e um pool compartilhado; RLS exigiria `SET LOCAL` por requisição em transação dedicada, bypass para webhooks/rotinas e o usuário do banco hoje é superusuário (ignora RLS). Substituído por: `store_id NOT NULL` + FKs, triggers de consistência, `store_id` imutável, `invalidWhereValuesBehavior: throw` e testes de isolamento |
| Vínculo da equipe | `users.store_id` (uma loja por conta de equipe; a conta nunca muda de loja) | Mantém o contrato `user.role` usado pelo web e pelo app mobile; caminho futuro: tabela de vínculos (equipe em várias lojas) |
| Papel global | `users.platform_role = 'SUPER_ADMIN'`, separado de `role` | Privilégio global explícito, nunca concedido por HTTP (só pelo comando `npm run platform:superadmin`) |
| Superadmin | `role = CLIENT`, `store_id = NULL`, `platform_role = SUPER_ADMIN` (garantido também pelo CHECK `CHK_users_platform_role`) | Respeita o CHECK de vínculo da equipe; papéis da plataforma e da loja separados |
| Loja pública | Slug único (`/loja/:slug` no web; `/stores/:storeSlug/...` na API) | Evolução prevista para subdomínio/domínio próprio (`stores.custom_domain`) |
| Rotas antigas | Continuam valendo: equipe autenticada → própria loja; demais → **loja padrão** | Compatibilidade com o app mobile e integrações da versão de loja única |
| Loja padrão | `DEFAULT_STORE_SLUG` (env) ou `platform_settings.default_store_id` | Persistida pela migration (loja inicial) e pelo seed; sem ela, rotas antigas respondem 404 (falha fechada) |
| Schema | Migrations TypeORM (`src/database/migrations`), rodadas na subida (`DB_MIGRATIONS_RUN`, padrão true). `DB_SYNCHRONIZE` desligado por padrão em todos os ambientes | O repositório não tinha migrations; a baseline reproduz exatamente o schema antigo. O synchronize criaria por fora das migrations o que as entidades declaram |
| Credenciais de pagamento | Mercado Pago por loja (`stores.mp_public_key` + `mp_access_token_encrypted`, AES-256-GCM com `CREDENTIALS_ENCRYPTION_KEY`) | O dinheiro do delivery cai na conta da própria loja. `MP_ACCESS_TOKEN` (env) vale só para a loja padrão (compatibilidade). Formato v2 com vínculo à loja: ver seção 11.7 |
| Cobrança SaaS | Módulo `billing` próprio; provedores `MANUAL` (registro pelo superadmin) e `MERCADO_PAGO` (assinaturas/preapproval) | O provedor recorrente depende de credenciais da conta da Comestra (`MP_SAAS_*`), ainda não configuradas |
| E-mail | `MAIL_DRIVER`: `log` (padrão; nada é enviado) ou `smtp` (nodemailer 10.1.7, tipos próprios, Node ≥ 20). Texto + HTML com a marca da loja ou da plataforma | SMTP atende qualquer provedor sem SDK próprio. Com SMTP, os links que o superpainel gera (redefinição e convites de `/platform/stores/:id/invitations`) vão **só** por e-mail ao dono; sem SMTP, aparecem uma vez para o operador (seção 11.3) |
| Sessões | Cada token emitido numa requisição leva `jti` e tem uma linha em `auth_sessions` (seção 4.4); no máximo 100 sessões ativas por conta | Logout da sessão atual, lista de sessões e encerramento por aparelho sem trocar o formato do token. Tokens antigos sem `jti` só valem na janela de `JWT_LEGACY_ISSUED_BEFORE` (em produção, sem a variável, são recusados) |
| Sessão do site | Token de acesso curto (15 min) só na memória da aba + refresh rotativo em cookie `HttpOnly`, `SameSite=Strict`, pedido pelo cabeçalho `X-Auth-Transport: cookie` (seção 11.10) | Um script injetado não lê o refresh e o token roubado vale pouco tempo. Aditivo: quem não envia o cabeçalho (app mobile, integrações) recebe o contrato de antes |
| Conta e e-mail | Rotas `/account/*`: troca de e-mail confirmada no endereço novo, "Não fui eu" no antigo e verificação do e-mail, em modo `compat` (seção 11.9) | Prova de posse do e-mail sem quebrar as rotas antigas usadas pelo app mobile (`PATCH /users/:id` continua trocando na hora) |
| Número do pedido | `orders.number` (1..N **por loja**), atribuído por gatilho com o contador em `store_order_counters` | Numeração sem buraco nem repetição sob concorrência. Contador em tabela própria, e não em `stores.next_order_number`: com `DB_SYNCHRONIZE=true` num banco de desenvolvimento, uma coluna de `stores` fora da entidade seria apagada (quebrando o gatilho), e a trava da numeração não disputa com as escritas da loja |
| Limite de tentativas | Serviço próprio em memória (`RateLimitService`): `consume()` atômico e `take()` (reserva a vaga antes de conferir senha ou link e a devolve quando dá certo). Contagens que precisam valer entre instâncias e reinícios ficam no banco ("esqueci a senha" e convites por destinatário) | Sem nova dependência; por instância (para várias instâncias, Redis — evolução). Tabela completa na seção 11.8 |
| Banco sob carga | Pool configurável (`DB_POOL_SIZE`), `statement_timeout` da API (`DB_STATEMENT_TIMEOUT_MS`), espera máxima por conexão (`DB_POOL_ACQUIRE_TIMEOUT_MS`) e índices de desempenho criados com `CONCURRENTLY` (seção 11.11) | Uma loja com consultas pesadas não derruba a latência das outras; a migration de índices não trava as tabelas grandes |
| Sessão de suporte | Token próprio, temporário e **somente leitura em toda a API** (interceptor global) | O superadmin enxerga a loja como o ADMIN dela, sem poder alterar nada |
| Cabeçalhos HTTP | Definidos no `setupApp` (`src/config/app-setup.ts`), sem dependência nova | Mesma configuração na API e nos testes; ver seção 11.7 |

## 3. Modelo de dados

### 3.1 Entidades globais (da plataforma)

| Tabela | Conteúdo |
|---|---|
| `stores` | Estabelecimento: slug, nome comercial, razão social, documento, contato, logo, cor, endereço, `account_status` (ACTIVE/SUSPENDED/INACTIVE), operação (aberta, mensagens, entrega/retirada, zonas por bairro e/ou faixa de CEP com taxas e a política para endereços fora das zonas no JSON `delivery_zones`, prazo de retirada, horários, fuso), credenciais MP da loja, domínio próprio (futuro), responsável (`owner_user_id`) |
| `plans` | Planos configuráveis: código, nome, preço, periodicidade, teste grátis, limites (`max_staff_users`, `max_products`, `max_monthly_orders`, `max_storage_mb` em MB binários; nulo = ilimitado), recursos (`features`: `online_payments`, `advanced_reports`, `custom_branding`), disponibilidade e visibilidade |
| `subscriptions` | Assinatura da loja: plano, status (TRIALING, ACTIVE, PAST_DUE, SUSPENDED, CANCELED), `suspended_by` (PLATFORM/BILLING/nulo: quem suspendeu), `cancel_scheduled_by` (PLATFORM/STORE/nulo: quem agendou o cancelamento; `CHK_subscriptions_cancel_scheduled_by`), datas de teste/período/cancelamento/inadimplência/tolerância/suspensão, provedor. Uma única assinatura não cancelada por loja (índice parcial) |
| `store_slug_history` | Endereços (slugs) antigos de cada loja, reservados para sempre contra o autoatendimento: `slug` único (`UQ_store_slug_history_slug`), loja (FK `CASCADE`, `IDX_store_slug_history_store_id`) e data. Guarda o último dono de cada slug |
| `subscription_events` | Histórico da assinatura (criação, mudanças de status e de plano, cobranças, falhas) |
| `subscription_invoices` | Faturas SaaS (receita da Comestra): valor, período, vencimento, status (OPEN/PAID/FAILED/VOID), id do pagamento no provedor (único: idempotência) |
| `billing_webhook_events` | Notificações do provedor de cobrança SaaS, únicas por `(provider, event_key)` |
| `platform_settings` | Linha única: loja padrão, tolerância da inadimplência (padrão 7 dias), duração das sessões de suporte (padrão 30 min), autoatendimento de lojas (padrão desligado) |
| `audit_logs` | Auditoria: operador, escopo, loja afetada, ação, alvo, resultado, IP, navegador, metadados sanitizados |
| `support_sessions` | Acesso assistido do suporte (motivo, início, expiração, fim) |
| `auth_sessions` | Uma linha por token de sessão emitido: `jti` (uuid, único), `user_id` (FK `CASCADE`), `kind` (`USER`/`SUPPORT`), `support_session_id` (FK `CASCADE`), `token_version`, `created_at`, `expires_at`, `revoked_at`, `ip` e `user_agent` (até 255). Sessão do site em cookie (seção 11.10): `transport` (`BEARER` padrão / `COOKIE`), `refresh_selector` (único quando preenchido), `refresh_hash` e `refresh_prev_hash` (SHA-256 do validador atual e do anterior), `refresh_rotated_at`, `refresh_generation` e `parent_session_id` (sessão do superadmin que abriu um suporte; FK `SET NULL`). CHECKs `CHK_auth_sessions_kind`, `CHK_auth_sessions_support` (`SUPPORT` ⇔ `support_session_id`), `CHK_auth_sessions_transport`, `CHK_auth_sessions_refresh` e `CHK_auth_sessions_support_bearer` (suporte é sempre bearer); índices `UQ_auth_sessions_jti`, `(user_id, created_at)`, `support_session_id`, `expires_at`, `UQ_auth_sessions_refresh_selector` e `IDX_auth_sessions_parent` (parciais) |
| `maintenance_jobs` | Execuções da manutenção em segundo plano (`kind`: `optimize_images` ou `cleanup_uploads`): status, contagens, heartbeat. A limpeza grava `summary.trigger` (`manual` ou `schedule`) |
| `users` | Contas. `store_id` (equipe), `platform_role`, `blocked_at/blocked_reason`, `token_version`, `last_login_at`, `email_verified_at` (nulo = e-mail não confirmado; nunca sai nas respostas antigas). CHECKs: `CLIENT ⇔ store_id NULL` e papel global só em CLIENT sem loja |
| `account_email_tokens` | Links de conta enviados por e-mail (seção 11.9): `purpose` (`VERIFY`, `CHANGE`, `REVERT`), `email` e `previous_email`, `token_hash` (SHA-256, único; o código nunca é gravado), `expires_at`, `used_at`, `revoked_at`, `requested_ip`. CHECKs `CHK_account_email_tokens_purpose` e `CHK_account_email_tokens_previous`; um `CHANGE` aberto por conta (`UQ_account_email_tokens_open_change`); `IDX_account_email_tokens_reserved` acha o endereço antigo reservado por um `REVERT` aberto |
| `addresses` | Endereços do cliente (globais, do usuário; no máximo 20 ativos por conta). Localização conferida pelo CEP (seção 11.2): `canonical_neighborhood`, `canonical_city`, `canonical_state`, `neighborhood_source` (`CEP` / `MANUAL` / nulo = não conferido), `cep_status` (`FOUND` / `NO_NEIGHBORHOOD` / `NOT_FOUND` / `UNAVAILABLE`) e `cep_checked_at`; CHECKs `CHK_addresses_neighborhood_source` e `CHK_addresses_cep_status` |
| `invitations` | Convites para a equipe de uma loja (hash do token, perfil, quem convidou, expiração, aceite/revogação) |
| `password_reset_tokens` | Redefinição de senha (hash do token, uso único, expiração) |

### 3.2 Entidades por loja (`store_id NOT NULL`)

`products`, `addons`, `orders`, `payments`. As tabelas de junção (`product_allowed_addons`,
`order_items`, `order_item_addons`) são escopadas pela tabela-pai e protegidas por triggers.

| Tabela / coluna | Conteúdo |
|---|---|
| `orders.number` | Número do pedido **na loja** (1..N, sem buraco), atribuído pelo banco em todo `INSERT` e imutável. O `id` continua global e é a chave das rotas e do app mobile |
| `store_order_counters` | Contador do número do pedido por loja (`store_id` PK + FK `stores ON DELETE CASCADE`, `last_number` ≥ 0). Usado só pelo gatilho; não tem entidade, então o synchronize não mexe nela |
| `store_customer_blocks` | Clientes bloqueados pela loja: PK (`store_id`, `user_id`), `reason` (até 300), `blocked_by_user_id` (quem bloqueou), `blocked_at`. FKs: loja `RESTRICT`, cliente `CASCADE`, quem bloqueou `SET NULL`; índice por `user_id` |

### 3.3 Garantias no banco

- `store_id NOT NULL` + FK `ON DELETE RESTRICT` (lojas nunca são apagadas fisicamente; são desativadas).
- Índices: `products(store_id)`, `addons(store_id)`, `orders(store_id, created_at)`,
  `orders(store_id, status)`, `payments(store_id)`, `users(store_id)`, `order_items("orderId")`,
  `orders(user_id, created_at)`.
- Índices de desempenho (`PerformanceIndexes`, seção 11.11): `IDX_users_email_lower` (`LOWER(email)`: login,
  cadastro, "esqueci a senha"), `IDX_addresses_user_id`, `IDX_payments_store_open` e `IDX_payments_open_created`
  (parciais: pagamentos sem pedido, usados pela conciliação e pela reserva do limite mensal),
  `IDX_audit_logs_created`, `IDX_orders_store_updated_at`, `IDX_orders_store_open` (parcial: quadro de pedidos),
  `IDX_orders_driver_updated_at`, `IDX_order_items_product_id` e, só com a extensão `pg_trgm` disponível,
  `IDX_users_name_trgm` e `IDX_users_email_trgm` (busca de contas do superpainel).
- Idempotência de pagamentos por loja: `UNIQUE (store_id, user_id, idempotency_key)`.
- Índices únicos parciais: um convite em aberto por loja + e-mail; uma fatura válida (não anulada) por
  período da assinatura; uma execução `RUNNING` da manutenção por tipo.
- Triggers (erro `check_violation`): adicional só da loja do produto; item de pedido só com produto
  da loja do pedido; adicional do item só da loja do pedido; entregador só da loja do pedido;
  pagamento só quita pedido da mesma loja (`TRG_orders_payment_same_store`); eventos e faturas com a loja
  da assinatura; responsável (`stores.owner_user_id`) da equipe da própria loja; conta criada no aceite do
  convite da loja do convite. Os triggers de mesma loja só conferem quando a ligação muda (linhas antigas
  nunca travam escritas em outras colunas).
- `store_id` imutável em produtos, adicionais, pedidos, pagamentos, assinaturas, eventos e faturas da
  assinatura, convites, sessões de suporte e bloqueios de clientes (`TRG_store_customer_blocks_store_immutable`).
  `TRG_users_store_no_transfer`: conta da equipe nunca passa de uma loja para outra.
- **Número do pedido**: `UQ_orders_store_number (store_id, number)`. `TRG_orders_assign_number` (`BEFORE INSERT`)
  dá a todo pedido novo, por qualquer caminho (pago na entrega, criado pelo pagamento aprovado, SQL de
  suporte), o próximo número da loja com um upsert atômico em `store_order_counters` (`INSERT ... ON CONFLICT
  DO UPDATE SET last_number = last_number + 1 RETURNING ... INTO NEW.number`); um número enviado no `INSERT` é
  ignorado. A trava fica só na linha do contador da loja até o fim da transação: sem repetição nem buraco
  (um rollback devolve o número), e lojas diferentes não se esperam. `TRG_orders_number_immutable`
  (`BEFORE UPDATE OF number`) recusa qualquer alteração (`check_violation`).
- `auth_sessions`: `CHK_auth_sessions_kind` (`USER`/`SUPPORT`), `CHK_auth_sessions_support` (sessão `SUPPORT` ⇔
  `support_session_id` preenchido), `jti` único e FKs `ON DELETE CASCADE` para `users` e `support_sessions`.
- `CHK_users_store_membership`: cliente sem loja; equipe com loja. `CHK_users_platform_role`: papel global
  só em conta CLIENT sem loja. `CHK_subscriptions_suspended_by`: PLATFORM, BILLING ou nulo.
  `CHK_subscriptions_cancel_scheduled_by`: PLATFORM, STORE ou nulo.
- `auth_sessions` (sessão do site em cookie): `CHK_auth_sessions_transport` (`BEARER`/`COOKIE`),
  `CHK_auth_sessions_refresh` (sessão `COOKIE` ⇔ seletor e hash do refresh preenchidos) e
  `CHK_auth_sessions_support_bearer` (sessão de suporte nunca é `COOKIE`); seletor do refresh único.
- `account_email_tokens`: hash do link único, no máximo um `CHANGE` aberto por conta e `previous_email` só nos
  propósitos que o usam (`CHK_account_email_tokens_previous`).
- `invalidWhereValuesBehavior: { null: 'throw', undefined: 'throw' }` no TypeORM: um filtro
  `{ store_id: undefined }` vira erro em vez de devolver dados de todas as lojas.

### 3.4 Migrations

| Migration | O que faz |
|---|---|
| `1791764966404-BaselineSchema` | Schema exato da versão de loja única. Em banco existente (criado pelo synchronize) não faz nada. Irreversível |
| `1791765597480-MultiTenantFoundation` | Cria as tabelas da plataforma; adiciona `store_id` (opcional), migra os dados existentes para a **loja inicial**, torna `store_id` obrigatório, cria FKs, índices, CHECK e triggers |
| `1791773437187-TenancyIndexes` | Índices de consulta por loja/cliente e os índices únicos parciais de convite pendente (loja + e-mail) e de fatura por período (exceto anuladas). Idempotente (`IF NOT EXISTS`): tolera os índices que o `DB_SYNCHRONIZE=true` já tenha criado num banco de desenvolvimento |
| `1792299658658-MaintenanceJobs` | Tabela `maintenance_jobs` (execuções da manutenção em segundo plano) com o índice único parcial que permite uma execução `RUNNING` por tipo. `down()` apaga a tabela (o histórico continua na auditoria) |
| `1792800000000-PlatformIntegrity` | `subscriptions.suspended_by` (preenchida pelo histórico: último `STATUS_CHANGED` para SUSPENDED com gatilho `platform.suspend` → PLATFORM; as demais → BILLING) + `CHK_subscriptions_suspended_by`; `CHK_users_platform_role` (criado `NOT VALID` e validado em seguida); triggers de mesma loja, `store_id` imutável nas 5 tabelas da plataforma e `TRG_users_store_no_transfer`. Recusa subir se existir conta com papel global que também seja da equipe de uma loja (a mensagem lista as contas). `down()` remove tudo; a origem das suspensões se perde |
| `1792963851057-OrderNumbersAndCustomerBlocks` | `orders.number` com **backfill por loja na ordem de criação** (`ROW_NUMBER() OVER (PARTITION BY store_id ORDER BY created_at, id)`), `NOT NULL` e `UQ_orders_store_number`; `store_order_counters` semeada com o maior número de cada loja; funções e gatilhos `TRG_orders_assign_number` e `TRG_orders_number_immutable`; `store_customer_blocks` com FKs, índice por cliente e `store_id` imutável. Tolera a coluna e o índice já criados pelo `DB_SYNCHRONIZE=true` num banco de desenvolvimento (`IF NOT EXISTS`). Os pedidos existentes passam a ter número por loja (antes as telas mostravam o `id`). `down()` remove tudo: números e bloqueios se perdem (os bloqueios continuam na auditoria). Com bloqueios gravados, o `down()` **recusa** reverter, salvo com `DB_ALLOW_DESTRUCTIVE_REVERT=true` |
| `1792964108700-AuthSessions` | Tabela `auth_sessions` com CHECKs, índices e FKs `CASCADE` para `users` e `support_sessions`. Tokens emitidos antes dela (sem `jti`) só valem na janela de `JWT_LEGACY_ISSUED_BEFORE` (seção 4.4). `down()` incrementa o `token_version` de **todas** as contas (todo mundo entra de novo: a API anterior ignora o `jti` e as sessões revogadas já podem ter sido apagadas) e apaga a tabela |
| `1793476392120-AddressZoneLocation` | Colunas opcionais de localização pelo CEP em `addresses` (`canonical_neighborhood`, `canonical_city`, `canonical_state`, `neighborhood_source`, `cep_status`, `cep_checked_at`) e os CHECKs `CHK_addresses_neighborhood_source` e `CHK_addresses_cep_status`. Sem backfill: os endereços existentes ficam não conferidos e são conferidos no primeiro orçamento de entrega. Tolera colunas e CHECKs já criados pelo `DB_SYNCHRONIZE=true` (`IF NOT EXISTS`). `down()` remove tudo (volta a valer só o bairro digitado) |
| `1793477263977-PlanStorageLimit` | `plans.max_storage_mb` (inteiro, nulo = ilimitado; os planos existentes ficam ilimitados). `down()` remove a coluna |
| `1793485300000-StoreSlugHistoryAndCancelOrigin` | `subscriptions.cancel_scheduled_by` + `CHK_subscriptions_cancel_scheduled_by`, preenchida nos agendamentos em aberto pelo ator do último `CANCEL_SCHEDULED` (conta da plataforma → PLATFORM; senão STORE); tabela `store_slug_history`, preenchida com os slugs antigos registrados na auditoria (`platform.store.update` com sucesso; último dono por slug). Só aditiva. `down()` remove as duas (a origem dos agendamentos e as reservas de slug se perdem; a API anterior não as usa) |
| `1793490000000-PerformanceIndexes` | Índices de desempenho da seção 3.3, com `CREATE INDEX CONCURRENTLY IF NOT EXISTS` e **sem transação** (`transaction = false`): não trava as tabelas grandes e, se falhar no meio, basta rodar de novo (o índice inválido é recriado). Os índices de trigramas só são criados quando `pg_trgm` já está instalada ou pode ser criada por este usuário (superusuário, ou extensão `trusted` com permissão `CREATE`); senão a migration segue sem eles, com aviso no log. `down()` remove os índices, não a extensão |
| `1793491000000-AccountEmailVerification` | `users.email_verified_at` (sem backfill: as contas existentes ficam "não confirmado") e a tabela `account_email_tokens` (seção 3.1). `down()` apaga a tabela e a coluna: perde só as confirmações e os links pendentes |
| `1793492000000-AuthSessionRefresh` | Colunas da sessão em cookie em `auth_sessions` (`transport` com padrão `BEARER`, `refresh_*`, `refresh_generation`, `parent_session_id`), índices parciais, CHECKs e a FK do pai (`ON DELETE SET NULL`), criados `NOT VALID` e validados em seguida: as linhas existentes viram `BEARER` pelo padrão, sem reescrever a tabela. `down()` remove tudo sem afetar contas e pedidos (as sessões em cookie perdem o refresh e as pessoas entram de novo) |
| `1793501000000-DeliveryDistance` | Entrega por distância (seção 11.2): `stores.latitude` e `stores.longitude` (local da loja) e, em `addresses`, `geo_latitude`, `geo_longitude` (`double precision`), `geo_precision`, `geo_source`, `geo_status` (`varchar(12)`) e `geo_checked_at` (`timestamptz`), com `CHK_addresses_geo_precision` (`ADDRESS`, `ZIP_CENTER`, `MANUAL`) e `CHK_addresses_geo_status` (`FOUND`, `NOT_FOUND`, `UNAVAILABLE`). Tudo opcional, `IF NOT EXISTS`, sem backfill: os endereços existentes são localizados no primeiro orçamento de uma loja que cobra por distância. `down()` remove as colunas e os CHECKs (o JSON de entrega das lojas não é alterado) |

Pedido mínimo e frete grátis (seção 11.2) **não têm migration**: ficam no JSON `stores.delivery_zones`, que já existia.

Migração dos dados existentes (somente se o banco já tinha dados):

1. Cria a loja inicial (`INITIAL_STORE_NAME`/`INITIAL_STORE_SLUG`; padrão "Loja principal"/`loja-principal`),
   com status e mensagens de `store_config` e endereço/telefone/horários que a vitrine antiga exibia fixos.
2. Associa a ela todos os produtos, adicionais, pedidos e pagamentos, e a equipe (inclusive na lixeira).
   Clientes continuam globais. O administrador ativo mais antigo vira o responsável.
3. Cria o plano interno `legado` (sem cobrança, sem limites, indisponível para novas contratações) e uma
   assinatura ACTIVE para a loja inicial.
4. Grava o retrato do endereço nos pedidos de entrega antigos que ainda não tinham.
5. Define a loja inicial como loja padrão e registra tudo na auditoria (`platform.migration.initial_store`).

`store_config` não é alterada nem apagada. `down()` da `MultiTenantFoundation` recusa reverter com mais de
uma loja e devolve status e mensagens para `store_config`. Ele também recusa se a reversão for apagar
auditoria, cobrança SaaS, sessões de suporte, convites ou redefinições, ou desfazer bloqueios ou revogações de
sessão, salvo com `DB_ALLOW_DESTRUCTIVE_REVERT=true` (só com backup); a `OrderNumbersAndCustomerBlocks` usa a
mesma variável para os bloqueios de clientes. O `up()` das migrations já publicadas nunca é editado: mudanças
novas entram em migrations novas (o `down()` pode ganhar travas de segurança, como as da `AuthSessions` e da
`OrderNumbersAndCustomerBlocks`). Cada migration roda na própria transação (`migrationsTransactionMode: 'each'`),
exceto a `PerformanceIndexes`.

## 4. Isolamento e autorização

### 4.1 Resolução do tenant (`src/tenancy`)

| Contexto | De onde vem a loja | Guard / decorator |
|---|---|---|
| Painel da equipe | `users.store_id` do usuário autenticado (recarregado do banco a cada requisição pela `JwtStrategy`) | `@StaffRoute(...perfis)` / `@StaffOnly(...)` → `@CurrentTenant()` |
| Vitrine e compra | `:storeSlug` da rota; sem slug: loja da equipe autenticada ou loja padrão | `@PublicStoreRoute({ sellable, auth })` → `@PublicStore()` |
| Superpainel | Nenhuma loja implícita; a loja-alvo vem do id na rota `/platform/...` | `@PlatformRoute()` |

Regras:

- **Nunca** aceitar `storeId`/`tenantId`/slug de cabeçalho, corpo ou query para conceder acesso.
  Os DTOs não têm `store_id` (o `ValidationPipe` com `forbidNonWhitelisted` recusa campos extras).
- Rota da equipe com `:storeSlug` de outra loja → 403.
- Recurso de outra loja (ou inexistente) → **404 uniforme** (nunca 403 que confirme a existência).
- Todo serviço recebe o `storeId` validado como parâmetro explícito e o usa em todas as consultas,
  inclusive `update/delete/softDelete/restore` (critério composto `{ id, store_id }`).
- Entidades devolvidas pela API nunca carregam a relação `store` completa (só `{ id, slug, name, logo }`).
- Nas rotas antigas sem slug (`GET /products`, `/products/:id`, `/addons`, `/store/status`), a equipe de uma
  loja desativada recebe 403 `Esta loja foi desativada na plataforma. Fale com o suporte.`, como no painel.

### 4.2 Situação da loja × capacidades

`storeAccessState(store, subscription)` (`src/tenancy/store-access.ts`) combina `account_status` e a
assinatura:

| Situação | Vende | Lê | Opera pedidos | Altera (cardápio, equipe, config.) | Cobrança | Vitrine |
|---|---|---|---|---|---|---|
| OPERATIONAL (TRIALING/ACTIVE) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| PAST_DUE (na tolerância) | ✔ (com aviso) | ✔ | ✔ | ✔ | ✔ | ✔ |
| SUSPENDED (loja) / SUBSCRIPTION_SUSPENDED / SUBSCRIPTION_CANCELED / NO_SUBSCRIPTION | ✘ | ✔ | ✔ (concluir/cancelar/estornar) | ✘ | ✔ | ✔ (indisponível) |
| INACTIVE (desativada) | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ (404) |

Capacidade padrão das rotas da equipe: leitura em GET, `manage` nas demais; rotas de pedidos usam
`@RequireStoreCapability('operate')`; rotas de assinatura usam `'billing'`.

Mensagens:

- **Cliente** que tenta comprar numa loja que não vende recebe sempre 403
  `Esta loja está temporariamente indisponível para novos pedidos.` (o mesmo `unavailable_message` do perfil
  público), em pedido, orçamento, PIX e cartão. O motivo interno nunca aparece para o cliente.
- **Equipe**: `access.message` traz o motivo. Assinatura suspensa pela plataforma (`suspended_by = PLATFORM`)
  → `A assinatura da loja está suspensa. Fale com o suporte da plataforma para regularizar e voltar a vender.`;
  suspensa pela rotina de inadimplência (`BILLING`) → `A assinatura está suspensa por falta de pagamento.
  Regularize a cobrança para voltar a vender.` Sem a causa gravada, "falta de pagamento" só aparece quando a
  tolerância de uma cobrança vencida acabou.
- Loja apenas **fechada** (`is_open = false`) não é bloqueio: o orçamento devolve `store_open: false` e o
  pedido novo é recusado, mas um pagamento online já aprovado continua virando pedido (seção 7).

### 4.3 Papéis

| Papel | Onde | Pode |
|---|---|---|
| `SUPER_ADMIN` (global) | `users.platform_role` | Superpainel inteiro. Não opera lojas nem faz pedidos; pode abrir **sessão de suporte** (somente leitura em toda a API, temporária, auditada) |
| `ADMIN` (loja) | `users.role` + `store_id` | Tudo da própria loja. O responsável (`stores.owner_user_id`) é protegido contra os outros ADMIN (seção 5.2) |
| `EMPLOYEE` | idem | Todos os pedidos da loja, status da loja, clientes (leitura) |
| `KITCHEN` | idem | Só pedidos em `PENDING` e `PREPARING` (preparo), sem contato, endereço, troco nem `payment_id` do cliente |
| `COURIER` | idem | Entregas prontas sem entregador, as próprias em andamento e as próprias concluídas ou canceladas nas últimas 24 h (nome, telefone, endereço e troco do cliente; nunca o e-mail) |
| `CLIENT` | global | Compras em qualquer loja, endereços, perfil |

### 4.4 Sessões e conta

- JWT com claim `tv` (versão das sessões, `users.token_version`). Incrementada ao redefinir/trocar a
  senha, confirmar ou desfazer uma troca de e-mail, bloquear a conta, "encerrar sessões", revogar acessos e
  promover uma conta a superadmin pelo comando. Tokens antigos sem `tv` valem como 0.
- **Sessões registradas** (`auth_sessions`): todo token de sessão assinado dentro de uma requisição HTTP
  (login, cadastro de loja, aceite de convite, troca da própria senha/e-mail por `PATCH /users/:id`,
  `POST /account/password` e sessão de suporte) leva a claim
  `jti` (UUID v4). O `JwtService` exportado pelo `SessionModule` é o `SessionJwtService`, que anota o token no
  escopo da requisição (`AsyncLocalStorage`); o `SessionIssuanceInterceptor` (global, no `AuthModule`) grava as
  sessões numa única `INSERT` **antes** de a resposta sair. Se a rota falhar, nada é gravado; se a gravação
  falhar, a resposta vira 500 e o token não sai. Fora de uma requisição (comandos, testes unitários) o token
  sai como antes, sem `jti`.
- **Validação** (`JwtStrategy`): token com `jti` só vale com a sessão existente, da própria conta, não revogada,
  no prazo e do tipo coerente (`USER` sem `sid`; `SUPPORT` com o mesmo `sid`). Senão 401 `Sessão inválida ou
  expirada. Faça login novamente.` ou, nos tokens de suporte, `A sessão de suporte terminou ou expirou. Inicie
  outra pelo superpainel.` É uma consulta pelo índice único do `jti` que já traz a sessão de suporte (o token de
  suporte continua com 2 consultas no total; os demais ganham +1 consulta indexada por requisição). `jti` fora
  do formato UUID é recusado sem consultar o banco. Token **sem** `jti` (emitido antes das sessões registradas)
  só vale na janela de transição: emitido (`iat`) **antes** de `JWT_LEGACY_ISSUED_BEFORE` e com validade de no
  máximo `JWT_EXPIRES_IN` (deixa de valer no corte + `JWT_EXPIRES_IN`). Sem a variável, em produção nenhum é aceito
  (401 e um aviso no log: quem entrou antes da atualização entra de novo); em development/test todos continuam
  aceitos até expirar. `none`/`off`/`false`/`0` ou um valor inválido recusam todos (o inválido com aviso).
- **Teto de sessões**: no máximo 100 sessões `USER` ativas por conta. Cada login novo remove as mais antigas além
  disso (o token delas passa a receber 401, como uma sessão revogada).
- **Sessão do site em cookie** (seção 11.10): com o cabeçalho `X-Auth-Transport: cookie`, as emissões acima
  devolvem um token de acesso de 15 min (`JWT_ACCESS_EXPIRES_IN`, `jti` = id da sessão) e gravam um refresh
  rotativo em cookie `HttpOnly`; a "família" é a própria linha de `auth_sessions` (`transport = COOKIE`). Sem o
  cabeçalho (app mobile, integrações, sessão de suporte), nada muda.
- **Logout e sessões ativas** (seção 5.1): `POST /auth/logout` revoga a sessão do token; `POST /auth/logout-all`
  revoga todas as sessões registradas e incrementa o `token_version`; `GET /auth/sessions` e
  `DELETE /auth/sessions/:id` listam e encerram as sessões da própria conta. Com o token de suporte,
  `POST /auth/logout` também encerra a sessão de suporte, sem precisar do token do superpainel.
- **Limpeza**: a cada sessão nova, as sessões mortas daquela conta (vencidas, revogadas, de `token_version`
  antigo ou de suporte encerrado) são apagadas; além disso, no máximo uma vez por hora por instância, um lote de
  até 5000 sessões vencidas é apagado em segundo plano.
- O `SessionJwtService` é exclusivo de tokens de sessão: qualquer token assinado com `JWT_SECRET` é aceito como
  sessão pela `JwtStrategy`. Links (convite, redefinição, futuras verificações de e-mail) usam `link-token.ts`
  (valor aleatório + SHA-256 no banco).
- Conta bloqueada (`blocked_at`): login recusado (mensagem só depois da senha correta) e tokens inválidos.
- Equipe de loja desativada não entra no painel nem lê pelas rotas antigas (403). Desativar a loja
  incrementa o `token_version` de toda a equipe dela na mesma transação: nenhum token antigo continua válido.
- Recuperação de senha por link de uso único (hash SHA-256 no banco, expiração curta). Com `MAIL_DRIVER=smtp`
  o link vai por e-mail; com o driver de log (padrão), vai para o log da API em dev/test e, em produção, o
  superadmin gera o link no superpainel (com SMTP, esse link também vai **só** para o dono da conta; seção
  11.6). "Esqueci a senha" envia no máximo 3 links por conta em 24 h (contados no banco; o excedente é
  silencioso). Um link pendente deixa de valer (404, como um link inválido) quando a conta troca o próprio e-mail
  ou senha, quando o ADMIN troca os de um membro, ao bloquear, ao mandar para a lixeira (restaurar não traz o
  link de volta), em "encerrar sessões", em "Sair de todos os aparelhos" e quando a loja da equipe é desativada.
  O link pedido por "esqueci a senha" marca o e-mail como confirmado (`email_verified_at`) e cancela uma troca
  de e-mail em aberto; os links gerados pelo superpainel não confirmam o e-mail.
- **Segredo dos tokens em desenvolvimento**: com `NODE_ENV=development` e sem `JWT_SECRET`, a API gera um segredo
  aleatório por instalação em `backend/.temp/dev-jwt-secret` (fora do Git; caminho em `JWT_DEV_SECRET_FILE`) em vez
  de derivá-lo do nome da marca, que permitia forjar o token do superadmin de uma API de dev exposta. Apagar o
  arquivo encerra as sessões de desenvolvimento. `NODE_ENV=test` mantém um segredo fixo (instâncias descartáveis
  dos testes; risco aceito). Produção continua exigindo `JWT_SECRET` com 32+ caracteres.
- **Sessão de suporte somente leitura em toda a API** (`SupportSessionReadOnlyInterceptor`, registrado no
  `AuthModule`, roda depois dos guards): qualquer `POST`, `PUT`, `PATCH` ou `DELETE` com o token de suporte →
  403 `Sessão de suporte é somente leitura: nenhuma alteração pode ser feita.`, inclusive fora do painel
  (endereços, `POST /auth/logout-all`, `DELETE /auth/sessions/:id`, `PATCH /orders/:id/cancel`). Única exceção:
  `POST /auth/logout` (`@AllowedInSupportSession()`), que encerra a própria sessão. As rotas do painel continuam com
  `...nenhuma alteração pode ser feita na loja.` (`StoreStaffGuard`); o superpainel e as compras respondem com
  as próprias mensagens.
- **Limite de tentativas**: falhas de login por IP+e-mail e por IP, "esqueci a senha", resgate de links,
  cadastro público, autoatendimento de lojas, pedidos, cobranças, webhook do delivery, uploads, endereços,
  equipe, troca de credenciais e e-mail de teste do superpainel (`RATE_LIMIT_*`, seções 9 e 11.8). O login e o resgate de links (redefinição e
  convite) reservam a vaga **antes** de conferir a senha ou o link (uma rajada simultânea não passa do limite
  na instância) e devolvem a vaga quando dá certo. O limite continua por instância. O login também tem teto
  **por conta** somando os IPs (`LOGIN_FAILURES_ACCOUNT`, 50 falhas por hora: acima dele, só a senha **certa** vinda
  de um IP com sessão ativa da conta entra; a senha errada recebe o mesmo 429 de qualquer origem) e de logins
  certos por IP + e-mail (`LOGIN_SUCCESS`, 200 em 10 min). Todo 429 do login anterior à conferência da senha
  espera o tempo típico de uma conferência (`LoginTiming`: média móvel do `validateUser`, só um timer, sem CPU),
  para o tempo de resposta não revelar o motivo. As chaves por IP agrupam o IPv6 por /64 e tratam
  `::ffff:a.b.c.d` como IPv4 (`clientIpKey`); a auditoria e `auth_sessions` continuam com o IP completo.

### 4.5 Auditoria

`AuditService.record()` grava ator, escopo (PLATFORM/STORE/SYSTEM/ANONYMOUS), loja afetada, ação,
alvo, resultado, IP, navegador e metadados **sem** senhas, tokens ou segredos (`sanitizeForAudit`).
Ações auditadas: todas as do superpainel, eventos de autenticação (`auth.*`), gestão de equipe,
configurações e credenciais da loja, mudanças de assinatura, sessões de suporte, convites (inclusive
revogações automáticas), pagamentos do delivery que não viram pedido (`payment.order_not_created`,
`payment.refund`, `payment.cancel`) e os 409 de e-mail em uso na equipe e na conta (resultado FAILURE,
`metadata.reason = email_in_use`). Valores vindos do usuário ou do banco saem escapados nos logs (sem CR/LF
nem caracteres de controle).

**Leituras de dados pessoais no superpainel** também são auditadas: `platform.users.list` (filtros, inclusive o
termo buscado, `page`, `page_size`, `returned`, `total`), `platform.users.view` (conta-alvo e a loja dela) e
`platform.store.team.view` (loja, busca, `include_deleted`, quantidade). Os dados lidos não entram no registro.
Ainda não auditadas: `GET /platform/auth-events`, `GET /platform/audit` (a própria trilha) e a lista de lojas;
sem limite por operador nem alerta de volume (seção 12).

Ações desta etapa:

| Ação | Quando / metadados |
|---|---|
| `auth.logout` | `POST /auth/logout` (alvo `auth_session`; `metadata.legacy_token = true` para token sem `jti`) |
| `auth.session.revoke` | `DELETE /auth/sessions/:id` (`metadata { kind, current }`) |
| `platform.support_session.end` | Ganhou `metadata.via = 'logout' \| 'session_revoke'` quando o encerramento vem do próprio token de suporte ou da lista de sessões, e não do superpainel |
| `store.customer.block` / `store.customer.unblock` | Escopo STORE, loja afetada, alvo `user/<id>`; `metadata { reason }` / `{ reason, blocked_at, blocked_by_user_id }` |
| `platform.settings.test_email` | E-mail de teste do superpainel (alvo `platform_settings#1`): SUCCESS com o driver de log ou quando o SMTP aceita; FAILURE quando o SMTP falha ou está incompleto; `metadata { to, driver, delivered, error? }`. Entra no grupo `platform.settings` |
| `platform.maintenance.cleanup_uploads` / `.finish` | Início (SUCCESS `{ job_id, mode }` ou FAILURE `{ reason, running_job_id, mode }`) e fim (resumo só com números + `duration_ms` + `job_id`; escopo SYSTEM quando a execução expira) da limpeza de `/uploads` |
| `platform.maintenance.reencrypt_credentials` | Regravação das credenciais Mercado Pago (escopo PLATFORM, sem alvo): só contagens `{ total, migrated, already_current, changed, failed }`; FAILURE com `reason` |

Ações e metadados novos (onda 2 da etapa 8 e levas 9a/9b):

| Ação | Quando / metadados |
|---|---|
| `platform.maintenance.cleanup_uploads` / `.finish` (agendada) | Execução automática da limpeza (`UPLOADS_CLEANUP_INTERVAL_HOURS`): escopo SYSTEM, ator nulo, `metadata { job_id, mode: 'delete', trigger: 'schedule' }`. O início manual passa a levar `trigger: 'manual'`. Uma execução agendada que encontra a trava ocupada não grava nada |
| `auth.email_change.request` \| `.cancel` \| `.confirm` \| `.revert`, `auth.email_verification.request` \| `.confirm` | Troca e verificação de e-mail (seção 11.9). `confirm` com `{ from, to }`, `revert` com `{ restored, replaced }`. `request` grava FAILURE com `reason` `email_in_use` ou `email_reserved` mesmo com HTTP 202. Aparecem em `GET /platform/auth-events` (são `auth.*`) |
| `auth.password_reset.request` | Ganhou DENIED com `reason: 'recipient_limit'` (mais de 3 links em 24 h para a conta). `auth.password_reset.complete` ganhou `email_verified` |
| `account.credentials.change` | Ganhou `metadata.revert_link` (rota antiga `PATCH /users/:id`) e `via: 'account_password'` (`POST /account/password`); FAILURE com `reason: 'owner_invitation_pending'` (seção 11.3) |
| `auth.refresh.reuse` | Refresh já trocado apresentado de novo (fora da tolerância): DENIED, alvo `auth_session`, `metadata { generation }`; a família inteira é encerrada. Eventos isolados são esperados (resposta perdida); rajadas indicam roubo |
| `auth.logout` (`via: 'cookie'`), `auth.session.revoke` (`reason: 'replaced'`) | Saída pelo `POST /auth/web/logout`; sessão do cookie anterior substituída por um login novo no mesmo navegador. Refresh bem-sucedido não é auditado |
| `invitation.create` / `invitation.revoke` | Superpainel: `invitation.create` ganhou `delivered`; envio por SMTP que falha → `invitation.revoke` FAILURE com `reason: 'mail_not_delivered'`. Loja: limites diários → `invitation.create` FAILURE com `reason` `recipient_daily_limit` ou `store_daily_limit`; convite criado sem e-mail pelo teto somando as lojas → `metadata.mail_skipped: 'recipient_mail_limit'`. Toda substituição de convite pendente → `invitation.revoke` com `{ reason: 'superseded', replaced_by }` |
| `store.staff.create` / `store.staff.update` | FAILURE com `reason: 'owner_invitation_pending'` quando o e-mail tem convite de troca do responsável pendente na mesma loja |
| `payment.reversed` | Pagamento online aprovado que foi estornado, contestado ou cancelado direto no Mercado Pago: o pedido fica com `payment_status = REFUNDED` (seção 7) |
| `subscription.lifecycle.provider_canceled`, `subscription.provider_sync` (`action: 'cancel_orphan'`) | Cancelamento da preapproval no Mercado Pago feito pela rotina (nova tentativa) e cancelamento de uma preapproval órfã (seção 11.4) |
| `platform.users.list`, `platform.users.view`, `platform.store.team.view` | Leituras de dados pessoais no superpainel (acima) |

## 5. Contratos de API

Formato de listas paginadas (rotas novas): `{ items: T[], total: number, page: number, pageSize: number }`
com `?page=1&pageSize=20` (máx. 100). Erros seguem o padrão do Nest (`{ statusCode, message, error }`).
Uma lista enviada onde o DTO espera um objeto responde 400 (não 500).

Rotas antigas com lista simples (array) mantêm o formato, mas não devolvem mais tudo:
`GET /orders` sem `scope` e `GET /orders/my-orders` (inclusive `/stores/:storeSlug/orders/my-orders`) aceitam
`?page` (1..10000) e `?pageSize` (1..100); padrão: os 100 mais recentes. Parâmetro inválido → 400
`Paginação inválida: use page de 1 a 10000 e pageSize de 1 a 100.` `scope=active` e as listas da cozinha e do
entregador trazem no máximo 500 pedidos, mais novos primeiro. `GET /addresses` devolve no máximo 100.

`GET /health` (público, sem token) responde só `{ "status": "ok" }`: nome e versão do sistema não saem mais
(a versão continua no Swagger). Web e app mobile não usam a rota.

Transporte (todas as rotas): respostas acima de 1 KB saem comprimidas (gzip, deflate ou br) quando o cliente manda
`Accept-Encoding`; o ETag e o 304 continuam iguais. Corpo JSON acima de 100 KB → 413 (o mesmo teto que o Express já
aplicava, agora explícito); em `PATCH /store/settings` o teto é 2 MB (zonas de entrega no limite da validação).
Corpos comprimidos (`Content-Encoding`) continuam aceitos. Os arquivos de `/uploads` saem com cache de 30 dias e
`immutable` (trocar uma imagem gera um nome novo).

### 5.1 Autenticação e conta

| Método e rota | Acesso | Descrição |
|---|---|---|
| `POST /auth/login` | público (limitado) | `{ access_token, user: SessionUser }`. Novas causas de 429 (mesma mensagem e formato): mais de 200 logins certos em 10 min do mesmo IP + e-mail e o teto de falhas por conta (seção 4.4). Com `X-Auth-Transport: cookie`: o mesmo corpo + `session_transport` e `expires_in` (seção 11.10) |
| `POST /auth/web/refresh` | público, só com o cookie (limitado: `REFRESH` por IP) | Sem Bearer e sem corpo. Exige `X-Auth-Transport: cookie`, `Origin` da lista de credenciais (quando vem) e `Sec-Fetch-Site` diferente de `cross-site` (quando vem): senão 403 `Origem não autorizada para a sessão deste navegador.` 200 `{ access_token, expires_in, user: SessionUser, session_transport: 'cookie' }` + `Set-Cookie` rotacionado + `Cache-Control: no-store`; com o refresh anterior dentro de `AUTH_REFRESH_GRACE_SECONDS`, 200 sem `Set-Cookie`. 401 `Sessão inválida ou expirada. Faça login novamente.` apagando o cookie (sem cookie, formato inválido, seletor desconhecido, sessão revogada ou vencida, `token_version` antigo, conta bloqueada ou excluída, equipe de loja desativada, reuso). 409 `Há uma sessão de suporte aberta a partir desta sessão. Encerre-a para voltar ao superpainel.` (cookie mantido). O `access_token` leva o mesmo `jti` |
| `POST /auth/web/logout` | público, só com o cookie (mesmas exigências; sem limite) | Sempre 204 apagando o cookie. Validador atual ou anterior: encerra a família (`auth.logout`, `via: 'cookie'`); validador desconhecido: encerra e registra `auth.refresh.reuse`. Não encerra uma sessão de suporte |
| `GET /account/security` | autenticado (vale na sessão de suporte) | `{ email, email_verified, email_verified_at, email_change: { email, requested_at, expires_at } \| null, account_security_mode: 'compat' }`. `SessionUser`, `/auth/me` e o login não mudam |
| `POST /account/password` | autenticado (403 na sessão de suporte) | `{ current_password, password }` → 200 `{ access_token, user }` (mesmo formato do login; com o cabeçalho de cookie, também a sessão em cookie). 400 `A senha atual não confere.` (conta no `CREDENTIALS_CHANGE` por conta e por IP), 400 `A nova senha deve ser diferente da atual.`, 400 de validação ou campo extra, 429. Efeitos: `token_version + 1`, links de redefinição expirados, troca de e-mail em aberto cancelada, aviso "senha alterada" ao dono |
| `POST /account/email-change`, `DELETE /account/email-change` | autenticado (403 na sessão de suporte) | `{ email, current_password }` → 202 `{ message, email_change }`, **idêntico** para endereço livre, em uso ou reservado; 400 senha atual errada; 400 `Este já é o e-mail da sua conta.`; 429 `ACCOUNT_EMAIL`. `DELETE` → 204 (idempotente) |
| `GET /account/email-change/:token`, `POST /account/email-change/confirm` | público (`TOKEN_REDEEM` por IP; código malformado → 404 sem consulta) | `GET` → `{ current_email_masked, new_email_masked, expires_at }` ou 404. `POST { token }` → 200 `{ message: 'E-mail alterado. Entre com o novo e-mail.', email }`, 404 ou 409 `Este e-mail passou a ser usado por outra conta...`. Confirmar encerra todas as sessões e cria o "Não fui eu" de 7 dias para o endereço antigo |
| `GET /account/email-revert/:token`, `POST /account/email-revert` | público (idem) | `GET` → `{ restored_email_masked, replaced_email_masked, expires_at }` ou 404. `POST { token, password }` → 200 `{ message, email_masked }`: devolve o e-mail antigo (também depois de uma cadeia A→B→C), já confirmado, com a senha nova, encerra as sessões e cancela os outros links da conta; não desbloqueia conta bloqueada; 409 só se o e-mail antigo estiver em outra conta |
| `POST /account/email-verification` | autenticado (403 na sessão de suporte) | 202 `{ message }` ou 200 `{ message: 'Seu e-mail já está confirmado.', email_verified: true }`; 429 `ACCOUNT_EMAIL` |
| `GET /account/email-verification/:token`, `POST /account/email-verification/confirm` | público (idem) | `GET` → `{ email_masked, expires_at }` ou 404. `POST { token }` → 200 `{ message: 'E-mail confirmado.', email_masked }` ou 404 (também quando o e-mail da conta mudou depois do envio). Validades: verificação 48 h; troca 24 h; desfazer 7 dias |
| `GET /auth/me` | autenticado | `SessionUser` (+ `support_session`) |
| `POST /auth/logout` | autenticado (vale com o token de suporte) | 204 sem corpo: revoga a sessão do token. Com o token de suporte, também encerra a sessão de suporte (auditado, sem o token do superpainel). Sem token ou com token inválido → 401 |
| `POST /auth/logout-all` | autenticado (não em sessão de suporte) | 204: marca `revoked_at` em todas as sessões registradas e incrementa `token_version` (contrato inalterado) |
| `GET /auth/sessions` | autenticado | `?page=1&pageSize=20` (máx. 100; `page` < 1 → 400) → `{ items: [{ id, kind: 'USER'\|'SUPPORT', current, created_at, expires_at, ip, browser, support_session_id }], total, page, pageSize }`. Só sessões ativas (não revogadas, no prazo, da versão atual da conta e, nas de suporte, com o suporte aberto); a atual primeiro, depois as mais recentes. `browser` é um resumo (`Chrome no Windows`, `Aplicativo no Android`...), sem `jti` nem o User-Agent completo |
| `DELETE /auth/sessions/:id` | autenticado (não em sessão de suporte) | 204 para sessão da própria conta (idempotente se já encerrada); sessão de outra conta ou inexistente → 404 `Sessão não encontrada.`; id inválido → 400. Encerrar uma sessão `SUPPORT` também encerra o suporte (`via = 'session_revoke'`). Com o token de suporte → 403 (somente leitura) |
| `POST /auth/forgot-password` | público (limitado) | `{ email }` → 202 com mensagem genérica (no máximo 3 links por conta em 24 h, em silêncio) |
| `GET /auth/reset-password/:token` | público | Valida o link: `{ email_masked, expires_at }` ou 404 (também para um link emitido antes de uma troca de e-mail ou senha, bloqueio, lixeira, "encerrar sessões", "sair de todos os aparelhos" ou desativação da loja da equipe) |
| `POST /auth/reset-password` | público (limitado) | `{ token, password }` → redefine e encerra sessões. Com um link pedido por e-mail, marca o e-mail como confirmado e cancela a troca de e-mail em aberto |
| `GET /invitations/:token` | público | `{ store: { name, slug, logo }, email_masked, role, expires_at }` ou 404 |
| `POST /invitations/:token/accept` | público (limitado) | `{ name, password, phone? }` → cria a conta da equipe e faz login |

`SessionUser = { id, name, email, phone, avatar, role, store_id, platform_role, store: { id, slug, name, logo, primary_color, account_status } | null }`.
Respostas de usuário são montadas por **lista de campos permitidos** (nunca `password_hash`,
`token_version`, `blocked_reason` interno etc.).

Todo token emitido numa requisição tem a claim `jti` (UUID v4); as demais claims não mudaram. Tokens sem `jti`
só são aceitos na janela de `JWT_LEGACY_ISSUED_BEFORE` (seção 4.4); fora dela → 401 `Sessão inválida ou
expirada. Faça login novamente.` Token de uma sessão encerrada ou vencida (inclusive a mais antiga removida pelo
teto de 100 sessões) → a mesma 401 (token de suporte: `A sessão de suporte terminou ou expirou. Inicie outra pelo
superpainel.`). `req.user` (`AuthUser`) ganhou o campo opcional `authSessionId`.

**Sessão do site em cookie** (aditivo; detalhes na seção 11.10). O cabeçalho `X-Auth-Transport: cookie` só é
enviado pelo site (o app mobile nunca envia). Emissões de sessão `USER` que o atendem: `POST /auth/login`,
`POST /invitations/:token/accept`, `POST /stores/signup`, `PATCH /users/:id` da própria conta (quando devolve token
novo) e `POST /account/password`. Sem o cabeçalho, idênticas a antes. Com o cabeçalho, `Origin` da lista (quando
vem) e `Sec-Fetch-Site` diferente de `cross-site` (quando vem): o mesmo corpo + `session_transport: 'cookie'` +
`expires_in` (900), `access_token` de 15 min (`jti` = id da sessão), `Set-Cookie` do refresh, e a sessão do cookie
anterior deste navegador é encerrada (`auth.session.revoke`, `reason: 'replaced'`). Com o cabeçalho mas
`cross-site`, de origem fora da lista ou com `AUTH_WEB_COOKIE=false`: o corpo de hoje + `session_transport: 'bearer'`,
sem cookie. A emissão nunca recebe 4xx por causa do transporte. `POST /auth/logout` e `POST /auth/logout-all`
mantêm o contrato e, com o cabeçalho e origem válida, também apagam o cookie (exceto no logout de uma sessão de
suporte). `DELETE /auth/sessions/:id` de uma sessão em cookie derruba o refresh; em `GET /auth/sessions` a família
aparece uma vez (`current` pelo `jti`).

### 5.2 Equipe da loja (rotas existentes, agora por loja)

| Rota | Regra |
|---|---|
| `POST /users` | Anônimo: cadastro de cliente (global; o cadastro envia em segundo plano o link de confirmação do e-mail). ADMIN: cria **equipe da própria loja** (perfis de equipe; `max_staff_users` conferido sob trava por loja dentro da transação: limite rígido, mesmo 403 de antes). Limites conferidos num guard **antes** de ler o corpo: `SIGNUP` por IP (anônimo ou cliente; conta toda tentativa, inclusive corpo inválido) e `TEAM_WRITE` por loja (ADMIN) |
| `GET /users`, `GET /users/trash` | ADMIN: só a equipe da própria loja |
| `GET/PATCH/DELETE /users/:id` | Próprio usuário; ou ADMIN para equipe da própria loja (404 fora dela). ADMIN não altera clientes nem contas da plataforma |
| `PATCH /users/:id/restore`, `DELETE /users/:id/permanent` | ADMIN, equipe da própria loja (exclusão definitiva só de quem está na lixeira). Restaurar um membro confere `max_staff_users` sob a mesma trava do `POST /users` |

Regra do último administrador: **por loja**. Clientes da loja ficam em `/store/customers` (leitura).

- **Própria conta** (`PATCH /users/:id`): campo opcional `current_password`. Quando enviado, é conferido
  (errada → 400 `A senha atual não confere.`). É obrigatório para contas da plataforma ao trocar e-mail ou
  senha (400 `Informe a senha atual para trocar o e-mail ou a senha.`). Para as demais contas continua
  opcional enquanto o app mobile não o envia. Falhas (senha atual errada ou e-mail em uso) contam no
  `CREDENTIALS_CHANGE` por conta e por IP (429). A página Meus Dados do web pede a senha atual para contas da
  plataforma.
- **Responsável pela loja** (`stores.owner_user_id`): outro ADMIN não troca o e-mail (troca real, depois de
  normalizado), a senha nem o perfil dele (403 `O e-mail, a senha e o perfil do responsável pela loja só podem
  ser alterados por ele mesmo ou pela plataforma.`) e não o manda para a lixeira nem o exclui de vez (403
  `O responsável pela loja não pode ser excluído pela equipe...`). Nome, telefone e o reenvio do mesmo e-mail
  (como faz o app mobile) continuam aceitos. A troca do responsável é feita pelo superpainel.
- **Avatar**: em texto, só um dos ícones prontos (`backend/src/users/avatar.ts`, a mesma lista de
  `FUN_AVATARS` do web) ou o valor atual. Outros valores → 400 `Foto inválida: envie a imagem no campo "file"
  ou escolha um dos ícones disponíveis.` A foto enviada para uma conta existente é gravada como
  `/uploads/u<id>-compressed-*.webp`; ao trocá-la, o arquivo anterior da **própria** conta (prefixo `u<id>-`)
  é apagado. No cadastro, a foto continua `compressed-*.webp`.
- O ADMIN ainda pode definir diretamente a senha e o e-mail de outros membros (exceto o responsável): o app
  mobile usa esse fluxo (pendência na seção 12). Desde a verificação de e-mail, o membro recebe um aviso
  informativo (sem "desfazer") e, na troca de e-mail, o link de confirmação do endereço novo; o endereço antigo do
  membro **não** fica reservado.
- **Troca da própria conta pela rota antiga** (`PATCH /users/:id`, modo `compat`, usada pelo app mobile): continua
  trocando o e-mail na hora, com o mesmo 409 e o `access_token` novo. Efeitos aditivos: `email_verified_at = null`,
  link de confirmação para o endereço novo, "Não fui eu" de 7 dias para o antigo (que fica reservado) e aviso de
  senha alterada. O site usa as rotas `/account/*` (seção 5.1).
- **E-mail reservado**: o endereço antigo de uma troca feita pela própria pessoa responde 409 `E-mail já
  cadastrado` a outras contas por 7 dias (`POST /users`, convites e o aceite deles, equipe, troca da própria conta,
  `POST /stores/signup` e `POST /platform/stores`).
- **Convite de troca do responsável pendente** (`make_owner`, criado pelo superpainel): o ADMIN não ocupa o e-mail do
  convidado na mesma loja. `POST /users`, `PATCH /users/:id` de um membro ou da própria conta da equipe → 409
  `Este e-mail tem um convite pendente da administração da plataforma para assumir a loja como responsável: ele não
  pode ser usado em outra conta da equipe enquanto o convite valer.` (auditoria FAILURE com `reason:
  'owner_invitation_pending'`). Clientes e o cadastro público não mudam.

### 5.3 Loja (painel da equipe)

| Rota | Acesso | Descrição |
|---|---|---|
| `GET /store/status` | rota antiga (equipe → própria loja; demais → loja padrão) | `{ id, is_open, opening_message, closing_message }` |
| `PATCH /store/status` | ADMIN, EMPLOYEE | Abre/fecha a própria loja e edita as mensagens |
| `GET /store/settings` | ADMIN | Configurações completas (sem segredos) + situação (`access`). Aditivos: `latitude`, `longitude` (local da loja, `number \| null`) e `road_distance_available` (`true` só com `GOOGLE_MAPS_API_KEY` e fora de `NODE_ENV=test`: o painel só oferece a distância por rua quando ela funciona) |
| `PATCH /store/settings` | ADMIN | Dados comerciais, endereço, operação, entrega/retirada, zonas (bairros e/ou faixas de CEP), taxas e a política para endereços fora das zonas, pedido mínimo e frete grátis, modo de cobrança (zonas ou distância) com as faixas de km, local da loja (`latitude`/`longitude`), horários, fuso, identidade visual (se o plano permitir). Corpo JSON de até 2 MB (formato das zonas abaixo). Local da loja: números ou `null` (texto com número é convertido); só um dos dois → 400 `Informe a latitude e a longitude da loja juntas (ou deixe as duas vazias).`; modo distância sem o local → 400 `Para cobrar a entrega por distância, informe o local da loja no mapa (latitude e longitude) na seção Entrega.` (conferido só quando a requisição mexe em `latitude`, `longitude` ou `delivery_zones`) |
| `POST /store/settings/geocode` | ADMIN | Localiza a loja no mapa (200; nada é gravado). Corpo `{ zip_code?, street?, number?, neighborhood?, city?, state? }`; sem `zip_code`, usa o endereço salvo da loja. Resposta `{ latitude, longitude, precision: 'ADDRESS' \| 'ZIP_CENTER', source }`. Erros: 400 `Informe o CEP da loja (seção Endereço) para localizá-la no mapa.`, 404 `Não encontramos este endereço no mapa. ...`, 502 `O serviço de mapas não respondeu agora. ...`, 429 (política `CEP_LOOKUP`, chave por loja) |
| `POST /store/settings/delivery-simulation` | ADMIN | "Teste um endereço" do painel (200; nada é gravado). Corpo `{ zip_code (obrigatório), street?, number?, neighborhood?, city?, state?, delivery_zones? (rascunho não salvo, mesmo formato), latitude?, longitude? }`. Resposta `{ mode, address, store_located, located, precision, distance_km, max_km, band, extra_km, zone, outside, refused, delivery_fee, estimated_delivery_time, min_order, free_delivery_above, message }`. 429 pela política `CEP_LOOKUP` (chave por loja, a mesma da rota anterior) |
| `POST /store/logo`, `DELETE /store/logo` | ADMIN | Logo da loja (JPG/PNG/WebP até 5 MB → WebP) |
| `PUT /store/settings/payments`, `DELETE /store/settings/payments` | ADMIN | Credenciais Mercado Pago da loja (token só de escrita; a resposta mostra só uma dica) |
| `GET /store/invitations`, `POST /store/invitations`, `DELETE /store/invitations/:id` | ADMIN | Convites da equipe (a lista traz `make_owner`). `POST` conta no `TEAM_WRITE` da loja; resposta 201 `{ invitation, url }` (+ `message` aditivo quando o e-mail não foi enviado). Limites diários: 3 convites por destinatário **na própria loja** em 24 h → 429 `A loja já enviou muitos convites para este e-mail nas últimas 24 horas. Tente de novo amanhã.`; 100 por loja em 24 h → 429 `A loja atingiu o limite de convites das últimas 24 horas. Tente de novo amanhã.` Com 10 ou mais convites ao mesmo e-mail em 24 h somando as lojas e o superpainel, o convite é criado **sem e-mail**: 201 com o link e `message: 'O convite foi criado, mas o e-mail não foi enviado agora. Copie o link e envie à pessoa.'`. Convite `make_owner` pendente para o e-mail → 409 ao convidar e 403 ao cancelar (`Este convite de troca do responsável pela loja foi criado pela administração da plataforma: só ela pode cancelá-lo ou substituí-lo.`); vencido, pode ser substituído. `invited_by_user_id` sai `null` quando quem convidou não é da equipe da loja (convites do superpainel) |
| `GET /store/customers`, `GET /store/customers/:userId` | ADMIN, EMPLOYEE | Clientes que compraram na loja (paginado) e histórico de pedidos **desta** loja (cada pedido com `number`). Itens com `blocked: boolean` e `block: { reason, blocked_at, blocked_by: { id, name } \| null } \| null`; filtro `?blocked=true\|false` (inválido → 400 `blocked deve ser true ou false.`); o detalhe traz `block` |
| `POST /store/customers/:userId/block` | ADMIN (capacidade `manage`) | `{ reason }` → 201 `{ reason, blocked_at, blocked_by }`. 404 `Cliente não encontrado.` se o cliente nunca pediu nesta loja (igual a id inexistente); 409 `Este cliente já está bloqueado nesta loja.`; 400 `Informe o motivo do bloqueio (ele fica registrado para a equipe da loja e na auditoria).` / `O motivo pode ter no máximo 300 caracteres.` / `O motivo deve ser um texto.` Sessão de suporte → 403 |
| `DELETE /store/customers/:userId/block` | ADMIN (`manage`) | 204; 404 `Este cliente não está bloqueado nesta loja.` |
| `GET /store/subscription` | ADMIN | Plano, assinatura (com `suspended_by` e `cancel_scheduled_by`: `PLATFORM` \| `STORE` \| `null`), limites e uso, armazenamento (`storage`, abaixo), faturas, situação |
| `POST /store/subscription/checkout` | ADMIN | Link de pagamento da assinatura (provedor recorrente configurado). 409 `A assinatura foi suspensa pela administração da plataforma. Fale com o suporte para regularizar.` enquanto a suspensão for PLATFORM. Serializado por loja: a segunda requisição simultânea recebe o mesmo link pendente; se a trava ficar ocupada por mais de ~3 s → 409 `O link de pagamento desta assinatura já está sendo gerado. Aguarde alguns segundos e tente de novo.` 429 acima de `SUBSCRIPTION_CHECKOUT` (10 em 10 min por loja). O app mobile não usa a rota |
| `POST /store/subscription/cancel`, `POST /store/subscription/resume` | ADMIN | Cancelamento no fim do período (sem motivo obrigatório) e desistência. Sem período pago a terminar, o cancelamento é imediato e irreversível: se a loja tem responsável (`owner_user_id`), só ele pode fazê-lo (403 `Sem período pago a terminar, o cancelamento é imediato e não pode ser desfeito: só o responsável pela loja pode fazê-lo.`; sem responsável, qualquer ADMIN). `resume` de um agendamento feito pela plataforma → 409 `O cancelamento da assinatura foi agendado pela administração da plataforma. Fale com o suporte para mantê-la.` (a mensagem de período encerrado tem precedência). As duas respostas trazem `storage` |

`storage` (aditivo, também em `GET /platform/subscriptions/:id` e `GET /platform/stores/:id`): `{ used_bytes, used_mb
(MB binários, 2 casas, arredondado para cima), files, limit_mb, measured_at }`. `limit_mb` é `null` com plano
ilimitado ou sem plano vigente (`limits` distingue os casos); `used_*` é `null` quando a pasta não pôde ser lida.
`usage` e `limits` mantêm o formato.

Zonas de entrega (`delivery_zones` em `PATCH /store/settings`; o mesmo formato vale para `DELIVERY_ZONES_JSON`/`FILE`):
`{ zones: [{ neighborhoods: string[], cities?: string[], zip_ranges?: [{ from, to }], fee, time }], fallback?: { fee,
time }, outside_zones?: 'fallback' | 'refuse' }`. Cada zona precisa de bairros e/ou faixas de CEP (só faixas →
`neighborhoods: []`); faixas normalizadas para 8 dígitos, `from ≤ to`, até 50 por zona. `fallback` é obrigatório,
exceto com `outside_zones: 'refuse'`, que exige pelo menos uma zona (`fallback: null` com `refuse` = ausente).
Sem `outside_zones` vale `fallback` (configurações antigas iguais). Erros com o prefixo `Zonas de entrega inválidas: `.
`GET /store/settings` devolve o JSON gravado.

Chaves opcionais (aditivas; sem elas o JSON gravado é idêntico ao de antes, byte a byte):

```
{ zones: [{ ..., min_order?: number, free_delivery_above?: number }],
  fallback?, outside_zones?,
  min_order?: number, free_delivery_above?: number, min_order_takeout?: true,
  mode?: 'distance',
  distance?: { bands: [{ up_to_km, fee, time, min_order?, free_delivery_above? }],
               max_km?, extra_km_fee?, route_factor, road_distance?: true } }
```

- **Pedido mínimo e frete grátis** (valores em reais como **números JSON**; texto → 400), de 0 a 99999999.99,
  normalizados em centavos. Na loja: `min_order` 0 ou ausente = sem mínimo (não é gravado); `free_delivery_above`
  ausente = sem frete grátis, 0 = sempre grátis; `min_order_takeout` só é guardado como `true` e só junto de um
  `min_order` (o mínimo vale também na retirada). Na zona (ou faixa): ausente ou `null` = herda o da loja; 0 = sem
  mínimo / sempre grátis **só naquela zona**. Exemplos de erro: `"min_order" da zona 2 precisa ser um valor em reais
  de 0 a 99999999.99 (ex.: 30 ou 29.9).` e `"min_order_takeout" deve ser true (...) ou false (...)`.
- **Modo de cobrança**: `mode` ausente = por zonas (padrão; `"zones"` é aceito e não é gravado); `"distance"` = por
  faixas de km a partir do local da loja. No modo distância, `distance` é obrigatório, `zones` pode faltar ou vir vazia
  (gravada como `[]`) e `fallback`/`outside_zones` valem além do raio e para endereços não localizados (`fallback`
  obrigatório, salvo com `refuse`). No modo por zonas, um `distance` enviado é validado e guardado (as faixas não se
  perdem ao trocar de modo); as zonas também ficam guardadas no modo distância.
- **Faixas** (`distance.bands`): de 1 a 20, em ordem crescente de `up_to_km` (maior que 0, até 100 km), cada uma com
  `fee`, `time` (até 20 caracteres) e pedido mínimo/frete grátis próprios opcionais. `max_km` + `extra_km_fee`
  (opcionais, sempre juntos): cobra cada km iniciado além da última faixa até o raio máximo; sem eles, o raio é a
  última faixa (`max_km` só é gravado quando passa da última faixa). `route_factor`: de 1 a 3, padrão 1.3, sempre
  gravado. `road_distance: true`: distância real por rua quando houver `GOOGLE_MAPS_API_KEY` (seção 11.2). Exemplo
  de erro: `as faixas precisam estar em ordem crescente de distância: ...`.
- Ordem das chaves gravadas: `zones`, `fallback`, `outside_zones`, `min_order`, `free_delivery_above`,
  `min_order_takeout`, `mode`, `distance`.
- `DELIVERY_ZONES_JSON`/`FILE` (zonas da plataforma, só da loja padrão sem zonas próprias) aceitam e validam as
  chaves de pedido mínimo e frete grátis, mas o preço e o perfil público as **ignoram**, e as zonas da plataforma são
  sempre por zona (nunca por distância): as regras novas só valem nas zonas da própria loja.

### 5.4 Vitrine pública

| Rota | Descrição |
|---|---|
| `GET /stores` | Diretório de lojas visíveis (paginado, busca) |
| `GET /stores/default` | Perfil público da loja padrão (404 se não houver) |
| `GET /stores/:storeSlug` | Perfil público: identidade, endereço, horários, entrega/retirada, `delivers_outside_zones` (aditivo; `false` = a loja recusa endereços fora das zonas; a loja padrão sem zonas próprias segue a política das zonas da plataforma), `ordering_available`, `unavailable_message`, `payments: { online_enabled, mp_public_key }`. O mesmo campo em `GET /stores/default`. Aditivos: `order_rules: { min_order: number \| null, min_order_takeout: boolean, free_delivery_above: number \| null, varies_by_zone: boolean }` (lidos do JSON de entrega **da própria loja**; `varies_by_zone` conta zonas e faixas de km com valores próprios; loja sem zonas próprias, inclusive a padrão nas zonas da plataforma → nulos/`false`) e `delivery_distance: { max_km } \| null` (só no modo distância; as coordenadas da loja **não** são públicas) |
| `GET /stores/:storeSlug/status` | Mesmo formato de `GET /store/status` |
| `GET /stores/:storeSlug/products`, `/products/:id`, `/addons` | Cardápio da loja |
| `GET /stores/:storeSlug/promotions/banner` | Banner da loja |
| `POST /stores/:storeSlug/orders/quote`, `POST /stores/:storeSlug/orders` | Cliente: orçamento e pedido nesta loja |
| `GET /stores/:storeSlug/orders/my-orders` | Cliente: pedidos nesta loja (paginado, ver seção 5). Loja inexistente **ou desativada** → 404 `Loja não encontrada.` (antes, desativada respondia `200 []`); o histórico de uma loja desativada continua em `GET /orders/my-orders` |
| `POST /stores/:storeSlug/payment/card`, `POST /stores/:storeSlug/payment/pix` | Cliente: pagamento online nesta loja |
| `GET /plans` | Planos ativos e públicos (`monthly_price` arredondado em centavos) |
| `POST /stores/signup` | Autoatendimento de novo estabelecimento (quando habilitado). Slug igual ao `DEFAULT_STORE_SLUG` → 409 reservado (mesmo sem loja com ele); slug que já foi de outra loja (`store_slug_history`) → 409 com a mesma mensagem de "em uso" |

Rotas antigas equivalentes (`/products`, `/addons`, `/store/status`, `/promotions/banner`,
`/orders/quote`, `/orders`, `/payment/card`, `/payment/pix`) atuam na loja padrão (ou na loja da equipe
autenticada, nas leituras). Produtos/adicionais de outra loja num pedido → "não encontrado".

### 5.5 Pedidos e pagamentos

Leitura de pedidos pela equipe (`GET /orders` e `GET /orders/:id`), na lista e no detalhe:

| Perfil | Pedidos que enxerga | Formato |
|---|---|---|
| ADMIN, EMPLOYEE | Todos os pedidos da loja | Completo (como antes) |
| KITCHEN | Só `PENDING` e `PREPARING` | `user: { id, name }`, sem `delivery_address`, `address`, `change_for` e `payment_id`; entregador `{ id, name }` |
| COURIER | Entregas `READY_FOR_PICKUP` sem entregador; as próprias em `READY_FOR_PICKUP` ou `DELIVERING`; as próprias `DONE` ou `CANCELED` nas últimas 24 h | `user: { id, name, phone }` (nunca e-mail), endereço, total, troco e pagamento; entregador `{ id, name }` |

- Fora da etapa → **404 uniforme**. Para cozinha e entregador o `scope` é ignorado: recebem sempre o próprio
  quadro. As telas de cozinha e entregador (web e app) usam `scope=active` com os mesmos filtros. Isso vale
  também para as **escritas**: `PATCH /orders/:id` e `PATCH /orders/:id/cancel` (e `/stores/:slug/orders/...`) da
  cozinha ou do entregador num pedido fora da etapa → 404 `Pedido não encontrado.` (antes, 400 `Transição inválida`
  ou 403 com mensagens que revelavam status, tipo ou entregador). O entregador que perde a corrida para pegar um
  pedido recebe 404. Dentro da etapa, as respostas de regra (400/403) não mudam; ADMIN e EMPLOYEE não mudam.
- `GET /orders?scope=active` (quadro, web e app): mesma forma e mesmos dados. Os dados de outras tabelas (nome,
  telefone e foto do cliente, produto) podem ficar até 30 s atrasados (cache por loja); qualquer mudança do pedido
  (status, pagamento, entregador, `updated_at`) aparece na consulta seguinte.
- `GET /orders/charts`: mesma forma; empate de quantidade entre os 5 mais vendidos sai em ordem alfabética (como
  no relatório).
- Dashboard, relatórios, entregadores e "pedidos próximos" só da própria loja e no fuso da loja.
- Cliente: `GET /orders/my-orders` lista os pedidos do cliente em todas as lojas, cada um com
  `store: { id, slug, name, logo }` (paginado; padrão: os 100 mais recentes).
- **Número do pedido** (aditivo): toda resposta de pedido traz `number` (inteiro, número do pedido **na loja**,
  1..N): `POST /orders` e `/stores/:storeSlug/orders`, `GET /orders` (com e sem `scope`, todos os perfis),
  `GET /orders/:id`, `GET /orders/my-orders` e `/stores/:storeSlug/orders/my-orders`, `GET /orders/:id/nearby`,
  `PATCH /orders/:id` e `/cancel`, e os `orders[]` de `GET /store/customers/:userId`. O `id` continua sendo a
  chave das rotas. `number` no corpo de `POST /orders` → 400 (`forbidNonWhitelisted`).
- **Cliente bloqueado pela loja** (seção 5.3): 403 `Não é possível fazer pedidos nesta loja. Fale com a loja.`
  (sem o motivo) em `POST /orders/quote`, `POST /orders` pago na entrega, `POST /payment/pix` e
  `POST /payment/card`, nas rotas antigas (loja padrão) e em `/stores/:storeSlug/...`. Não afeta outras lojas,
  `POST /orders` com `paymentId` (pagamento já aprovado), a criação do pedido pelo pagamento aprovado (webhook,
  status, conciliação) nem a repetição de uma cobrança existente com a mesma `idempotencyKey`.
- **Endereço fora da área** (loja com `outside_zones: 'refuse'`): 400 `{ statusCode: 400, message: 'Este endereço
  está fora da área de entrega da loja.', error: 'Bad Request', code: 'DELIVERY_OUT_OF_AREA' }` em
  `POST /orders/quote`, `POST /orders` pago na entrega, `POST /payment/pix` e `POST /payment/card`, nas rotas antigas
  e em `/stores/:storeSlug/...`, conferido antes dos itens e antes de cobrar. Pagamento já aprovado nunca é recusado
  (paga o `fallback` da loja, ou o da plataforma).
- **Endereço não localizado no mapa** (loja no modo distância com `outside_zones: 'refuse'`): o mesmo 400
  `DELIVERY_OUT_OF_AREA`, com mensagem e motivo próprios: `{ statusCode: 400, message: 'Não conseguimos localizar
  este endereço no mapa para calcular a entrega. Confira o CEP, a rua e o número ou escolha retirar no balcão.',
  error: 'Bad Request', code: 'DELIVERY_OUT_OF_AREA', reason: 'ADDRESS_NOT_LOCATED' }`, nos mesmos quatro pontos.
  Além do raio, o 400 é o `DELIVERY_OUT_OF_AREA` de sempre (sem `reason`).
- **Orçamento** (`POST /orders/quote` e `/stores/:storeSlug/orders/quote`), campos aditivos (os de antes não
  mudam): `delivery_fee` (cobrada: 0 quando o frete grátis vale), `delivery_fee_original` (taxa da zona, faixa ou
  `fallback` antes do frete grátis; 0 na retirada), `free_delivery_applied` (`true` só quando havia taxa > 0 e o
  subtotal atingiu o valor), `free_delivery_threshold` (`number | null`; `null` na retirada ou sem regra),
  `missing_for_free_delivery` (0 = atingido; `null` sem regra, na retirada ou com taxa original 0),
  `min_order_value` e `missing_for_min_order` (`null` sem mínimo; 0 = atingido), `delivery_mode`
  (`'zones' | 'distance' | null`; `null` na retirada) e `distance_km` (`number | null`, 1 casa; só no modo
  distância com o endereço localizado). **Abaixo do mínimo, o orçamento responde 200** com quanto falta.
- **Pedido abaixo do mínimo**: 400 `{ statusCode: 400, message: 'O pedido mínimo desta loja para entrega é R$ 30,00.
  Faltam R$ 4,10.' (ou "para retirada"), error: 'Bad Request', code: 'ORDER_BELOW_MINIMUM', min_order_value: 30,
  missing_for_min_order: 4.1 }` em `POST /orders` pago na entrega, `POST /payment/pix` e `POST /payment/card` (rotas
  antigas e `/stores/:storeSlug/...`). Conferido depois dos itens (o `DELIVERY_OUT_OF_AREA` vem antes) e nunca num
  pagamento já aprovado (`POST /orders` com `paymentId`, webhook, status, conciliação). O valor cobrado continua
  sendo o total do servidor, já com a taxa zerada quando há frete grátis.
- `GET /payment/status/:id`: o pagador ou ADMIN/EMPLOYEE da loja do pagamento (404 nos demais casos,
  inclusive cozinha e entregador). `POST /orders` com `paymentId` de outro cliente ou de outra loja recebe a
  mesma resposta de um pagamento inexistente. A consulta repetida dispara no máximo uma consulta ao Mercado Pago por
  pagamento a cada 5 s (`STATUS_POLL_RECHECK_MS`, em memória por instância); dentro do intervalo, devolve o status
  gravado (o webhook e a conciliação o mantêm atualizado e não são limitados por isso).
- Pagamento online aprovado que é estornado, contestado ou cancelado direto no Mercado Pago: o pedido fica com
  `payment_status = REFUNDED` (valor que já existia), mesmo sem estar cancelado, e a auditoria registra
  `payment.reversed` (seção 7).
- Limite mensal do plano (403 `MONTHLY_ORDERS_LIMIT_MESSAGE`) em `POST /stores/:slug/payment/pix|card` e no
  `POST /orders` pago na entrega: mesma mensagem; mudou só a contagem das reservas (seção 7).
- **Endereços** (aditivo; corpo das requisições inalterado): as respostas de `POST /addresses`, `GET /addresses` e
  `GET/PATCH /addresses/:id` trazem `canonical_neighborhood`, `canonical_city`, `canonical_state`,
  `neighborhood_source` (`'CEP' | 'MANUAL' | null`), `cep_status` e `cep_checked_at`. Esses campos no corpo → 400
  (só o servidor os grava). `PATCH /addresses/:id` sem nenhuma mudança → 200 com o endereço como está, sem gravar
  nem reconsultar o CEP. `GET /addresses/cep/:cep` mantém o formato (ViaCEP) e os status 400/404/429/502, agora com
  cache por instância (encontrado 24 h, inexistente 1 h), consultas simultâneas compartilhadas e 60 s sem consultar
  um serviço depois de uma falha (com os dois fora do ar, 502 na hora).
  Entrega por distância (aditivo): `geo_latitude`, `geo_longitude`, `geo_precision`
  (`'ADDRESS' | 'ZIP_CENTER' | 'MANUAL' | null`), `geo_source` (`'GOOGLE' | 'NOMINATIM' | 'AWESOMEAPI' | 'FAKE' | null`),
  `geo_status` (`'FOUND' | 'NOT_FOUND' | 'UNAVAILABLE' | null`) e `geo_checked_at`. Só o servidor os grava (no corpo → 400). Os
  campos antigos `latitude`/`longitude` do endereço (aceitos desde antes) continuam como estão e **nunca** definem a
  taxa de entrega.
- `POST /payment/pix` e `/payment/card` (e `/stores/:storeSlug/payment/...`): 429 acima de `PAYMENT_CREATE`
  (cliente + loja; padrão 10 em 10 min) ou `PAYMENT_CREATE_IP` (padrão 60 em 10 min). Só cobranças novas
  contam; repetir a mesma `idempotencyKey` não conta. Teto de 5 cobranças pendentes não vencidas (PIX ou
  cartão em análise) por cliente e loja → 429 `Você já tem pagamentos pendentes nesta loja. Pague ou cancele
  um deles antes de gerar outro.`
- Webhook do delivery: `POST /payment/webhook` (corpo não confiável; reconsulta no Mercado Pago com a
  credencial da loja do pagamento). 429 por IP acima de `PAYMENT_WEBHOOK` (padrão 300 por minuto; o Mercado
  Pago reenvia). Cada pagamento é reconsultado no máximo uma vez a cada 15 s (as notificações repetidas viram
  uma reconsulta no fim do intervalo); o processamento usa uma fila com 8 em paralelo e até 500 esperando (o
  excedente é descartado e a conciliação cobre); consultas simultâneas do mesmo pagamento compartilham uma
  chamada ao Mercado Pago. A cobrança SaaS tem webhook próprio: `POST /billing/webhook/mercadopago`.

### 5.6 Superpainel (`/platform`, somente `SUPER_ADMIN`, tudo auditado)

| Área | Rotas |
|---|---|
| Dashboard | `GET /platform/dashboard` |
| Estabelecimentos | `GET/POST /platform/stores`, `GET/PATCH /platform/stores/:id`, `POST /platform/stores/:id/{suspend,reactivate,deactivate,restore}`, `GET /platform/stores/:id/{users,metrics,audit,invitations}`, `POST /platform/stores/:id/invitations`, `DELETE /platform/invitations/:id`, `POST /platform/stores/:id/support-sessions`, `GET /platform/support-sessions`, `POST /platform/support-sessions/:id/end` |
| Usuários | `GET /platform/users`, `GET /platform/users/:id`, `POST /platform/users/:id/{block,unblock,revoke-sessions,password-reset}`, `GET /platform/auth-events` |
| Planos | `GET/POST /platform/plans`, `GET/PATCH /platform/plans/:id` |
| Assinaturas | `GET /platform/subscriptions`, `GET /platform/subscriptions/:id`, `POST /platform/stores/:id/subscription`, `POST /platform/subscriptions/:id/{change-plan,cancel,resume,reactivate,suspend}`, `POST /platform/subscriptions/:id/invoices`, `GET /platform/invoices`, `POST /platform/invoices/:id/{mark-paid,mark-failed,void}` |
| Financeiro | `GET /platform/finance` |
| Auditoria | `GET /platform/audit` |
| Configurações | `GET/PATCH /platform/settings`, `POST /platform/settings/test-email` |
| Manutenção | `POST/GET /platform/maintenance/optimize-images` (tarefa em segundo plano; alias antigo `POST /maintenance/optimize-images`), `POST/GET /platform/maintenance/cleanup-uploads` (`GET ?include=schedule` traz também a limpeza agendada), `GET /platform/maintenance/store-credentials`, `POST /platform/maintenance/store-credentials/reencrypt` |

## 6. Planos e assinaturas

Transições válidas (`src/billing/subscription-rules.ts`); qualquer outra responde **409** (inclusive
`suspend`/`reactivate` do superpainel em estado incompatível):

```
TRIALING  → ACTIVE | PAST_DUE | CANCELED
ACTIVE    → PAST_DUE | SUSPENDED | CANCELED
PAST_DUE  → ACTIVE | SUSPENDED | CANCELED
SUSPENDED → ACTIVE | CANCELED
CANCELED  → (final; nova contratação cria outra assinatura)
```

Rotina periódica (`SubscriptionLifecycleService`, a cada `SAAS_BILLING_INTERVAL_MS`): fim do teste → ACTIVE
(plano gratuito) ou fatura aberta + PAST_DUE; fim do período → renovação (fatura) ou CANCELED (cancelamento
agendado); fim da tolerância (`platform_settings.grace_period_days`) → SUSPENDED com `suspended_by = BILLING`.
Pagamento confirmado (manual ou webhook validado) → fatura PAID + ACTIVE com novo período. Notificações
repetidas não geram efeitos duplicados (`billing_webhook_events` + `provider_payment_id` único).

Quem suspendeu (`subscriptions.suspended_by`, nas respostas do superpainel e da loja):

- **BILLING** (rotina de inadimplência): o pagamento da fatura regulariza e reativa.
- **PLATFORM** (superadmin, `POST /platform/subscriptions/:id/suspend`): um pagamento (manual ou do Mercado
  Pago) quita a fatura, mas **não** reativa; só `POST /platform/subscriptions/:id/reactivate` devolve a loja.
  Enquanto isso, `POST /store/subscription/checkout` responde 409 e a página `/subscription` da loja mostra o
  aviso da suspensão pela plataforma, sem o botão de pagamento. Sem cobrança online configurada
  (`billing.online_checkout_available = false`), a página explica que o pagamento é registrado pelo suporte.

Limites (`PlanLimitsService`): equipe ativa, produtos fora da lixeira, pedidos do mês (calendário da
loja) e **armazenamento** (`max_storage_mb`: soma dos arquivos `s<storeId>-` da loja na pasta de uploads —
produtos, adicionais, logo e `POST /uploads`; avatares não contam; seção 11.1). Downgrade só se o uso atual couber
no novo plano, inclusive o armazenamento (409 com a violação `storage_mb`, `MB de armazenamento: 1,5 em uso
(limite 1)`). Sem plano vigente não há cota (a situação da loja já bloqueia o painel). `max_storage_mb` aparece nas
rotas `/platform/plans`, no `.plan` do detalhe da assinatura e no da loja; **não** em `GET /plans` (público) nem no
plano de `GET /store/subscription`. Recursos: pagamentos online, relatórios, identidade visual. `monthly_price` (em
`GET /plans`, `/platform/plans` e no painel da loja) é arredondado em centavos.

Quem agendou o cancelamento (`subscriptions.cancel_scheduled_by`, nas respostas da loja e do superpainel):

- **STORE** (ADMIN da loja): a loja pode desistir (`POST /store/subscription/resume`).
- **PLATFORM** (superadmin): a loja **não** desfaz (409 `Fale com o suporte`); a página `/subscription` esconde
  "Desistir do cancelamento" e aponta para o suporte. Se a plataforma agenda por cima de um agendamento da loja,
  passa a ser dona dele (novo evento `CANCEL_SCHEDULED` com `scheduled_by: PLATFORM` e `from_scheduled_by: STORE`).
- O superadmin pode suspender uma assinatura já suspensa por inadimplência: a origem vira PLATFORM (evento
  `STATUS_CHANGED` SUSPENDED→SUSPENDED com `from_suspended_by`) e um pagamento posterior não reativa.

Webhook SaaS (`POST /billing/webhook/mercadopago`): com `SAAS_BILLING_PROVIDER=MANUAL` e sem
`MP_SAAS_ACCESS_TOKEN` → 200 `{ status: 'ok', result: 'ignored' }` e registro `IGNORED` (reentrega =
`duplicate`). Com `MERCADO_PAGO` sem token continua 503/`FAILED`.

Indicadores do superpainel (metodologia):

- **MRR**: soma do preço mensalizado (anual ÷ 12) das assinaturas ACTIVE e PAST_DUE de planos pagos. A
  assinatura vigente de uma loja **desativada** continua contando (a cobrança continua); o alerta
  `INACTIVE_STORE_BILLED` pede cancelar a assinatura ou restaurar a loja.
- **ARR**: MRR × 12 (**projeção**).
- **Churn mensal (lojas)**: assinaturas canceladas no mês ÷ assinaturas pagantes no início do mês.
- **Receita da Comestra**: faturas SaaS pagas. **Volume das lojas (GMV)**: pedidos pagos e não
  cancelados das lojas — nunca somados à receita da plataforma.

## 7. Pagamentos do delivery por loja

- Gateway resolvido por loja: credenciais da loja; para a **loja padrão**, se ela não tiver
  credenciais, o `MP_ACCESS_TOKEN` do ambiente (compatibilidade). Outras lojas sem credenciais →
  pagamento online indisponível (pagamento na entrega continua).
- Chave pública da loja exposta no perfil público (tokenização do cartão no navegador).
- `external_reference` com a loja; idempotência por loja; estorno com a credencial da loja do pagamento.
- Sandbox continua só por ambiente (development/test).
- **PIX repetido**: o mesmo carrinho (itens, tipo, endereço) com o mesmo valor e um PIX ainda pendente, com
  pelo menos 5 min de prazo, devolve esse PIX (mesmo id, QR e `expires_at`) em vez de criar outra cobrança.
  No sandbox, só antes do prazo de aprovação automática.
- **Limite mensal do plano** (`max_monthly_orders`): ao criar uma cobrança online e ao criar um pedido pago na
  entrega, conta também, para a loja inteira, os pagamentos aprovados ainda sem pedido e os cartões em análise, e
  os PIX pendentes (não vencidos) **do próprio cliente** que pede. PIX pendentes de outros clientes não reservam
  vaga: criar um PIX não custa nada, e contas descartáveis bloqueariam as vendas da loja. PIX aprovados de clientes
  diferentes no limite exato passam, como nos demais limites suaves (decisão pela disponibilidade; o excesso fica
  limitado porque o PIX precisa ser pago).
- **Estorno ou contestação feitos no Mercado Pago**: o webhook também reconsulta pagamentos já aprovados (no
  máximo uma vez a cada 15 s por pagamento). Estorno, chargeback ou cancelamento feitos no Mercado Pago → o
  `payment_status` do pedido vira `REFUNDED` (a loja vê no painel que não vai receber; cancelar o pedido não tenta
  estornar de novo) e a auditoria registra `payment.reversed`. Sem `MP_NOTIFICATION_URL`, essas reversões não são
  detectadas (a conciliação olha só pagamentos sem pedido). Risco aceito: uma notificação forjada para um pagamento
  aprovado custa no máximo 1 consulta ao Mercado Pago a cada 15 s por pagamento (limite `PAYMENT_WEBHOOK` por IP).
- **Finalização com várias instâncias**: criar o pedido de um pagamento aprovado (ou estorná-lo quando a loja não
  pode mais vender) segura uma trava do banco por pagamento (`pg_advisory_xact_lock(hashtextextended('payment-finalize:'
  || id, 0))`, numa transação), no máximo 4 ao mesmo tempo por instância (`FINALIZE_CONCURRENCY`): o pedido nunca é
  criado enquanto outra instância estorna. Cada finalização usa 2 conexões do pool enquanto segura a trava.
- **Loja que não pode vender** (SUSPENDED, INACTIVE, SUBSCRIPTION_SUSPENDED, SUBSCRIPTION_CANCELED,
  NO_SUBSCRIPTION): um pagamento aprovado **não** vira pedido. O valor é estornado com a credencial da loja,
  `finalize_error` registra `a loja não está aceitando pedidos no momento (valor estornado|estorno pendente)`
  e a auditoria registra `payment.order_not_created` (`metadata.availability`) e `payment.refund`.
  `GET /payment/status` passa a mostrar `refunded`. Loja apenas fechada continua recebendo o pedido.
- **Conciliação** (a cada 60 s): rodada de 50 pagamentos, no máximo 10 por loja, aprovados sem pedido
  primeiro, lojas intercaladas e rodízio pelo menos recentemente conferido (`payments.updated_at` marca a
  última conferência). Pendentes de loja que não vende são cancelados no Mercado Pago com a credencial da loja
  (`cancelled/by_collector`; no sandbox, localmente), com auditoria `payment.cancel` (`reason
  store_cannot_sell`). Pendentes impossíveis de reconsultar não seguram a fila. A janela da conciliação é
  `max(3 dias, PIX_EXPIRATION_MINUTES + 1 dia)`; a mesma janela vale para as reservas do limite mensal e para o teto
  de 5 cobranças pendentes por cliente.
- Falha definitiva (`finalize_error`) não é refeita por webhook, status ou conciliação: o estorno pendente
  fica para a equipe (alerta `REFUND_PENDING` no superpainel).
- `POST /orders` com `paymentId` desconhecido: cada consulta ao Mercado Pago conta no `PAYMENT_CREATE` do
  cliente na loja (contador próprio) e a rota consome `ORDER_CREATE_IP` → 429.

## 8. Frontend web

| Área | Rotas |
|---|---|
| Plataforma (pública) | `/` (Comestra + diretório de lojas), `/cadastrar-loja` (autoatendimento, se habilitado) |
| Loja (vitrine) | `/loja/:slug`, `/loja/:slug/cart`, `/loja/:slug/order-success` (`/cart` e `/order-success` antigos vão para a última loja visitada) |
| Conta do cliente | `/signin`, `/signup`, `/my-orders`, `/profile`, `/esqueci-senha`, `/redefinir-senha/:token`, `/convite/:token`, `/verificar-email/:token`, `/confirmar-email/:token`, `/desfazer-troca-de-email/:token` |
| Painel da loja | `/login`, `/dashboard`, `/orders`, `/products`, `/users`, `/trash`, `/customers`, `/settings`, `/subscription` |
| Superpainel | `/platform`, `/platform/stores`, `/platform/stores/new`, `/platform/stores/:id`, `/platform/plans`, `/platform/subscriptions`, `/platform/users`, `/platform/finance`, `/platform/audit`, `/platform/settings` |

Carrinho e PIX em andamento são guardados **por loja**. A identidade da plataforma (Comestra) fica em
`config/brand.ts`; a identidade da loja (nome, logo, cor) vem da API. Sessão entre abas, sessão de suporte,
CSP e Mercado Pago no navegador: seção 11.7.

- **Número do pedido**: o quadro de pedidos (inclusive cozinha e entregador), o modal do entregador, a
  "Atividade recente" do Dashboard, Meus Pedidos, a confirmação (que busca o número quando o pagamento online só
  devolve o id), o aviso do carrinho (`Pedido #N realizado com sucesso!`) e o histórico do cliente no painel
  mostram `Pedido #<número da loja>` (`orderNumber()`/`orderLabel()` em `services/orderService.ts`, que caem no
  `id` quando a resposta não traz `number`). O id interno fica no `title` (e em `data-order-id` nos cartões do
  quadro).
- **Clientes** (painel): selo "Bloqueado", filtro Todos/Bloqueados e, só para o ADMIN, bloquear (motivo
  obrigatório + confirmação, `BlockCustomerDialog`) e desbloquear, na lista e no detalhe (faixa com motivo, quem
  bloqueou e quando).
- **Sessões ativas**: em Meus Dados (cliente) e num modal do menu lateral (painel e superpainel), oculto em
  sessão de suporte: lista paginada com o selo "Este navegador", "Encerrar" nas outras sessões, "Sair de todos
  os aparelhos" (com confirmação) e atualizar (`components/Sidebar/ActiveSessions.tsx`, carregado sob demanda).
- **Superpainel → Configurações**: cartão "E-mail transacional" (driver, servidor SMTP, remetente, problemas da
  configuração e "Enviar e-mail de teste", com o e-mail do operador já preenchido) e cartão de Manutenção em três
  partes: otimizar imagens, limpar arquivos sem uso ("Verificar" e "Apagar sem uso", com confirmação que mostra a
  última verificação; acompanhamento a cada 3 s) e credenciais do Mercado Pago (situação por formato e "Regravar
  credenciais", com confirmação; desabilitado quando nada está no formato antigo). A manutenção mostra também a
  linha "Limpeza automática ligada/desligada" (intervalo, última execução automática e a próxima prevista).
- **Segurança da conta** (`components/Account/AccountSecurity.tsx`): em Meus Dados (cliente) e em "Minha conta" no
  menu do painel e do superpainel (oculto em sessão de suporte): e-mail com o selo Confirmado/Não confirmado,
  reenvio da confirmação, troca de e-mail com confirmação no endereço novo e troca de senha com a senha atual (a
  senha saiu do formulário de dados). Páginas públicas dos links: `/verificar-email/:token`, `/confirmar-email/:token`
  e `/desfazer-troca-de-email/:token`. O modal da equipe não mostra e-mail e senha quando a pessoa edita a si mesma.
- **Entrega**: Configurações → Entrega tem "Entregar com uma taxa padrão" ou "Recusar a entrega" para endereços fora
  das zonas, faixas de CEP por zona (`22010-000 a 22099-999` ou um CEP) e a orientação de usar os nomes de bairro
  dos Correios. No carrinho, `DELIVERY_OUT_OF_AREA` aparece junto do endereço ("Fora da área de entrega", "Nada foi
  cobrado.", botão "Retirar no balcão"), a taxa vira "Fora da área" e o pagamento fica bloqueado; também o aviso de
  que a loja só entrega nas zonas atendidas e "Pelo CEP, o bairro é X" quando o bairro do CEP difere do digitado.
- **Pedido mínimo e frete grátis**: Configurações → Entrega → "Pedido mínimo e frete grátis" ("Pedido mínimo para
  entrega", "Frete grátis a partir de", "Pedido mínimo também na retirada no balcão") e os mesmos dois campos em cada
  zona e em cada faixa de km ("Vazio: usa o da loja. R$ 0,00: ..."), com aviso quando o frete grátis fica abaixo do
  mínimo. A vitrine mostra os selos de pedido mínimo e frete grátis (de `order_rules`, com uma nota quando variam por
  região). O carrinho trabalha com os campos do orçamento: "Faltam R$ X em produtos para finalizar o pedido" (o
  pagamento fica bloqueado), barra de progresso "Faltam R$ X para o frete grátis", a taxa riscada ao lado de "Grátis"
  e "Frete grátis! Você economizou R$ X na entrega." Enquanto o orçamento carrega, o carrinho mostra os valores
  anunciados pela loja.
- **Entrega por distância**: em Configurações → Entrega, "Como cobrar a entrega" escolhe "Por bairro ou CEP (zonas)"
  ou "Por distância (km)". No modo distância: editor de faixas ("Faixas de distância", "Adicionar faixa", "Cobrar por
  km adicional além da última faixa", "Raio máximo (km)", "Valor por km adicional", "Fator de rota" e, quando
  `road_distance_available`, "Usar a distância real pelas ruas"); "Local da loja no mapa" (mapa Leaflet carregado sob
  demanda, pino arrastável, "Localizar pelo endereço da loja", campos de latitude e longitude e "Ver no mapa", que abre
  o OpenStreetMap); e "Teste um endereço" (CEP e número), que usa a configuração **ainda não salva** da tela. A vitrine
  mostra "Entrega até X km" e o carrinho mostra a linha "Distância da loja". O Leaflet vem no bundle (`leaflet` em
  `package.json`); só as imagens do mapa saem do OpenStreetMap (CSP, seção 11.7).
- **Armazenamento**: medidor "Armazenamento" em `/subscription` e no detalhe da assinatura do superpainel; campo
  "Armazenamento (MB)" com "Ilimitado" no formulário de planos.
- **Pagamento estornado**: pedido com `payment_status = REFUNDED` e status diferente de `CANCELED` é um pagamento
  desfeito no Mercado Pago (`isPaymentReversed`, `utils/orders.ts`). O quadro mostra "Estornado no Mercado Pago" em
  vermelho, um alerta no cartão (não entregar sem receber de outra forma, ou cancelar) e uma faixa com os pedidos
  ativos nessa situação, para todos os perfis; o cliente vê "Estornado" em Meus Pedidos.
- **Assinatura da loja**: com `cancel_scheduled_by = PLATFORM`, a página esconde "Desistir do cancelamento" e aponta
  para o suporte. No cancelamento imediato, a página lê `owner_user_id` de `GET /store/settings` (só nesse caso) e
  esconde o botão para o ADMIN que não é o responsável; um 403 `IMMEDIATE_CANCEL_OWNER_ONLY` mostra a mensagem da API.
- **Equipe › Convites**: convite `make_owner` pendente aparece como "Novo responsável pela loja" / "Criado pela
  plataforma", sem "Revogar"; 429 e 409 aparecem dentro do formulário com a mensagem da API; a resposta com
  `url: null` e `delivered: true` mostra "Convite enviado".
- **Tabelas no celular**: o `DataTable` tem `stackOnMobile` (abaixo de 640 px cada linha vira um cartão: coluna
  principal, pares rótulo: valor e ações), ligado nas 17 listas do painel e do superpainel; só um dos dois formatos
  existe no DOM por vez.
- **Desempenho**: todos os polls (quadro 5 s, indicadores 15 s, gráficos 60 s, status da loja 30 s, painel 120 s,
  Meus Pedidos 10 s, dashboard do superpainel 60 s) pausam com a aba oculta e atualizam na volta (`usePolling`); o
  quadro não redesenha quando a resposta é igual à anterior. O Recharts fica no pedaço `charts-*.js` (~364 kB,
  carregado sob demanda) e React + roteador no pedaço `react`.

## 9. Configuração (novas variáveis do backend)

| Variável | Padrão | Uso |
|---|---|---|
| `DB_MIGRATIONS_RUN` | `true` | Aplica migrations pendentes na subida |
| `DB_SYNCHRONIZE` | `false` (todos os ambientes) | Recomendado `false` também em desenvolvimento (ver `operacao.md`) |
| `DB_ALLOW_DESTRUCTIVE_REVERT` | vazio | Autoriza o `down()` destrutivo da `MultiTenantFoundation` (só com backup) |
| `INITIAL_STORE_NAME`, `INITIAL_STORE_SLUG` | "Loja principal", `loja-principal` | Loja criada na migração de uma instalação existente |
| `DEFAULT_STORE_SLUG` | vazio | Força a loja padrão das rotas antigas (senão, a do superpainel) |
| `CREDENTIALS_ENCRYPTION_KEY` | vazio (dev: chave fixa) | Chave AES-256 (32 bytes base64/hex) das credenciais de pagamento das lojas. **Obrigatória em produção** para gravar credenciais |
| `TRUST_PROXY` | vazio | IP real atrás de proxy (auditoria e limites por IP): número de proxies (ex.: `1`) ou lista de IPs/sub-redes deles. `true` é tratado como `1`, com aviso (no Express, `true` confiaria no `X-Forwarded-For` inteiro, escrito pelo cliente). Use CIDR IPv4 simples (`10.0.0.0/8`), nunca `::ffff:10.0.0.0/8`. Vazio com `X-Forwarded-For` recebido → aviso no log |
| `RATE_LIMIT_ENABLED`, `RATE_LIMIT_<NOME>` | `true` | Limites (`limite/segundos`; tabela com padrões na seção 11.8): `LOGIN_FAILURES`, `LOGIN_FAILURES_IP`, `LOGIN_FAILURES_ACCOUNT`, `LOGIN_SUCCESS`, `FORGOT_PASSWORD`, `TOKEN_REDEEM`, `SIGNUP`, `STORE_SIGNUP`, `CEP_LOOKUP`, `ORDER_CREATE`, `ORDER_CREATE_IP`, `PAYMENT_CREATE`, `PAYMENT_CREATE_IP`, `PAYMENT_WEBHOOK`, `UPLOAD`, `ADDRESS_WRITE`, `TEAM_WRITE`, `CREDENTIALS_CHANGE`, `ACCOUNT_EMAIL`, `ACCOUNT_EMAIL_TARGET`, `REFRESH`, `SUBSCRIPTION_CHECKOUT` e `TEST_EMAIL` (e-mail de teste do superpainel, por operador; padrão `5/600`; lido pelo `PlatformSettingsService`, fora do `RATE_LIMIT_POLICIES`, com o mesmo formato e o mesmo `RATE_LIMIT_ENABLED`) |
| `JWT_LEGACY_ISSUED_BEFORE` | vazio | Instante ISO 8601 do deploy que aplicou `AuthSessions` (ex.: `2026-11-01T12:00:00Z`): tokens sem `jti` emitidos antes dele valem até o corte + `JWT_EXPIRES_IN`. Vazio: em produção, nenhum token sem `jti` é aceito (todos entram de novo); em dev/test, todos até expirar. `none`/`off`/`false`/`0` ou inválido recusam todos (seção 4.4) |
| `JWT_DEV_SECRET_FILE` | `<backend>/.temp/dev-jwt-secret` | Só em `NODE_ENV=development` sem `JWT_SECRET`: arquivo do segredo aleatório desta instalação (seção 4.4) |
| `AUTH_WEB_COOKIE` | `true` | Sessão do site em cookie (seção 11.10). `false` para de emitir na hora (as existentes renovam até vencer) |
| `JWT_ACCESS_EXPIRES_IN` | `15m` | Validade do token de acesso das sessões em cookie (de `1m` a `60m`; inválido → `15m` com aviso) |
| `AUTH_SESSION_MAX_AGE` | = `JWT_EXPIRES_IN` | Validade absoluta da sessão em cookie (de `5m` a `90d`; a rotação não estende) |
| `AUTH_REFRESH_GRACE_SECONDS` | `30` | Tolerância do refresh anterior (0 a 120 s) |
| `AUTH_COOKIE_ORIGINS` | vazio | Origens com credenciais (cookie). Vazio = `CORS_ORIGINS` explícito + origem de `APP_WEB_URL` (em dev/test sem `APP_WEB_URL`, `http://localhost:5173`); `*` é ignorado. Em produção sem nenhuma origem, o modo cookie fica desligado, com aviso |
| `AUTH_COOKIE_SAMESITE` | `strict` | `strict` ou `lax` (`lax` em produção gera aviso) |
| `ACCOUNT_SECURITY_MODE` | `compat` | `compat` \| `strict`. Nesta versão o `strict` ainda **não** existe (fase 1b): o valor é lido, a API segue em `compat` e avisa na subida; inválido → `compat` com aviso |
| `PUBLIC_API_URL` | vazio | Endereço público da API (ex.: `https://api.comestra.com.br` ou `https://comestra.com.br/api`), base do logo das lojas nos e-mails (`<PUBLIC_API_URL>/uploads/<arquivo>`). Vazio = e-mails sem logo (monograma); inválido = aviso na subida, sem mostrar o valor |
| `UPLOADS_CLEANUP_INTERVAL_HOURS` | vazio (desligada) | Limpeza automática dos arquivos sem uso, em horas (decimais aceitos; mínimo 10 s; `0`/`off` desliga; inválido → desligada com aviso). Seção 11.1 |
| `CEP_LOOKUP_FAKE` | vazio | **Só com `NODE_ENV=test`** (ignorada com aviso nos outros): mapa JSON de CEPs que substitui ViaCEP e BrasilAPI (seção 11.2) |
| `GOOGLE_MAPS_API_KEY` | vazio | Opcional. Liga o Google Geocoding no início da cadeia de localização e a distância real por rua (Routes API, `computeRoutes`). Na chave, habilite a **Geocoding API** e a **Routes API**. Sem ela, o Google é pulado e o painel não oferece a distância por rua (seção 11.2) |
| `GEOCODING_PROVIDERS` | `google,nominatim,awesomeapi` | Ordem da cadeia de localização dos endereços. Nomes desconhecidos são ignorados com aviso; `none` desliga (todo endereço segue a regra de fora da área nas lojas por distância) |
| `GEOCODING_CONTACT` | vazio | E-mail ou site incluído no User-Agent `comestra-delivery-geocoder/1.0 (<contato>)`, como pede a política do Nominatim. Sem ele, com o Nominatim na cadeia, a API avisa na subida |
| `GEOCODING_NOMINATIM_URL` | `https://nominatim.openstreetmap.org` | Servidor Nominatim próprio (recomendado com mais de uma instância da API ou uso intenso) |
| `GEOCODING_FAKE` | vazio | **Só com `NODE_ENV=test`** (ignorada com aviso nos outros): mapa JSON `{ "<CEP>": { lat, lng, precision?: 'ZIP_CENTER' } \| "unavailable" \| null }` no lugar dos provedores. Em `NODE_ENV=test` sem ela, nada é localizado (nenhuma chamada externa) |
| `DB_POOL_SIZE` | `10` | Conexões no pool da API (1 a 200) |
| `DB_STATEMENT_TIMEOUT_MS` | `60000` | Tempo máximo de cada consulta da API, em ms (`0` desliga; até 24 h). Não vale para as migrations nem para o CLI |
| `DB_POOL_ACQUIRE_TIMEOUT_MS` | `30000` | Espera máxima por uma conexão livre do pool, em ms (`0` = sem limite; até 600000). Esgotada → 500 |
| `PLATFORM_INSIGHTS_CACHE_MS` | `30000` | Cache do dashboard e do financeiro do superpainel, em ms (`0` desliga; até 1 h) |
| `HOST` | `0.0.0.0` | Interface de escuta da API (lida em `main.ts`): `0.0.0.0` = todas as interfaces IPv4 (necessário para o app mobile na rede local); `127.0.0.1` = só este computador (túnel ou proxy na mesma máquina); IPv6 com ou sem colchetes. O log da subida mostra `escutando em <host>:<porta> (<alcance>)` |
| `MAIL_DRIVER` | `log` | `log` (nada é enviado: em dev/test o texto completo vai para o log; em produção só destinatário e assunto, com aviso na subida) ou `smtp`. Valor desconhecido → `log`, com aviso e um item em `mail.issues` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | vazio, `587` (ou `465` com `SMTP_SECURE=true`), ligado só na porta 465 | Servidor SMTP (obrigatório com `smtp`). `SMTP_PORT` inteira de 1 a 65535 (inválida deixa o SMTP não configurado). `SMTP_SECURE`: TLS desde o início; desligado, usa STARTTLS quando o servidor oferece, e o exige quando há usuário e senha |
| `SMTP_USER`, `SMTP_PASSWORD` | vazio | Opcionais, mas sempre juntos (só um deles é problema de configuração). Nunca aparecem em respostas, logs, auditoria ou no superpainel |
| `MAIL_FROM` | vazio | Remetente, obrigatório com `smtp`: `Nome <endereco@dominio>` ou só o endereço, uma linha, até 200 caracteres (no `.env`, entre aspas) |
| `SEED_DEMO_USERS` | ligado em dev/test | Loja demo, equipe demo e cliente demo (senhas públicas); nunca em produção |
| `SEED_DEMO_SUPERADMIN` | ligado em test, desligado em development | Superadmin de demonstração (senha pública); nunca em produção |
| `SUPERADMIN_PASSWORD` | vazio | Senha usada por `platform:superadmin` (criação, `--promote-existing`, `--reset-password`) no lugar da aleatória |
| `SAAS_BILLING_PROVIDER` | `MANUAL` | `MANUAL` ou `MERCADO_PAGO` |
| `MP_SAAS_ACCESS_TOKEN`, `MP_SAAS_WEBHOOK_SECRET`, `SAAS_BILLING_BACK_URL` | vazio | Cobrança recorrente da Comestra (conta MP da plataforma, separada das lojas) |

## 10. Compatibilidade com o app mobile (fora do escopo desta fase)

O app continua chamando as rotas antigas, que atuam na **loja padrão** (clientes e visitantes) ou na
loja da equipe autenticada (leituras do cardápio/status). Contratos preservados: `POST /auth/login`
(`{ access_token, user }`, com campos adicionais), `GET /users/:id` (próprio), `/products`,
`/store/status`, `/orders/*`, `/payment/*`, `/addresses/*`, `/promotions/banner`. Rotas e formatos de lista
foram mantidos (as listas antigas agora trazem no máximo 100 ou 500 itens, seção 5); os novos 429 chegam com
mensagem; `refunded` e `cancelled` já eram tratados como falha. Mudanças visíveis no app: o ADMIN recebe 403
ao trocar e-mail, senha ou perfil do responsável da loja; a cozinha e o entregador só veem a própria etapa.
Pendências para a fase mobile: escolher loja por slug, carrinho por loja, chave pública MP por loja,
superpainel não previsto no app, recuperação de senha, sessão encerrada após troca de senha, envio de
`current_password`.

Desta etapa (só campos aditivos e o formato de erro padrão; nenhuma rota usada pelo app mudou): o token do
login agora tem `jti` e sessão registrada, o que é transparente para o app (ele usa `POST /auth/login` e trata
o 401); a saída do app não chama `POST /auth/logout`, então o token fica válido no servidor até expirar
(atualização futura: chamar a rota ao sair). O app ainda mostra `Pedido #<id>`: numa atualização, usar o campo
`number`. O bloqueio de cliente chega como 403 com a mensagem genérica da API em `/orders/quote`, `/orders`,
`/payment/pix` e `/payment/card`.

Onda 2 da etapa 8 e levas 9a/9b (nenhuma rota usada pelo app mudou de formato; só campos aditivos e mensagens):

- **Sessão em cookie**: o app nunca envia `X-Auth-Transport: cookie`, então nunca recebe cookie nem token curto (o
  cookie jar nativo fica vazio); login e demais emissões seguem `{ access_token, user }` com `JWT_EXPIRES_IN`.
- **Tokens sem `jti`**: um app que ficou logado desde antes das sessões registradas recebe 401 fora da janela de
  `JWT_LEGACY_ISSUED_BEFORE` e volta para o login (o app já trata o 401).
- **Cozinha e entregador**: numa corrida ou com o quadro desatualizado, o app passa a mostrar `Pedido não
  encontrado.` (404) em vez de `Este pedido já está com outro entregador.` / `Transição inválida...`; o quadro
  recarrega depois do erro, como no web.
- **Entrega**: com o padrão (`fallback`), nada muda. Se a loja padrão escolher `refuse`, o app recebe o 400
  `DELIVERY_OUT_OF_AREA` no orçamento e mostra a mensagem (não conhece o `code` nem o bairro do CEP). As respostas
  de `/addresses` só ganham campos (inclusive os `geo_*` da entrega por distância).
- **Pedido mínimo, frete grátis e distância**: a loja que não configura nada não muda. O app recebe os campos novos do
  orçamento e do perfil público sem usá-los; com frete grátis, a taxa chega 0 e o app já mostra "Grátis". Abaixo do
  mínimo, o orçamento passa e o pedido ou a cobrança recebe o 400 `ORDER_BELOW_MINIMUM`, cuja mensagem o app mostra
  (sem aviso antes de enviar). No modo distância, o 400 de endereço não localizado (`reason: ADDRESS_NOT_LOCATED`)
  também aparece como mensagem; a distância não é exibida. Conferido só leitura em
  `frontend-mobile/src/screens/Checkout/index.tsx`.
- **Equipe**: `POST /users` (equipe), restaurar membro e criar produto (inclusive multipart do app) têm o limite do
  plano rígido, com os mesmos status. O ADMIN pode receber 409 ao usar o e-mail de um convite `make_owner` pendente.
  `PATCH /users/:id` da própria conta mantém a troca imediata de e-mail (modo `compat`), agora com aviso e
  "Não fui eu" no endereço antigo; o endereço antigo fica reservado por 7 dias.
- **Uploads**: nomes de campo multipart aninhados além de 2 níveis ou com índice acima de 300 → 400 (o app só
  envia nomes simples, conferido em `frontend-mobile/src/services/productService.ts`).
- **Desempenho**: `GET /orders?scope=active` tem a mesma forma e os mesmos dados (cache de 30 s só para dados de
  outras tabelas); respostas comprimidas quando o app manda `Accept-Encoding`.

## 11. Comportamentos detalhados da implementação

### 11.1 Catálogo e arquivos

- O campo `image` de produtos e adicionais só aceita: arquivo enviado pela própria loja (prefixo
  `s<storeId>-`), URL `https://` ou o valor que o próprio registro já tinha (imagens antigas sem dono).
  `http://`, caminhos e arquivos de outra loja → 400.
- Uploads da loja (produto, adicional, logo, `POST /uploads`) ficam na mesma pasta, com o prefixo da loja:
  o contrato `/uploads/<arquivo>` (web e app mobile) não muda.
- Ao trocar a imagem de um produto ou adicional, o arquivo anterior é apagado quando foi enviado pela própria
  loja (prefixo `s<storeId>-`) e nenhum outro produto ou adicional (inclusive na lixeira) nem o logo de uma loja
  o usa. Imagens antigas sem prefixo, URLs externas e arquivos ainda referenciados ficam (melhor esforço: uma
  falha ao apagar não desfaz a edição).
- Limites de upload em todas as rotas de imagem (avatar, produto, adicional, logo, `POST /uploads`):
  `UPLOAD` por conta (ou por IP sem login), conferido antes de ler o corpo → 429. Conta cada imagem recebida e
  cada multipart que falha no parse (malformado, imagem acima de 5 MB, campos demais, nome recusado); formulário
  válido sem imagem não conta. Escolha de compatibilidade: a falha é contada ao fim do parse (não com uma reserva
  antes de ler o corpo), então uma rajada simultânea de tentativas malformadas ainda passa pelo
  `assertNotLimited` antes de ser contada; com o multer 2.5 o parse malformado é barato. Multipart com até 300
  campos, 16 KB por campo, nomes de até 100 caracteres e 1 arquivo de 5 MB → 400 `Formulário inválido: campos
  demais ou com texto longo demais.`; nome de campo aninhado além de 2 níveis (`a[b][c][d]`) ou com índice de
  array acima de 300 (`x[301]`; nomes como `x[4294967294]` travavam o event loop, GHSA-535w) → 400 `Formulário
  inválido: nome de campo não aceito.`; campo de arquivo errado ou mais de um arquivo → 400 `Envie uma única
  imagem, no campo "file".`; imagem acima de 40 megapixels → 400 `Imagem com resolução muito alta (máximo de 40
  megapixels)...`; no máximo 2 conversões do Sharp ao mesmo tempo por processo.
- **Decodificadores de imagem**: o processo da API deixa ligados só os decodificadores de JPEG, PNG e WebP do
  libvips (`sharp.block`/`unblock` em `common/pipes/optimize-image.pipe.ts`), além da conferência da assinatura do
  arquivo. A otimização de imagens antigas recusa outros formatos (registra o erro e segue); hoje todos os arquivos
  versionados em `uploads/` são `.webp`.
- **Cota de armazenamento por loja** (`max_storage_mb`): o uso é a soma dos arquivos comuns `s<storeId>-` do primeiro
  nível de `UPLOADS_DIR` (`lstat`: atalhos e pastas ficam de fora; avatares `u<id>-` e arquivos sem prefixo nunca
  contam), medido com cache por loja em cada instância (5 min; até 5000 lojas; uma leitura por vez por loja). Os
  uploads feitos pela API somam na hora; a troca de imagem de produto ou adicional, a limpeza e a otimização
  disparam uma nova medição (a troca do logo apaga o arquivo antigo fora dessa conta: o espaço volta em até 5 min).
  A conferência acontece no `OptimizeImagePipe`, **antes de gravar**, em duas etapas: loja já no limite → 403 antes
  de converter (poupa a CPU); depois da conversão em memória, o tamanho final em WebP é reservado sem `await` entre
  conferir e somar (uploads simultâneos na mesma instância não passam juntos) e só então o arquivo é gravado (`wx`).
  Uma falha na gravação, ou a recusa posterior do produto/adicional, apaga o arquivo e devolve o espaço. Acima da
  cota → 403 `Limite de armazenamento do plano <nome> atingido: <usado> de <limite> MB em uso[; a imagem otimizada
  tem <N KB|MB>]. Fale com a administração da plataforma para mudar de plano ou liberar espaço.`, sem gravar nada
  (vale para `POST /uploads`, produtos, adicionais e logo). Sem plano vigente ou com plano ilimitado, nada é recusado;
  pasta ilegível não bloqueia o upload (aviso no log).
- **Cache dos arquivos**: `/uploads` sai com `Cache-Control` de 30 dias e `immutable` (os nomes são únicos e nunca
  sobrescritos).
- `GET /uploads/<inexistente>` responde 404 padrão, sem expor o caminho do servidor. Os arquivos de
  `/uploads` saem com `nosniff` e uma CSP restrita (seção 11.7).
- Produto ou adicional na lixeira, num pedido, responde igual a um id inexistente (`Produto #id não
  encontrado.` / `Adicional #id não encontrado.`), sem revelar o nome.
- Otimização de imagens (somente superadmin, em lotes, auditada no início e no fim): `POST /platform/maintenance/optimize-images`
  inicia uma **tarefa em segundo plano** e responde 202 `{ job }`; `GET` na mesma rota devolve a última execução (`status`
  RUNNING/SUCCEEDED/FAILED, contagens parciais ou finais, duração, quem iniciou). Uma execução por vez entre **todas** as
  instâncias (tabela `maintenance_jobs` com índice único parcial em `RUNNING`; 409 traz a execução em andamento). A execução
  renova um heartbeat; se a instância cair, depois de 10 min sem heartbeat ela vira FAILED ("interrompida") e libera a próxima.
  O alias antigo `POST /maintenance/optimize-images` mantém o contrato síncrono `{ message, itemsProcessed }` e usa a mesma trava.
- **Limpeza dos arquivos sem uso** (somente superadmin, manual, `POST /platform/maintenance/cleanup-uploads` com
  `mode: 'check'` ou `'delete'`; tipo `cleanup_uploads` em `maintenance_jobs`, sem migration):
  - Referências consideradas: `products.image` e `addons.image` (inclusive lixeira), `users.avatar` (inclusive
    contas apagadas) e `stores.logo`. A comparação usa o último trecho do caminho ou da URL, sem `?query`/`#`, em
    minúsculas, e cobre `nome`, `/uploads/nome` e `http(s)://host/uploads/nome`.
  - Só entram arquivos parados há mais de **24 h** (data de modificação), do primeiro nível da pasta, comuns
    (`lstat`: atalhos e pastas nunca são seguidos), com nome no padrão da API (começa com letra ou número, sem
    ocultos) e extensão de imagem. O resto (`.json`, `.txt`, `.env`...) é contado em `skipped` e nunca apagado.
    O caminho é conferido de novo antes de apagar (precisa estar na pasta de uploads).
  - No modo `delete`, cada lote de 100 é reconferido logo antes de apagar, no banco (formas exatas `nome`,
    `/uploads/nome`, `uploads/nome`, inclusive lixeira) e no disco (`lstat` e data). Falha ao apagar conta em
    `failed` e o log traz só o código do erro.
  - Uma limpeza por vez entre todas as instâncias (verificar e apagar dividem a trava; independente da
    otimização), com heartbeat, expiração em 10 min e desligamento iguais aos da otimização. O resumo
    (`job.summary`) e a auditoria guardam **só números**, nunca nomes ou caminhos. Os originais mantidos pela
    otimização viram candidatos depois de 24 h sem referência.
  - **Limpeza agendada** (`UPLOADS_CLEANUP_INTERVAL_HOURS`, desligada por padrão): cada instância confere a cada
    `min(intervalo, 5 min)` (timer `unref`, parado ao desligar o módulo). A execução vence 1 intervalo depois da última
    execução agendada registrada no banco (menos meia conferência de folga) e roda no modo `delete`, sem ator
    (`started_by` nulo), pela mesma trava e o mesmo índice único parcial da manual: se outra limpeza estiver rodando,
    espera a próxima conferência sem gravar auditoria de falha. Auditoria com escopo SYSTEM e `trigger: 'schedule'`;
    `summary.trigger` distingue `manual` e `schedule` (linhas antigas contam como manual).
    `GET /platform/maintenance/cleanup-uploads?include=schedule` → `{ job, schedule: { enabled, interval_hours,
    mode: 'delete', min_age_hours: 24, next_run_at (aproximado), last_run } }`; sem o parâmetro, `{ job }` como antes.
- Banner: `/promotions/banner` continua global (loja padrão/app); `/stores/:storeSlug/promotions/banner` usa o
  fuso da loja (cache por loja); os jogos de futebol têm um cache único da plataforma.

### 11.2 Pedidos e pagamentos

- Recurso de outra loja (pedido, pagamento, entregador, produto) → **404 uniforme**. Pedido de outro cliente → 404.
- `GET /orders/reports?from=AAAA-MM-DD&to=AAAA-MM-DD` (ADMIN, recurso `advanced_reports`, até 366 dias, fuso da
  loja): faturamento por dia (pedidos pagos e não cancelados), pedidos por status, por forma de pagamento,
  ticket médio e os 10 produtos mais vendidos (quantidade). `GET /orders/charts` também exige o recurso (403).
- Pedido com `delivery_address` (retrato) devolve `address: null`: o endereço do cliente é global e pode ter
  mudado depois. Os pedidos do cliente trazem `store: { id, slug, name, logo }`.
- `GET /stores/:storeSlug/orders/my-orders` lista só os pedidos daquela loja; `GET /orders/my-orders`, todos.
- `external_reference` dos pagamentos: `<plataforma>-loja-<storeId>-cliente-<userId>-<timestamp>` (o formato
  antigo continua reconhecido). Idempotência por loja + cliente + chave.
- Entrega: loja **sem zonas próprias** só entrega se for a loja padrão (zonas da plataforma,
  `DELIVERY_ZONES_*`); nas demais, a entrega é recusada e o perfil público mostra `delivery_enabled: false`
  até a loja configurar as zonas (com faixa padrão `fallback`). Lojas novas nascem com a entrega desligada.
- **Zona de entrega pelo CEP**: vale a primeira zona com o bairro (nome inteiro, sem acentos nem maiúsculas; com
  cidades, a mesma cidade) **ou** com o CEP do endereço numa das faixas (as faixas valem em qualquer cidade). O
  bairro e a cidade usados são os **canônicos do CEP** quando conferidos (`neighborhood_source = CEP`, mesmo que o
  digitado seja outro: evita taxa errada ou burla); CEP geral sem bairro = cidade do CEP + bairro digitado; CEP
  inexistente ou serviço fora do ar = os digitados (`MANUAL`). O retrato do pedido (`delivery_address`) continua com
  o que o cliente digitou. Conferência (`AddressLocationService`, pela busca de CEP existente: ViaCEP com BrasilAPI
  de reserva, num `CepLookupService` compartilhado): no cadastro; na edição (CEP mudou, nunca conferido ou serviço
  estava fora do ar); e no orçamento de entrega (endereço antigo não conferido, ou conferido com o serviço fora do ar
  há mais de 1 h; grava só se o CEP não mudou nesse meio-tempo). Nunca impede salvar nem orçar. Prazos: 3 s por
  serviço na conferência, 5 s na busca pública; sem internet, a primeira consulta pode levar ~6 s e depois cada
  serviço fica 60 s sem ser consultado.
- **Política para endereços fora das zonas** (`outside_zones`, padrão `fallback`): `fallback` cobra a taxa padrão;
  `refuse` recusa com 400 `DELIVERY_OUT_OF_AREA` no orçamento, no pedido pago na entrega e nas cobranças (seção 5.5).
  Pagamento já aprovado nunca é recusado (a recuperação usa o `fallback` gravado, ou o da plataforma).
- **CEP falso nos testes** (`CEP_LOOKUP_FAKE`, só com `NODE_ENV=test`): JSON `{ "<CEP de 8 dígitos>": { logradouro,
  bairro, localidade, uf, complemento? } | "unavailable" | null }` substitui ViaCEP e BrasilAPI na busca pública e na
  conferência. CEP fora do mapa = inexistente (404 / `NOT_FOUND`); `"unavailable"` = serviço fora do ar (502 /
  `UNAVAILABLE`); JSON inválido → erro no log e todos inexistentes. Em `NODE_ENV=test` **sem** a variável, a
  conferência não acessa a internet (fica `UNAVAILABLE`/`MANUAL`) e a busca pública continua indo à internet.
- **Pedido mínimo e frete grátis** (`applyOrderRules` em `src/orders/order-rules.ts`, função pura chamada por
  `OrderPricingService.price()`, o cálculo único do orçamento, do pedido e das cobranças): compara o **subtotal dos
  itens, com as promoções e sem a taxa**. A zona encontrada (ou a faixa de km) sobrescreve a loja campo a campo; fora
  das zonas (`fallback`, ou além do raio) valem os da loja. Frete grátis quando há taxa > 0 e o subtotal ≥ o valor
  (`free_delivery_applied` só nesse caso); o retrato do pedido, o valor do PIX e o pedido criado pela aprovação usam a
  taxa zerada. Retirada: nunca tem frete grátis e só tem mínimo com `min_order_takeout` (as zonas não valem). As regras
  só valem nas zonas **da própria loja**: a loja padrão nas zonas da plataforma (`DELIVERY_ZONES_*`) não tem mínimo nem
  frete grátis até salvar zonas próprias no painel. Decisões: `min_order` 0 na loja = sem mínimo (não gravado); 0 na
  zona é guardado (sem mínimo ou sempre grátis só nela); frete grátis menor que o mínimo é permitido (a tela só avisa).
- **Entrega por distância** (`src/orders/delivery-distance.ts`, funções puras): distância = linha reta (haversine, R =
  6371 km) entre o local da loja e as coordenadas do endereço × `route_factor` (padrão 1,3: as ruas nunca vão em linha
  reta), ou a distância real por rua (Google Routes `computeRoutes`, cabeçalho `X-Goog-Api-Key`, máscara
  `routes.distanceMeters`, prazo de 2 s, cache de 7 dias por instância) com `road_distance` e `GOOGLE_MAPS_API_KEY` (o
  fator não se aplica; sem rota, volta para a linha reta). A distância é arredondada para 1 casa e comparada nessa
  precisão: vale a primeira faixa com km ≤ `up_to_km` (2,0 cabe em "até 2 km"). Além da última faixa, com `max_km` e
  `extra_km_fee`: taxa da última faixa + cada km **iniciado** × `extra_km_fee`, com o prazo e as regras da última faixa.
  Além do raio, endereço sem coordenadas ou loja sem local: a política de fora da área (`fallback` ou 400; não
  localizado → `reason: ADDRESS_NOT_LOCATED`). Pagamento já aprovado nunca é recusado. As zonas continuam guardadas no
  modo distância; as zonas da plataforma são sempre por zona.
- **Localização dos endereços** (`GeocodingService` + `AddressGeoService` em `src/addresses`): cadeia configurável
  (`GEOCODING_PROVIDERS`, padrão Google → Nominatim → AwesomeAPI). Google Geocoding só com `GOOGLE_MAPS_API_KEY`;
  Nominatim (OpenStreetMap, sem chave) com busca estruturada sem o CEP (o OSM raramente tem CEP no Brasil), só
  resultados no nível da rua ou melhor (`place_rank ≥ 26`), User-Agent identificado (`GEOCODING_CONTACT`) e no máximo 1
  requisição a cada 1,1 s **por instância** (espera de até 1,5 s pela vaga); AwesomeAPI (`cep.awesomeapi.com.br`, sem
  chave) dá o centro do CEP (`ZIP_CENTER`). Prazo total da cadeia: 4 s no orçamento, 5 s ao salvar o endereço, 8 s no
  painel; até 2,5 s por provedor; provedor que falha fica 60 s sem ser consultado; cache em memória por instância
  (encontrado 24 h, não encontrado 1 h, até 5000 entradas) e consultas simultâneas do mesmo endereço compartilhadas.
  Quando localizar: no cadastro e na edição do endereço **só enquanto alguma loja com entrega ligada cobra por
  distância** (conferido com cache de 30 s; por padrão nenhuma chamada externa) e no orçamento do modo distância
  (endereço nunca localizado, ou `UNAVAILABLE` há 1 h ou mais). Grava só se CEP, rua e número não mudaram nesse
  meio-tempo; editar o endereço limpa as coordenadas antigas. Nunca impede salvar nem orçar. Decisão: as coordenadas
  enviadas pelo cliente (`latitude`/`longitude`) nunca definem a taxa (evita burla, como o bairro do CEP); a precisão
  `MANUAL` é aceita pelo banco, mas nenhuma rota a grava ainda.
- **Localização falsa nos testes** (`GEOCODING_FAKE`, só com `NODE_ENV=test`): JSON `{ "<CEP>": { lat, lng,
  precision?: 'ZIP_CENTER' } | "unavailable" | null }` no lugar dos provedores (CEP fora do mapa ou `null` = não
  encontrado; `"unavailable"` = provedores fora do ar; JSON inválido → erro no log e nada localizado). Em
  `NODE_ENV=test` sem a variável, nada é localizado (nenhuma chamada externa). A suíte E2E usa
  `e2e/support/geocoding-fake.ts` (CEPs `28970-xxx`).
- **Limites de pedido**: `POST /orders` pago na entrega consome `ORDER_CREATE` (chave loja + cliente) e
  `ORDER_CREATE_IP` (429). Um cliente pode ter numa loja no máximo N pedidos `PENDING` pagos na entrega, com
  N = o limite de `RATE_LIMIT_ORDER_CREATE` (padrão 10): o excesso recebe 429 `Você já tem N pedidos
  aguardando a confirmação desta loja. Aguarde a loja confirmar ou cancele algum antes de fazer outro.`
  Pedido com `paymentId` não conta nesse teto. `RATE_LIMIT_ENABLED=false` desliga o teto.
- **Troco**: no máximo R$ 200,00 acima do total. Acima disso → 400 `Valor para troco acima do permitido:
  informe até R$ X (no máximo R$ 200,00 acima do total do pedido).` O carrinho web valida o mesmo teto.
- **Adicionais**: produto sem adicionais configurados não aceita nenhum → 400 `O produto "X" não aceita
  adicionais.` (antes, lista vazia aceitava qualquer adicional; a vitrine web, o app e o painel já tratavam
  lista vazia como "sem adicionais"). Uma loja que dependia do comportamento antigo precisa marcar os
  adicionais no produto pelo painel.
- **Endereços**: cada conta tem no máximo 20 endereços ativos (os excluídos não contam). Acima disso → 400
  `Limite de endereços atingido: cada conta pode ter até 20 endereços. Exclua um endereço que não usa mais
  para cadastrar outro.` `POST` e `PATCH /addresses` consomem `ADDRESS_WRITE` (429). `GET /addresses`
  devolve no máximo 100.
- Contas da plataforma não fazem pedidos (`Contas da administração da plataforma não fazem pedidos. Use uma conta de cliente.`); a equipe
  também não (`ClientOnlyGuard`).
- **Limites do plano rígidos**: criar e restaurar produto, aceitar convite, criar equipe pelo ADMIN (`POST /users`)
  e restaurar membro da equipe usam uma trava consultiva por loja e contam dentro da transação (`lockAndAssert`):
  duas operações simultâneas no limite exato não passam juntas. A espera pela trava é de no máximo 5 s
  (`lock_timeout` só durante a espera) → 409 `Outra alteração da loja está em andamento. Tente de novo em
  instantes.` Na criação de produto, um adicional inválido (400) é conferido antes do limite (403).
  `max_monthly_orders` continua "suave" (reservas na seção 7). Não há limite de taxa para criar produto por JSON:
  com o limite rígido, `max_products` não é mais burlado (planos ilimitados são intencionais).
- **Número do pedido**: atribuído pelo banco (seção 3.3), independente por loja (a loja B começa em 1 mesmo
  que a loja A já tenha 500 pedidos); o pedido criado pelo pagamento aprovado também recebe o número. O campo é
  `insert: false, update: false` na entidade e sai em todas as visões do presenter (gestão, cozinha,
  entregador, cliente, Meus Pedidos, histórico do cliente). As telas mostram `Pedido #<number>`; o `id` fica
  só interno.
- **Bloqueio de cliente pela loja**: conferido em `OrderPricingService.price()` (o cálculo único usado pelo
  orçamento, pelo pedido e pelas cobranças), com 403 genérico, sem o motivo. Pagamento já aprovado continua
  virando pedido, inclusive um PIX gerado antes do bloqueio e pago depois (a loja cancela e estorna no quadro);
  a recuperação de pagamento aprovado (`POST /orders` com `paymentId`) não é recusada. As cobranças pendentes
  do cliente na loja **não** são canceladas ao bloquear (pendência, seção 12). Desbloquear devolve o acesso na
  hora.

### 11.3 Identidade

- ADMIN de loja não gerencia contas de clientes nem da plataforma (404). Restaurar ou apagar a conta de um
  cliente é feito pelo superpainel.
- Trocar a própria senha/e-mail encerra as outras sessões e a resposta traz um `access_token` novo.
  O app mobile (fora do escopo) não lê esse campo: depois da troca, ele volta para o login.
- `POST /auth/forgot-password` responde 202 sempre; o e-mail sai em segundo plano pelo driver configurado.
- **E-mail transacional** (`src/notifications`): `mail-config.ts` lê `MAIL_DRIVER`, `SMTP_*` e `MAIL_FROM`
  (valores inválidos viram problemas listados, nunca exceções); `MailService.send()` nunca lança e devolve
  `{ delivered, driver, messageId?, error? }`. O transporte SMTP é criado no primeiro envio, reaproveitado e
  recriado se a criação falhar. Prazos: 10 s para conectar, 10 s para a saudação e 30 s no socket. Com usuário e
  senha e `SMTP_SECURE` desligado, STARTTLS é obrigatório (as credenciais nunca trafegam sem criptografia). As
  mensagens levam `Auto-Submitted: auto-generated`. Uma falha gera uma linha de log sem usuário nem senha
  (mascarados também em base64) e o fluxo continua: o convite é criado e o link aparece no painel; o
  "esqueci a senha" continua 202. A criação de convite (`POST /platform/stores`,
  `/platform/stores/:id/invitations`, `/store/invitations`) **espera** o envio SMTP (com o servidor fora do ar,
  até ~10 + 10 + 30 s); o "esqueci a senha" não espera (já roda em segundo plano). Na subida
  (`MailService.onModuleInit`), avisos para driver de log em produção, SMTP incompleto e `MAIL_DRIVER`
  desconhecido; com o driver de log em produção, só destinatário e assunto vão para o log, nunca o conteúdo ou o
  link.
- **E-mails em texto e HTML** (`multipart/alternative`; `src/notifications/mail-layout.ts`, `renderMail`): o HTML usa
  tabelas com estilos inline, até 600 px e fluido no celular, sem scripts, fontes, folhas de estilo ou imagens
  externas além do logo da loja. É acessível: `lang` pt-BR, `role=presentation` nas tabelas de layout, um único
  `h1`, texto de 16 px e contraste AA, com botão e links derivados da cor da marca pelas mesmas regras da vitrine
  (`mailPalette`). **Marca** (`mail-brand.ts`): o convite e a redefinição de senha de contas da equipe usam nome,
  cor (`#RRGGBB` válida; senão o laranja da plataforma) e logo da loja; o e-mail de teste, a redefinição de clientes
  e superadmins e os avisos de conta usam a marca Comestra (`BRAND.name`, `#ea580c`, monograma). O logo só entra
  com `PUBLIC_API_URL` e só a partir de um nome de arquivo de `/uploads` (nunca URL externa); sem ele, monograma com
  a inicial. Todo texto de pessoas e lojas é colocado em uma linha (sem controles, quebras nem marcas de direção) e
  escapado; nos e-mails com a marca da loja, o nome da loja é "desarmado" (o ponto de um domínio vira `[.]` e `://`
  vira `[:]//`, para não virar link clicável; nomes comuns como "Sr. Burger 2.0" não mudam). Os únicos links são os
  do site (`APP_WEB_URL`: mesma origem e caminho base, sem usuário nem senha); outro endereço é descartado do
  e-mail, com erro no log. Os assuntos não mudaram (agora numa linha). Com o driver de log, só a versão em texto vai
  para o log. Limitações: os logos são WebP (o Outlook clássico do Windows não os exibe; o nome da loja continua ao
  lado) e muitos clientes bloqueiam imagens remotas até a pessoa liberar.
- **Links do superpainel com SMTP** (fail-closed): com `MAIL_DRIVER=smtp` configurado, `POST /platform/users/:id/password-reset`
  e `POST /platform/stores/:id/invitations` mandam o link **só** por e-mail (`url: null`, `delivered: true`; o operador
  nunca vê o link, o que mantém o suporte somente leitura). Se o envio falha → 503 e nenhum link vale (a redefinição
  não é gerada; o convite é revogado). Sem SMTP, o link aparece uma vez para o operador (`delivered: false`), como
  antes. Contas com `platform_role` não recebem link pelo superpainel (403; use "Esqueci minha senha" ou o comando
  `platform:superadmin`). A mesma regra vale para o convite do responsável na criação da loja (`POST /platform/stores`):
  com SMTP, o link vai só por e-mail (`url: null`, `delivered: true`); se o envio falhar, a loja é criada e a resposta traz um aviso.
- Um único convite em aberto por loja + e-mail (índice único parcial); criar outro substitui o anterior
  (`invitation.revoke` com `reason: 'superseded'` e `replaced_by`).
- **Limites diários de convites da loja** (contados no banco; o superpainel fica fora deles): 3 por destinatário
  **por loja** em 24 h (o reenvio conta) e 100 por loja em 24 h → 429 e tentativa auditada. Somando todas as lojas e o
  superpainel, a partir de 10 convites ao mesmo e-mail em 24 h o convite da loja é criado **sem e-mail** e o link
  volta com aviso (`message`; `metadata.mail_skipped`). Decisão: não recusar, para que uma loja hostil não bloqueie o
  empregador de verdade; a caixa de entrada fica protegida em no máximo ~10 e-mails de convite por dia. Vazamento
  residual: a loja percebe que o endereço já recebeu muitos convites quando o aviso aparece.
- **Convite de troca do responsável** (`make_owner`): pendente, só o superpainel o cancela (a loja recebe 403 ao
  cancelar e 409 ao convidar o mesmo e-mail; vencido, pode ser substituído), e o e-mail do convidado fica protegido
  contra a equipe da **mesma** loja (seção 5.2). Convites comuns criados pelo superpainel continuam canceláveis pela
  loja.
- **Desativar a loja** também expira os links de redefinição pendentes de toda a equipe dela; restaurar a loja não os
  traz de volta.
- **Esqueci a senha**: no máximo 3 links por conta em 24 h (`FORGOT_PASSWORD_RECIPIENT_DAILY_LIMIT`, contado no banco,
  vale entre instâncias e reinícios; o excedente é silencioso e auditado como DENIED `recipient_limit`).
- **Política de senha**: validada em tempo linear (`meetsPasswordComposition`; a expressão regular antiga permitia
  ReDoS); regra e mensagens iguais às de antes. Peculiaridade mantida por compatibilidade: só a última linha conta, e
  pontos no início dela não contam como símbolo.
- **Convites**: `GET /invitations/:token` e o aceite conferem quem convidou (ADMIN ativo da mesma loja ou
  superadmin ativo; conta excluída de vez invalida), com trava `FOR SHARE` no aceite. Senão → 404
  `Convite inválido, expirado ou já utilizado...`. Rebaixar, mandar para a lixeira ou bloquear um ADMIN
  cancela os convites pendentes dele (`invitation.revoke` com `reason` `inviter_demoted`, `inviter_removed`
  ou `inviter_blocked`). `/platform/stores/:id/invitations` continua mostrando quem convidou.
- **Enumeração de contas**: o cadastro, os convites e a troca de e-mail pela rota antiga ainda respondem 409 quando
  o e-mail já existe (contrato usado pelo web, pelo app e pelos testes). A exposição fica contida por limites
  (`SIGNUP` antes do corpo, `TEAM_WRITE`, `CREDENTIALS_CHANGE`) e pela auditoria dos 409. A troca de e-mail pelas rotas
  `/account/*` já responde igual para endereço livre, em uso ou reservado (seção 11.9); a neutralidade completa
  depende do modo `strict` (fase 1b).

### 11.4 Assinaturas (provedor MANUAL)

- Renovação e fim do teste geram fatura com vencimento no início do período: na rodada seguinte da rotina a
  assinatura fica PAST_DUE (a loja continua vendendo durante a tolerância) até o superadmin registrar o pagamento.
- Assinatura suspensa não renova; ao reativar com o período encerrado, abre um período novo. Reativação
  forçada pelo superadmin move o vencimento das faturas em aberto para agora.
- Suspensão pela plataforma (`suspended_by = PLATFORM`) não é desfeita por pagamento: a fatura é quitada e a
  loja continua suspensa até a reativação (seção 6).
- Troca de plano vale na hora, sem proporcionalidade; downgrade só se o uso couber no novo plano.
- Cancelamento imediato anula só faturas de períodos futuros. Pagamento menor que a fatura (ou após o
  cancelamento) não quita nada e fica registrado para conferência.
- Uma fatura válida (não anulada) por período da assinatura (índice único parcial).
- Sem âncora de cobrança: o dia de renovação pode escorregar nos dias 29 a 31 (31/01 → 28/02 → 28/03).

**Provedor `MERCADO_PAGO`** (assinaturas da plataforma):

- Cobrança recebida com a assinatura `CANCELED` → além de `PAYMENT_AFTER_CANCEL`, a API tenta de novo cancelar a
  preapproval no Mercado Pago.
- Cobrança vinda de uma preapproval diferente da registrada (órfã), com a registrada autorizada ou a assinatura
  cancelada → a órfã é cancelada no Mercado Pago (evento `PROVIDER_STATUS_CHANGED` com `orphan: true`; falha →
  `PROVIDER_SYNC_FAILED` com `action: 'cancel_orphan'`); o pagamento continua sendo aplicado.
- A rotina tenta de novo cancelar no provedor as assinaturas canceladas cujo `provider_status` não é `cancelled`, com
  intervalo de 1 h que dobra a cada falha até 24 h (sem credencial do provedor, não tenta); sucesso →
  `subscription.lifecycle.provider_canceled`. Os candidatos são lidos em **rodízio** (cursor em memória por
  instância; um reinício recomeça do id 0), então 200 ou mais falhas permanentes não deixam de fora uma assinatura
  cancelada depois.
- Alerta crítico `CANCELED_STILL_BILLED` no dashboard: autorização ainda ativa no Mercado Pago e/ou cobranças depois
  do cancelamento nos últimos 90 dias, com o valor a devolver (`data { subscription_id, provider_active, payments,
  amount }`).
- **Checkout** (`POST /store/subscription/checkout`): serializado por loja com `pg_try_advisory_xact_lock`. Quem
  encontra a trava ocupada solta a conexão, espera 250 ms fora da transação e tenta de novo, até 12 vezes (~3 s),
  reaproveitando o link pendente; depois disso, 409 `CHECKOUT_IN_PROGRESS`. Limite `SUBSCRIPTION_CHECKOUT` por loja.
  Quem segura a trava ainda chama o provedor dentro da transação (até 15 s): no máximo uma conexão por loja (risco
  aceito, seção 12). A chave de idempotência continua aleatória: com a trava, não há duplicatas.

### 11.5 Variáveis adicionais

`MP_PUBLIC_KEY` (chave pública da conta do `MP_ACCESS_TOKEN`, só para a loja padrão), `APP_WEB_URL` (links de
convite, redefinição e dos e-mails de conta), `PUBLIC_API_URL` (logo das lojas nos e-mails), `RATE_LIMIT_CEP_LOOKUP`
(padrão 60/60 s), `SWAGGER_ENABLED`, `SAAS_BILLING_INTERVAL_MS` (padrão 300000, mínimo 10000),
`PIX_EXPIRATION_MINUTES` (padrão 30; de 30 min a 30 dias), `UPLOADS_CLEANUP_INTERVAL_HOURS` (limpeza agendada),
`CEP_LOOKUP_FAKE` (só em test), e as da entrega por distância: `GOOGLE_MAPS_API_KEY`, `GEOCODING_PROVIDERS`,
`GEOCODING_CONTACT`, `GEOCODING_NOMINATIM_URL` e `GEOCODING_FAKE` (só em test). As variáveis de sessão, conta, banco,
desempenho e localização estão na seção 9.
Lista completa e comentada: `backend/.env.example`.

### 11.6 Superpainel (contratos)

Todas as rotas `/platform/**` exigem o token **normal** do superadmin (`@PlatformRoute()`); o token de sessão de
suporte e qualquer perfil de loja recebem 403, e anônimo 401. Listas: `{ items, total, page, pageSize }`
(`pageSize` máx. 100). Alterações devolvem o estado atualizado + `warnings: string[]` (troca de slug, domínio
próprio ainda não roteado, loja padrão desativada/suspensa, `DEFAULT_STORE_SLUG` com prioridade, troca de slug da
loja do `DEFAULT_STORE_SLUG`, slug que já foi de outro estabelecimento `#id`).

- **Slugs antigos**: ao trocar o slug, o endereço antigo fica reservado para sempre em `store_slug_history` (último
  dono). O autoatendimento recusa com 409 "em uso"; o superpainel pode reutilizá-lo, com o aviso "já foi de outro
  estabelecimento (#id)", também na criação. Renomear a loja do `DEFAULT_STORE_SLUG` gera aviso: as rotas antigas e o
  app deixam de achá-la até atualizar o env (sem loja, as rotas antigas falham fechado). Não há redirecionamento do
  slug antigo (seção 12).
- **Dashboard e financeiro** reaproveitam o último resultado por `PLATFORM_INSIGHTS_CACHE_MS` (padrão 30 s; mesma
  forma, números até 30 s atrasados).

| Rota | Observações |
|---|---|
| `GET /platform/stores` | `search` (nome, slug, razão social, e-mails, domínio; dígitos do documento só quando o termo parece número: dígitos, espaços e `()+./-`), `account_status`, `plan_id`, `subscription_status` (inclui `NONE`), `sort=created_at\|name\|slug`, `order`. Itens com responsável, plano, assinatura, `staff_count`, `orders_30d`, `gmv_30d` (janela móvel de 30 dias) |
| `POST /platform/stores` | Cria loja (fechada, entrega desligada) + assinatura na mesma transação + convite do responsável (sem SMTP, `invitation.url` exibida uma vez com `delivered: false`; com SMTP, `url: null` + `delivered: true` + `message` e o link vai só por e-mail; falha no envio ou no convite → aviso em `warnings`). `store`/`owner` enviados como lista → 400 (também em `POST /stores/signup`). E-mail do responsável reservado por uma troca recente → 409 |
| `GET/PATCH /platform/stores/:id` | Detalhe sem segredos (uso, limites, `storage`, recursos, pagamentos, `access`, `is_default_store`); PATCH de dados administrativos, slug, domínio e responsável (ADMIN ativo da loja) |
| `POST /platform/stores/:id/{suspend,reactivate,deactivate,restore}` | `reason` obrigatório para suspender/desativar; transição inválida → 409; nada é apagado |
| `GET /platform/stores/:id/{users,metrics,audit,invitations}` | Equipe (com lixeira), métricas diárias no fuso da loja (`from`/`to`, máx. 366 dias), auditoria da loja, convites |
| `POST /platform/stores/:id/invitations`, `DELETE /platform/invitations/:id` | Convite com `make_owner` (exige ADMIN); revogação. Na listagem, `status` aceita maiúsculas ou minúsculas. Resposta `{ invitation, url, delivered, warnings }` (+ `message` quando entregue): com SMTP e envio aceito, `url: null` e `delivered: true`; com SMTP e envio recusado, 503 `Não foi possível enviar o convite por e-mail, então ele foi cancelado...` e o convite é revogado; sem SMTP, `url` como antes e `delivered: false`. Fora dos limites diários da loja |
| `POST /platform/stores/:id/support-sessions` | `reason` (10 a 300 caracteres) → `{ access_token, expires_at, session }`; o token vale como ADMIN **somente leitura** da loja (e de toda a API) até expirar ou ser encerrado |
| `GET /platform/support-sessions`, `POST /platform/support-sessions/:id/end` | Lista (filtros por loja, operador, ativas) e encerramento idempotente (exige o token do superpainel). O próprio operador também encerra o suporte com o token de suporte (`POST /auth/logout`, `via = 'logout'`) ou encerrando a sessão `SUPPORT` na lista de sessões do superadmin (`DELETE /auth/sessions/:id`, `via = 'session_revoke'`) |
| `GET /platform/users`, `GET /platform/users/:id` | Busca global (perfil, loja, papel global, bloqueados, lixeira; dígitos do telefone só quando o termo parece número; com `pg_trgm`, pelos índices de trigramas); detalhe com eventos de autenticação recentes. As duas leituras são auditadas (`platform.users.list` / `.view`), assim como `GET /platform/stores/:id/users` (`platform.store.team.view`) |
| `POST /platform/users/:id/{block,unblock,revoke-sessions,password-reset}` | Bloquear exige motivo (não a própria conta). `password-reset` → `{ url: string \| null, delivered, expires_at, message }`: sem SMTP (driver de log), `delivered: false` e o link uma vez, como antes; com SMTP, `delivered: true`, `url: null` e o link vai só ao e-mail da conta (a `message` mostra o e-mail mascarado). 403 `Contas da administração da plataforma não recebem link pelo superpainel...` para contas com `platform_role`; 503 `Não foi possível enviar o link por e-mail, então nenhum link foi gerado...` quando o SMTP falha. Validade real na mensagem (`RESET_TOKEN_TTL_MINUTES`, hoje 60 min) |
| `GET /platform/auth-events` | Eventos `auth.*` da auditoria (usuário, e-mail, resultado, período) |
| `GET /platform/dashboard` | Lojas, assinaturas, MRR, ARR (`projection: true`), churn (6 meses, mês atual parcial), pedidos, **GMV** e **receita da plataforma** (blocos separados), distribuição por plano, alertas (`PAST_DUE_GRACE_ENDING`, `SUBSCRIPTION_SUSPENDED` com `data.suspended_by`, `REFUND_PENDING`, `INVOICE_FAILED`, `NO_ACTIVE_ADMIN`, `STORE_SUSPENDED`, `TRIAL_ENDING`, `ONLINE_PAYMENTS_WITHOUT_CREDENTIALS`, `INACTIVE_STORE_BILLED` com `data.subscription_status`, `CANCELED_STILL_BILLED` crítico com `data { subscription_id, provider_active, payments, amount }`) |
| `GET /platform/finance` | Receita SaaS, faturas por status, MRR/ARR, GMV, top 10 lojas por GMV, inadimplência (`from`/`to`, padrão 12 meses) |
| `GET /platform/subscriptions/:id` | Loja, plano, uso, eventos e faturas. `access` é a situação **atual** da loja (calculada pela assinatura vigente dela, mesmo ao consultar uma assinatura antiga); `limits` é `null` em assinatura cancelada (não vale mais para a loja) |
| `POST /platform/stores/:id/subscription` | Cria a assinatura de uma loja sem assinatura vigente (409 se já houver) |
| `POST /platform/subscriptions/:id/{suspend,reactivate}` | Transição inválida → 409 (antes 400). `suspend` grava `suspended_by = PLATFORM`; numa assinatura já SUSPENDED por BILLING, responde 200 e converte a origem para PLATFORM (já suspensa pela plataforma continua 409) |
| `POST /platform/subscriptions/:id/cancel` | `reason` obrigatório no cancelamento imediato (`at_period_end` false ou ausente, ou sem período a vencer): 400 `Informe o motivo do cancelamento imediato.` Com `at_period_end` sobre um agendamento da loja, grava um novo `CANCEL_SCHEDULED` (`scheduled_by: PLATFORM`, `from_scheduled_by: STORE`) em vez de não fazer nada. As respostas de `/platform/subscriptions/*` trazem `cancel_scheduled_by` e `storage` |
| `POST /platform/subscriptions/:id/change-plan` | O 409 de downgrade pode incluir a violação `{ key: 'storage_mb', label: 'MB de armazenamento', limit, usage }` |
| `GET/POST /platform/plans`, `GET/PATCH /platform/plans/:id` | `max_storage_mb` (inteiro ≥ 1 ou `null` = ilimitado; texto numérico aceito); inválido → 400 `O limite de armazenamento (MB) deve ser um número inteiro a partir de 1 (ou null para ilimitado).` |
| `POST /platform/subscriptions/:id/resume` | Desfaz o cancelamento agendado (`cancel` com `at_period_end`); 409 sem agendamento, em assinatura cancelada ou com o período já encerrado. Também pelo ADMIN da loja em `POST /store/subscription/resume` |
| `GET /platform/invoices`, `POST /platform/invoices/:id/mark-paid` | Lista com `status` e busca por loja. Registro manual idempotente; `provider_payment_id` único (o mesmo pagamento nunca quita duas faturas); `paid_at` opcional (padrão: agora) e nunca no futuro (folga de 5 min para o relógio) |
| `POST /platform/invoices/:id/{mark-failed,void}` | `reason` obrigatório: 400 `Informe o motivo da recusa do pagamento.` / `Informe o motivo da anulação.` As respostas de `mark-paid`, `mark-failed` e `void` trazem a linha relida do banco (`updated_at` real) |
| `GET /platform/audit` | Filtros: loja, ator, resultado, escopo, período, **ação** — nome exato ou grupo, respeitando os segmentos do nome (`plan` traz `plan` e `plan.*`, nunca `platform.*`; `auth.login` traz `auth.login.success` e `auth.login.failure`; terminado em ponto, como `plan.`, só o grupo) — e **alvo** (`target_type` + `target_id`, ex.: `user` + `12`; `target_id` sem `target_type` → 400). Os mesmos filtros valem em `GET /platform/stores/:id/audit` |
| `GET/PATCH /platform/settings` | Loja padrão, tolerância (0-60 dias), sessão de suporte (5-240 min), autoatendimento e seu plano (ACTIVE e público). A resposta (também a do PATCH) traz o campo aditivo `mail: { driver: 'log'\|'smtp', smtp_configured, from, smtp: { host, port, secure, auth } \| null, issues: string[] }`, montado a partir do ambiente da API (não do banco) e sem usuário nem senha do SMTP |
| `POST /platform/settings/test-email` | `{ to }` (aparado e em minúsculas; inválido ou ausente → 400 `Informe um e-mail válido para o teste.`; campo extra → 400) → 200 `{ to, driver, delivered, message_id, error, message }`. Falha do SMTP não é erro HTTP (`delivered: false` + `error` com o motivo e a dica de correção). 5 por 10 min por operador (`RATE_LIMIT_TEST_EMAIL`, em memória por instância) → 429 `Muitos e-mails de teste em pouco tempo. Aguarde alguns minutos e tente de novo.` Auditoria `platform.settings.test_email` |
| `POST /platform/maintenance/cleanup-uploads` | `{ mode: 'check' \| 'delete', confirm?: boolean }` → 202 `{ job }` (`kind: 'cleanup_uploads'`, `RUNNING`). 400: modo ausente ou inválido (`Informe o modo da limpeza: check (só verificar) ou delete (apagar os arquivos sem uso).`), `delete` sem `confirm: true` (`Para apagar os arquivos sem uso, confirme com confirm: true.`), `confirm` não booleano (`confirm deve ser true ou false.`) ou campo extra. 409 `Já existe uma limpeza de arquivos em andamento. Aguarde a conclusão.` com o `job` em andamento |
| `GET /platform/maintenance/cleanup-uploads` | `{ job \| null }`: a última verificação ou exclusão. `job.summary = { mode, min_age_hours (24), files_scanned, in_use, recent, orphans, orphan_bytes, deleted, deleted_bytes, failed, skipped, trigger }` (só números; em `delete`, ao final, `orphans = deleted + failed`; `trigger` `manual` ou `schedule`). Com `?include=schedule`: `{ job, schedule }` (seção 11.1) |
| `GET /platform/maintenance/store-credentials` | `{ total, current (v2), legacy (v1), unknown }` (nada é decifrado) |
| `POST /platform/maintenance/store-credentials/reencrypt` | 200 `{ total, migrated, already_current, changed, failed, failed_store_ids }` (até 100 ids, só na resposta), idempotente: regrava v1 como v2 (AAD `store:<id>`) com `UPDATE` condicional (id + valor lido), não toca os já v2 e atualiza `stores.updated_at` só nas lojas regravadas. Sem `CREDENTIALS_ENCRYPTION_KEY` em produção → 503 `A chave de criptografia das credenciais (CREDENTIALS_ENCRYPTION_KEY) não está configurada: nenhuma credencial foi regravada.` (auditoria FAILURE) |
| `POST /stores/signup` (público) | `{ store: { name, slug }, owner: { name, email, password, phone? }, accept_terms: true }` → `{ access_token, user }`; 404 quando o autoatendimento está desligado |

Notas de metodologia: MRR e churn usam o preço **atual** de cada plano (não há histórico de preço); cancelamentos
durante o teste grátis não entram no churn; a inadimplência considera todas as faturas OPEN/FAILED vencidas.

### 11.7 Segurança HTTP, credenciais e SPA

**Cabeçalhos da API** (`setupApp`, sem `X-Powered-By`), em toda resposta: `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: cross-origin` e, em
produção, `Strict-Transport-Security`. CSP: na API, `default-src 'none'; frame-ancestors 'none'`; em
`/uploads`, `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; sandbox`; no Swagger
(`/api`), só `frame-ancestors 'none'`. Com `TRUST_PROXY` vazio, a API avisa uma vez no log ao receber
`X-Forwarded-For` ou `Forwarded`. `TRUST_PROXY=true` é tratado como 1 salto, com aviso: com `true`, o Express
usaria a entrada mais à esquerda do `X-Forwarded-For`, que é a escrita pelo cliente (Nginx
`$proxy_add_x_forwarded_for`, ALB, Cloudflare e ngrok só acrescentam o IP real), e qualquer um furaria os limites
por IP e forjaria o IP da auditoria. O `proxy-addr` ≥ 2.0.8 corrige a sub-rede IPv4-mapeada em IPv6 com prefixo
curto (`::ffff:10.0.0.0/8` confiava em qualquer IP); mesmo assim, use `10.0.0.0/8`.

**CORS** (`corsOptionsDelegate` no `app-setup.ts`): `Access-Control-Allow-Credentials: true` com
`Access-Control-Allow-Origin` exato só para as origens de credencial (`AUTH_COOKIE_ORIGINS` ou `CORS_ORIGINS` explícito
+ origem de `APP_WEB_URL`; em development/test sem `APP_WEB_URL`, `http://localhost:5173`); as demais origens seguem a
regra de antes, sem credenciais. `Access-Control-Max-Age: 600` para todas.

**Dependências** (`backend/package.json`): `overrides` para `body-parser ^2.4.0`, `multer ^2.5.0` e `proxy-addr ^2.0.8`
(o `@nestjs/platform-express` 11.2.8 fixa o multer 2.4.0, ainda vulnerável): remover quando o Nest/Express publicarem
essas versões. O `body-parser` continua com `inflate` (aceita corpos comprimidos) por compatibilidade. Em produção,
0 vulnerabilidades altas ou críticas no backend; as moderadas restantes só se resolvem com versão maior (seção 12).

**Credenciais Mercado Pago das lojas** (`common/crypto/secret-box.ts`): AES-256-GCM com tag de 16 bytes
obrigatória. A gravação (`store-settings.service.ts`) usa o formato v2 (`encryptStoreSecret`), que vincula o
valor à loja com AAD `store:<id>`: um valor copiado para outra loja não decifra. A leitura (gateway em
`payment.service.ts` e a dica mascarada das configurações) usa `decryptStoreSecret`, que também aceita o
formato v1 gravado antes do vínculo. Um valor v1 passa a v2 quando a loja salva as credenciais de novo ou pela
ação do superpainel (Configurações → Manutenção → Credenciais do Mercado Pago;
`POST /platform/maintenance/store-credentials/reencrypt`, com `upgradeStoreSecret`): idempotente, com gravação
condicional, sem expor o token, e as lojas com credenciais ilegíveis aparecem só na resposta (a auditoria guarda
só contagens).

**SPA (frontend web)**:

- **Transporte da sessão** (`services/api.ts`, `VITE_AUTH_TRANSPORT`): no modo padrão (`auto`), as emissões pedem a
  sessão em cookie (`X-Auth-Transport: cookie` + credenciais). O token de acesso curto fica **só na memória da aba**
  (no modo cookie, `comestra.token` não existe); o `localStorage` guarda só o marcador sem segredo
  `comestra.session = { v: 1, sid, uid }` e o usuário, para as abas se acompanharem. Cada aba renova o próprio token
  (`POST /auth/web/refresh`) na subida, a 80% da validade, antes de uma chamada quando faltam menos de 30 s, no
  foco/visibilidade/`online` e depois de um 401 (uma vez, repetindo a chamada), com uma promessa única por aba e o
  Web Lock `comestra:refresh` entre abas. Uma renovação recusada sem chamada recusada (subida, timer, foco, antes da
  chamada) é "quiet": na vitrine e na conta do cliente a aba só fica sem login, sem aviso; as rotas protegidas levam
  ao login; no painel e no superpainel, `/login` com "Sua sessão expirou". `SESSION_EXPIRED_EVENT` passa a ser
  `CustomEvent` com `detail { quiet }`. O modo bearer (token de 7 dias no `localStorage`, como antes) vale para sessões
  antigas até expirarem, para a sessão de suporte, quando a API responde `session_transport: 'bearer'` (ex.: site e
  API em sites diferentes, LAN por IP ou túnel cross-site, detectados pelo `Sec-Fetch-Site`) e com
  `VITE_AUTH_TRANSPORT=bearer` (kill switch, exige build novo). `PATCH /users/:id` e `POST /account/password` só pedem
  cookie quando a aba já está em cookie; login, aceite de convite e cadastro de loja sempre pedem e saem sem a
  sessão da aba. "Sair" chama `POST /auth/web/logout`.
- **Suporte iniciado numa sessão em cookie**: nada do superpainel fica guardado na aba (sem stash); o token de suporte
  continua bearer no `localStorage`, com prioridade sobre o marcador. Encerrar ou expirar o suporte volta ao superpainel
  pelo refresh, mesmo depois de recarregar a página (o refresh responde 409 enquanto o suporte estiver aberto).
- **Sessão por aba**: cada aba envia o token da sessão que exibe, guardado em memória. Login, saída, troca de
  conta e início ou fim de suporte feitos em outra aba são acompanhados (evento `storage`, foco, visibilidade
  e conferência antes de cada chamada): a aba remonta as telas, avisa (`A sessão mudou em outra aba: agora
  você está como …` ou `Você saiu da conta em outra aba.`) e, no painel ou superpainel, vai para a página
  inicial do perfil ou para `/login`. Chamadas pedidas pela tela antiga são canceladas com a mensagem
  `A sessão deste navegador mudou em outra aba…`.
- **Sair da conta** (`signOut`) apaga, além de token e usuário, os carrinhos de todas as lojas
  (`comestra.cart.<id>` e a chave antiga `comestra.cart`) e `comestra.lastStore`; o tema fica. A expiração
  da sessão (401) não apaga o carrinho. `signOut({ keepLocalData: true })` preserva os dados de compra.
  A sessão local é limpa na hora e, em seguida, `POST /auth/logout` é chamado com o token que estava em uso,
  como melhor esforço (timeout de 5 s; 204 ou 401 contam como sucesso), sem travar a saída.
- **Sessão de suporte**: o token do superpainel fica só na memória da aba que iniciou o suporte (a chave
  `comestra.platformSession` deixou de ser usada; valores antigos são migrados para a memória e apagados).
  "Encerrar e voltar ao superpainel" e "Sair do Sistema" durante o suporte encerram a sessão de suporte **com o
  próprio token de suporte** (`POST /auth/logout`), na hora, mesmo depois de recarregar a página.
  "Encerrar e voltar" troca a sessão da aba antes de chamar a API; sem o superpainel guardado na aba, vai para
  `/login`. A chave `comestra.supportSessionToEnd` (só `{ id, expires_at }`) ficou como último recurso, quando a
  API não confirma o encerramento: a sessão de suporte é encerrada no próximo login do superadmin.
- **Sessões ativas** (seção 8): em Meus Dados e no menu lateral do painel e do superpainel (oculto em sessão de
  suporte), com "Encerrar" por sessão e "Sair de todos os aparelhos". A carga em segundo plano usa
  `keepSessionOn401`.
- **CSP**: o build de produção (`vite build`) injeta `<meta http-equiv="Content-Security-Policy">` e
  `<meta name="referrer" content="strict-origin-when-cross-origin">`. O Vite de desenvolvimento não tem CSP.
  A política é gerada com a origem de `VITE_API_URL` (por isso o build precisa da URL real da API), os
  domínios do Mercado Pago (`*.mercadopago.com[.br]`, `*.mercadolibre.com`, `*.mercadolivre.com[.br]`,
  `*.mlstatic.com`), Iconify (`api.iconify.design`, `api.simplesvg.com`, `api.unisvg.com`) e os avatares
  (`cdn-icons-png.flaticon.com`). O `img-src` também inclui `https://tile.openstreetmap.org` (`MAP_TILE_SOURCES`):
  só as imagens do mapa do local da loja no painel; o Leaflet (script e CSS) vem no próprio bundle e nenhuma chamada
  `fetch`/XHR sai para o OpenStreetMap. O mapa mostra a atribuição exigida ("© OpenStreetMap"). O Dockerfile do web lê
  a CSP do `index.html` gerado pelo build, então não precisou mudar.
- **Cabeçalhos para o servidor que hospeda o build** (o `vite preview` já os envia; ver `securityHeaders()` em
  `frontend-web/vite.config.ts`): `Content-Security-Policy` (a mesma da meta + `frame-ancestors 'none'`),
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy: camera=(), microphone=(), geolocation=(), usb=()`; em HTTPS, também
  `Strict-Transport-Security: max-age=31536000; includeSubDomains`. `frame-ancestors` e `X-Frame-Options` só
  funcionam como cabeçalho, nunca pela meta.
- **Mercado Pago com CSP**: a tokenização do cartão funciona. O script inline de perfil do dispositivo
  (antifraude) que o SDK injeta fica bloqueado, a menos que o servidor gere um nonce por resposta
  (`'nonce-…'` no `script-src` e `<meta property="csp-nonce" nonce="…">`); o front repassa esse nonce ao SDK
  (`deviceProfileCspNonce`). O SDK não é carregado para contas da equipe nem da plataforma (`O pagamento com
  cartão não fica disponível para contas da equipe ou da plataforma.`), e o painel e o superpainel recarregam
  o documento se o SDK tiver sido injetado antes nele.

### 11.8 Limites de tentativas e de abuso

Em memória, por instância (`RateLimitService`), formato `RATE_LIMIT_<NOME>=limite/segundos`; `RATE_LIMIT_ENABLED=false`
desliga todos (inclusive o teto de pedidos pendentes pagos na entrega). As chaves por IP agrupam o IPv6 por /64.

| Política | Padrão | Chave | Observação |
|---|---|---|---|
| `LOGIN_FAILURES` | 10/900 | IP + e-mail | Força bruta numa conta |
| `LOGIN_FAILURES_IP` | 100/900 | IP | Várias contas do mesmo endereço |
| `LOGIN_FAILURES_ACCOUNT` | 50/3600 | conta (e-mail), somando os IPs | Atingido o teto, só a senha **certa** vinda de um IP com sessão ativa da conta entra; senha errada → o mesmo 429 de qualquer origem |
| `LOGIN_SUCCESS` | 200/600 | IP + e-mail | Logins certos (cada um roda o bcrypt, cria sessão e grava auditoria) |
| `FORGOT_PASSWORD` | 5/900 | IP | "Esqueci a senha" (mais o teto de 3 links por conta em 24 h, no banco) |
| `TOKEN_REDEEM` | 20/900 | IP | Links de redefinição, convite e `/account/*`, reservado antes da consulta |
| `SIGNUP` / `STORE_SIGNUP` | 30/3600 · 5/3600 | IP | Cadastro público de clientes / autoatendimento de lojas |
| `CEP_LOOKUP` | 60/60 | IP | Busca pública de CEP |
| `ORDER_CREATE` / `ORDER_CREATE_IP` | 10/600 · 60/600 | loja + cliente · IP | `ORDER_CREATE` também é o teto de pedidos `PENDING` pagos na entrega por cliente e loja |
| `PAYMENT_CREATE` / `PAYMENT_CREATE_IP` | 10/600 · 60/600 | loja + cliente · IP | Cobranças novas do delivery (repetir a `idempotencyKey` não conta) |
| `PAYMENT_WEBHOOK` | 300/60 | IP | Webhook do delivery |
| `UPLOAD` | 30/600 | conta (ou IP sem login) | Cada imagem recebida e cada multipart que falha no parse |
| `ADDRESS_WRITE` | 30/600 | conta | Criação e edição de endereços |
| `TEAM_WRITE` | 30/600 | loja | Equipe, convites e troca do e-mail de um membro pelo ADMIN |
| `CREDENTIALS_CHANGE` | 10/900 | conta e IP | Trocas da própria senha ou e-mail que falharam (também em `/account/*`) |
| `ACCOUNT_EMAIL` | 5/3600 | conta | Pedidos de verificação e de troca do próprio e-mail → 429 |
| `ACCOUNT_EMAIL_TARGET` | 3/3600 | endereço de destino | Silencioso: acima dele nada é enviado. Não vale para os avisos de segurança ao dono da conta |
| `REFRESH` | 120/300 | IP | `POST /auth/web/refresh` (cada aba ativa renova a cada ~12 min) |
| `SUBSCRIPTION_CHECKOUT` | 10/600 | loja | Links de pagamento da assinatura |
| `TEST_EMAIL` | 5/600 | operador | E-mail de teste do superpainel (fora do `RATE_LIMIT_POLICIES`) |

Contados **no banco** (valem entre instâncias e reinícios, sem variável): "esqueci a senha" (3 links por conta em
24 h, silencioso) e convites da loja (3 por destinatário na loja e 100 por loja em 24 h → 429; 10 por destinatário
somando as lojas → convite sem e-mail). Riscos aceitos (seção 12): CGNAT em IPv4 (os limites por IP podem bloquear
todos atrás do mesmo endereço pela janela), o `Map` dos limites sem LRU (o crescimento é contido pelos limites por IP
e pela varredura a cada minuto) e o dono que atinge o teto por conta sem sessão ativa no mesmo IP (espera até 1 h ou
usa "Esqueci minha senha").

### 11.9 Conta: verificação e troca de e-mail (modo `compat`)

Fase 1a do plano de verificação de e-mail (`src/account`). Tudo roda no modo `compat` (`ACCOUNT_SECURITY_MODE`): as
rotas usadas pelo app mobile não mudam de contrato. Os links são de uso único e o banco guarda só o SHA-256 do código
(`account_email_tokens`); validades: verificação 48 h, troca 24 h, "Não fui eu" 7 dias. Os avisos saem em segundo
plano pelo `renderMail`, com a marca da loja para a equipe e a da plataforma para os demais; não há fila (uma falha
de SMTP é registrada uma vez).

- **Troca de e-mail pelo site** (`POST /account/email-change`): só acontece depois da confirmação no endereço novo. A
  resposta é idêntica para endereço livre, em uso ou reservado; ao endereço em uso vai só o aviso "e-mail em uso"
  (marca da plataforma, sem link); a um endereço reservado por outra conta nada é enviado (só a auditoria FAILURE
  `email_reserved`). Confirmar encerra todas as sessões.
- **"Não fui eu"**: o endereço antigo recebe, junto do aviso (com o endereço novo mascarado), um link que por 7 dias
  desfaz a troca com uma senha nova, encerra as sessões e cancela todos os links da conta. Nesses 7 dias o endereço
  antigo fica **reservado** (409 para outras contas no cadastro, convite, aceite, equipe, troca da própria conta e
  criação de loja). Risco aceito: quem controla a caixa antiga tem esse poder por 7 dias (como no Google/GitHub).
- **Rota antiga** `PATCH /users/:id` (própria conta, `compat`): mantém a troca imediata, o 409 e o `access_token`, com
  `email_verified_at = null`, `REVERT` + `VERIFY` e os avisos. Toda troca de senha avisa o dono. O ADMIN que troca o
  e-mail ou a senha de um membro gera um aviso informativo (sem desfazer) e a verificação do endereço novo; o
  endereço antigo do membro não fica reservado.
- **Verificação** (`POST /account/email-verification`): link de 48 h; o cadastro de cliente já o envia. "Esqueci minha
  senha" confirma o e-mail; links gerados pelo superpainel não. Contas do seed de demonstração (e-mails fictícios
  `@comestra.com.br`) nascem confirmadas, e `npm run seed` grava `COALESCE(email_verified_at, now())`; superadmins
  **criados** pelo comando `platform:superadmin` nascem confirmados (o operador do servidor é a raiz de confiança);
  `--promote-existing` mantém o estado da conta.
- **Bloqueio de conta**: cancela os links `CHANGE` e `VERIFY` abertos, mas mantém o `REVERT` (o dono do endereço antigo
  ainda pode recuperá-la; a conta continua bloqueada).
- **Emissão de sessão**: `POST /account/password` emite o token pelo `SessionTokenService.issue` dentro da requisição
  (ponto único `AccountSecurityService.issueSession`), o mesmo caminho do login: recebe a sessão em cookie da seção 11.10.
- **Modo `strict`** (fase 1b) ainda não existe: `ACCOUNT_SECURITY_MODE=strict` só gera um aviso na subida.
- Com `MAIL_DRIVER=log` em produção, a troca de e-mail pelo site não se completa (o link só vai para o log, sem o
  conteúdo); a rota antiga (app) continua funcionando.

### 11.10 Sessão do site em cookie (refresh rotativo)

MVP do plano de refresh token. Chaves de desligamento: `AUTH_WEB_COOKIE=false` (imediato, sessões novas) e
`VITE_AUTH_TRANSPORT=bearer` (build).

- **Pedido**: só quando a requisição traz `X-Auth-Transport: cookie` (cabeçalho próprio: força o preflight),
  `Origin` da lista de credenciais (quando vem) e `Sec-Fetch-Site` diferente de `cross-site` (quando vem). O
  `SessionIssuanceInterceptor` decide o transporte antes do handler; depois de gravar a sessão, envia o `Set-Cookie`,
  encerra a sessão do cookie anterior deste navegador (`reason: 'replaced'`, exige o validador atual ou o anterior de
  uma família aberta e da versão atual da conta: o seletor sozinho não basta) e acrescenta `session_transport` e
  `expires_in` ao corpo. Handler com erro ou gravação com falha: nenhum cookie.
- **Cookie**: `__Host-comestra_rt` (`HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, sem `Domain`) em produção — mesmo
  atrás de um proxy que fala http com a API — ou em qualquer requisição HTTPS; `comestra_rt` sem `Secure` só em http
  fora de produção (ex.: Docker local em `http://localhost:8080`). Valor `v1.<seletor 16 B base64url>.<validador 32 B
  base64url>`; o banco guarda só o SHA-256 do validador (`refresh-token.ts`). `Max-Age` = tempo até
  `auth_sessions.expires_at` (`AUTH_SESSION_MAX_AGE`; a rotação não estende). Nunca aparece em corpo, log ou auditoria.
- **Família** = a linha de `auth_sessions` (`transport = COOKIE`); `jti` do token de acesso = a sessão. Rotação por
  `UPDATE` condicional (gera seletor/validador novos e guarda o hash anterior); o validador anterior ainda vale por
  `AUTH_REFRESH_GRACE_SECONDS` (corrida entre abas ou resposta perdida: 200 sem `Set-Cookie`). **Reuso** de um
  validador já trocado fora da tolerância → a família inteira é encerrada (o token de acesso dela cai na hora, pelo
  `jti`) e `auth.refresh.reuse` é auditado.
- **Suporte**: a sessão de suporte é sempre bearer e grava `parent_session_id` = sessão do superadmin; enquanto ela
  estiver aberta, o refresh da sessão-mãe responde 409. `POST /auth/logout` com o token de suporte nunca apaga o
  cookie (o cookie é da sessão do superadmin).
- **Recusas do refresh**: 401 apagando o cookie (inclusive equipe de loja `INACTIVE`, que o login já recusa); o
  `expires_in` nunca passa do fim da sessão. `POST /auth/web/logout` é idempotente (sempre 204) e não tem limite.
- **Topologia**: o modo cookie exige site e API no mesmo site (same-origin via proxy em `/api`, preferido, ou `app.` e
  `api.` no mesmo domínio), HTTPS em produção e `CORS_ORIGINS`/`APP_WEB_URL` exatos. Em desenvolvimento, web :5173 e
  API :3000 em `localhost` são o mesmo site; LAN por IP ou túneis em domínios diferentes voltam sozinhos ao bearer.
  Em produção sem nenhuma origem explícita, o modo cookie fica desligado (aviso na subida).

### 11.11 Desempenho e índices

Medido com volume (200 lojas, 400 mil pedidos, 800 mil itens, 100 mil clientes, 300 mil registros de auditoria):

- **Relatórios e métricas**: os formatadores de data por fuso (`Intl.DateTimeFormat`) passaram a ter cache por fuso
  (`dateKeyInZone`, `startOfDayInZone` em `orders/order-rules.ts`). `GET /orders/reports` de 365 dias caiu de ~23 s para
  ~1,3 s, e o `/health` disparado durante a chamada, de 23 s para menos de 1 s; `/platform/stores/:id/metrics` de 365
  dias, de 21,5 s para 1,6 s; gráficos, de 586 ms para 20 ms de CPU por chamada.
- **Quadro de pedidos** (`scope=active`, consultado a cada 5 s pelo web e pelo app): consulta pelo índice parcial dos
  pedidos abertos (104 ms → 0,3 ms) e cache por loja de 30 s só para os dados de outras tabelas (CPU do Node por poll
  de 66 ms para 14 ms; com compressão, de 480 KB para 15 KB).
- **Banco**: `DB_POOL_SIZE` (padrão 10, o mesmo do driver), `statement_timeout` de 60 s na API
  (`DB_STATEMENT_TIMEOUT_MS`; as migrations da subida e o CLI usam uma conexão própria, sem o limite; combina com o
  `proxy_read_timeout` de 60 s do Nginx do Docker) e espera máxima de 30 s por uma conexão livre
  (`DB_POOL_ACQUIRE_TIMEOUT_MS`; esgotada → 500 `timeout exceeded when trying to connect`). Decisão: 60 s, e não os 30 s
  sugeridos, para não abortar tarefas longas legítimas.
- **Índices novos** (seção 3.3): login de 36 ms para 0,16 ms; endereços de 16 ms para 0,12 ms; reservas do limite mensal
  de 61 ms para 0,13 ms; conciliação de 61 ms para 4,8 ms; página da auditoria de 138 ms para 0,19 ms; FKs de 60–78 ms
  para 0,01–0,03 ms; busca de contas de 108 ms para 2,6 ms (com `pg_trgm`).
- **Superpainel**: dashboard e financeiro com cache de `PLATFORM_INSIGHTS_CACHE_MS` (30 s).
- **HTTP**: compressão das respostas (`compression`, acima de 1 KB), teto explícito do corpo JSON (100 KB; 2 MB em
  `/store/settings`, medido: 50 zonas × 200 bairros de 80 caracteres dão ~1 MB, até 2 MB com acentos) e cache de 30
  dias nos `/uploads`.
- **Com várias instâncias**, os caches do quadro e do superpainel e os limites de tentativas valem por instância.

### 11.12 Docker (mesma origem)

`docker-compose.yml` sobe `db` (PostgreSQL 18, rede interna), `api` e `web` (Nginx); guia em [`docker.md`](docker.md).
Contrato de implantação (sem mudança na API): o navegador fala com **uma única origem**. `/api/<rota>` chega à API
sem o prefixo (`/api/health` → `/health`), `/uploads/<arquivo>` chega a `/uploads/<arquivo>` da API e o resto é o SPA
(rotas desconhecidas → `index.html`; arquivos ausentes em `/assets/` → 404). O site é gerado com `VITE_API_URL=/api`
(relativa: funciona por `localhost`, IP da máquina ou domínio HTTPS sem novo build; o `'self'` da CSP já cobre). A API
fica atrás de exatamente um proxy (`TRUST_PROXY=1`; `2` com um proxy HTTPS na frente). Decisões: modo demonstração
local = `NODE_ENV=development`, `SEED_DEMO_SUPERADMIN=false`, `SWAGGER_ENABLED=false` (atrás do prefixo `/api` o
Swagger aponta para o servidor errado) e porta só em `127.0.0.1`; a senha do superadmin nunca vai para o
`.env.docker` (o arquivo entra inteiro no ambiente da API). O Nginx do `web` registra o acesso com o `log_format
comestra`, sem `Cookie`, `Set-Cookie` nem `Authorization` e com os tokens dos links de uso único trocados por
`[redacted]` no caminho e no `Referer`; roda com `cap_drop: ALL` mais `CHOWN`, `DAC_OVERRIDE`, `SETGID`, `SETUID` e
`NET_BIND_SERVICE`. Em `/api/` o Nginx não comprime (`gzip off`) e só repassa a resposta já comprimida pela API.

## 12. Pendências conhecidas (decisões adiadas)

Resumo técnico; a lista para a operação, com recomendações, está em [`operacao.md`](operacao.md#10-limitações-conhecidas-e-pendências).

| Tema | Situação atual | Evolução recomendada |
|---|---|---|
| Token de acesso | **Site resolvido** (seção 11.10): token de acesso de 15 min só na memória da aba e refresh rotativo em cookie `HttpOnly`, com detecção de reuso e revogação no servidor da sessão substituída por um login novo no mesmo navegador. Tokens sem `jti` só na janela de `JWT_LEGACY_ISSUED_BEFORE`. Continuam com o token de 7 dias (`JWT_EXPIRES_IN`): o app mobile, as sessões bearer antigas até expirarem, a sessão de suporte e o site quando a API responde `bearer` (site e API em sites diferentes) | Fase 2 do plano: troca imediata do token legado por cookie; sessão deslizante e limite de ociosidade; token compartilhado entre abas (`BroadcastChannel`); `last_used_at` em `GET /auth/sessions`; superpainel em origin próprio; refresh no app mobile (`POST /auth/app/refresh`) e o app chamar `POST /auth/logout` ao sair; recusar tokens sem `jti` (`AUTH_REQUIRE_JTI`); token CSRF double-submit |
| Sessões registradas | Teto de 100 sessões ativas por conta. Sem "último acesso" por sessão (para não gravar no banco a cada requisição); limpeza só na emissão (sessões mortas da conta + lote de 5000 vencidas no máximo 1 vez por hora por instância) | Coluna `last_seen_at`; limpeza global periódica pelo agendador da manutenção (o mesmo da limpeza de uploads), junto da purga dos `account_email_tokens` mortos |
| Webhook do delivery | Sem validação de `x-signature` (cada loja precisaria do próprio segredo). Reconsulta também pagamentos aprovados (estornos e contestações) | Guardar `mp_webhook_secret` cifrado por loja e validar `x-signature`/`x-request-id` antes de consultar o MP |
| Bloqueio de loja | PIX pendentes de loja bloqueada são cancelados pela conciliação (até 60 s por rodada, 10 por loja) | `cancelPendingForStore(storeId)` chamado nas ações de suspender/desativar loja e assinatura |
| Bloqueio de cliente pela loja | Disponível (seção 5.3), mas as cobranças pendentes (PIX ou cartão em análise) do cliente naquela loja não são canceladas ao bloquear, e o bloqueio é contornado com uma conta nova. A loja não vê nem cancela as cobranças online em andamento | Cancelar na hora as cobranças pendentes do cliente ao bloquear e cancelamento em lote auditado; mostrar "uso + reservas" no uso do plano. Contra contas novas: verificação de e-mail (fase 1b) → telefone verificado para pagar na entrega nas lojas com bloqueios → bloqueio por telefone normalizado + alertas para a equipe |
| Número do pedido | Sem busca nem filtro por número no painel; as respostas de pagamento não trazem o número (a confirmação busca o pedido); o app mobile mostra o `id` | `GET /orders?number=`; `number` nas respostas de pagamento; app mobile com o número da loja |
| Estorno pendente | Fica para a equipe (alerta `REFUND_PENDING`) | Rotina de nova tentativa com recuo exponencial e auditoria |
| Preapproval SaaS | Assinatura suspensa pela plataforma continua sendo cobrada pelo MP (o pagamento quita a fatura, não reativa). Cancelada: novas tentativas de cancelamento no provedor e alerta `CANCELED_STILL_BILLED`. Falhas permanentes (404 do provedor) continuam no rodízio | `pause/resumeSubscription` no `BillingProvider`, validado no sandbox do MP; marcar falhas permanentes como `provider_status` terminal (`needs_manual`); chave de idempotência determinística na `createPreapproval` (defesa extra) |
| Checkout da assinatura | Serializado por loja (seção 11.4), mas quem segura a trava chama o provedor **dentro** da transação: no máximo uma conexão por loja por até 15 s. Com muitas lojas pagas fazendo checkout durante uma lentidão do Mercado Pago, o pool ainda pode encher (amenizado por `SUBSCRIPTION_CHECKOUT` e `DB_POOL_ACQUIRE_TIMEOUT_MS`) | Migration `1793493000000` com `subscriptions.provider_checkout_lock_until`: (a) `UPDATE` condicional que reserva por 30 s (`lock_until IS NULL OR lock_until < now()`) `RETURNING`, ocupado → reler e reaproveitar o link ou 409; (b) `createCheckout` fora de qualquer transação; (c) `UPDATE` com o resultado que limpa a reserva (ou só limpa, na falha). A trava consultiva deixa de ser usada no checkout |
| Limites | Em memória, por instância (inclusive o do e-mail de teste, fora do `RATE_LIMIT_POLICIES`). CGNAT em IPv4: `LOGIN_FAILURES_IP` (100/15 min), `FORGOT_PASSWORD` (5/15 min) e `TOKEN_REDEEM` (20/15 min) podem bloquear todos atrás do mesmo endereço pela janela. `Map` sem LRU (um despejo deixaria o atacante zerar o próprio balde; o crescimento é contido pelos limites por IP e pela varredura a cada minuto) | Armazenamento compartilhado (Redis) com CAPTCHA ou chaves de dispositivo; levar `TEST_EMAIL` para o `RATE_LIMIT_POLICIES` |
| Login com o teto por conta | Com `LOGIN_FAILURES_ACCOUNT` atingido, a origem conhecida só se distingue com a senha certa e todo 429 tem o mesmo tempo. Risco aceito: a tentativa errada da origem conhecida consome a cota `LOGIN_FAILURES_IP`/`LOGIN_FAILURES` daquele IP; um atacante na mesma rede que esgote essa cota e compare com uma conta de controle ainda infere a sessão ativa (mais caro e ruidoso). O dono sem sessão ativa no mesmo IP espera até 1 h ou usa "Esqueci minha senha" | Trocar o IP como prova de origem por uma credencial de dispositivo (o cookie de refresh do site ou um cookie de dispositivo lembrado, e um cabeçalho equivalente no app): com o teto atingido, só quem a apresenta passa para a conferência da senha |
| E-mail transacional | SMTP (nodemailer) implementado; o padrão continua `log`. Texto + HTML com a marca da loja (convite e redefinição da equipe) ou da plataforma, logo só com `PUBLIC_API_URL` (WebP). Uma falha é registrada uma vez, sem nova tentativa; avisos de conta sem fila; STARTTLS obrigatório com credenciais e prazos de 10/10/30 s fixos; a criação de convite espera o envio SMTP | Fila de envio (outbox) com novas tentativas; provedores por API (SES, SendGrid, Mailgun), assinatura DKIM, pool de conexões SMTP e tratamento de bounces; logo também em PNG/JPEG para clientes sem WebP; pré-visualização dos e-mails no superpainel; remetente (`<Loja> via Comestra`) ou `Reply-To` por loja; texto próprio para o convite do responsável (`make_owner`); neutralizar texto com cara de URL nos nomes de pessoas; `SMTP_REQUIRE_TLS` e `SMTP_TIMEOUT_MS` opcionais |
| Conta e credenciais da equipe | Fase 1a da verificação de e-mail em modo `compat` (seção 11.9). O ADMIN ainda define senha/e-mail de membros; `current_password` opcional fora da plataforma e do site; respostas 409 em cadastro e convite. O cadastro self-service de loja envia ao dono o link de verificação do e-mail em segundo plano, e o convite do responsável na criação da loja (`POST /platform/stores`) segue a regra do SMTP (a tela `StoreNew` mostra "Convite enviado por e-mail"); `email_verified_at` não aparece no detalhe do superpainel. Um ADMIN ainda pode "reservar" e-mails de outras pessoas (conta da equipe + lixeira). "Não fui eu" dá 7 dias de poder a quem controla a caixa antiga (risco aceito) | Fase 1b: `POST /auth/register` (201 compat / 202 strict), `POST /users/:id/password-reset` pelo ADMIN, `delivered` em `POST /store/invitations`, o modo `strict` e a execução E2E em `strict`; equipe pendente até verificar, conta da equipe nunca usada na lixeira não reserva o e-mail (ou é purgada depois de N dias, com ação no superpainel) e alerta para lojas que descartam muitas contas; verificação no autoatendimento de lojas; `deliverOnlyByEmail` no convite da criação da loja quando a `StoreNew` tratar `{ url: null, delivered: true }` |
| Troca do responsável (`make_owner`) | O e-mail do convidado é protegido contra a equipe da mesma loja (seção 5.2). Risco aceito: o cadastro público (`POST /users` anônimo) e o ADMIN de outra loja ainda podem ocupar o e-mail (recusar ali criaria um oráculo de convites pendentes) | Opção "conta existente" no `make_owner` (quem tem o e-mail entra, ou redefine a senha pelo e-mail, e aceita) ou transferência para uma conta verificada depois da fase 1b; purgar da lixeira uma conta da equipe nunca usada. Decisão de produto: o que acontece com uma conta CLIENT que vira ADMIN |
| Convites e leituras no superpainel | Limites diários por loja e teto sem e-mail somando as lojas (seção 11.3). Leituras de contas e equipes auditadas, mas `GET /platform/auth-events`, `GET /platform/audit` e a lista de lojas não; sem limite por operador nem alerta de volume | Alerta de volume de convites e e-mails por loja; limite por operador nas leituras e alerta de volume (ex.: mais de 1000 contas por hora); motivo obrigatório para busca sem filtro ou com `include_deleted`; auditoria de leitura nas rotas restantes |
| Credenciais Mercado Pago da loja | Qualquer ADMIN, não só o responsável, troca ou remove as credenciais (auditado em `store.payments.update/remove`) | E-mail ao responsável a cada troca feita por outro ADMIN (modelo novo em `notifications`); alternativa mais restrita: exigir o responsável ou `current_password` (decisão de negócio) |
| Slug antigo | Reservado para sempre em `store_slug_history`, sem redirecionamento | `GET /stores/<antigo>` → slug atual e `/loja/<antigo>` no SPA (contrato novo + frontend) |
| Arquivos | Cota por loja e limpeza agendada **entregues** (seção 11.1). A cota usa cache por instância (até 5 min de atraso; com várias instâncias, uploads simultâneos podem passar um pouco do limite); a troca do logo só devolve o espaço na próxima medição. A reconferência antes de apagar procura só as formas exatas (uma URL completa gravada entre a varredura e a exclusão não seria vista; risco pequeno: arquivo parado há 24 h). Avatares do cadastro sem prefixo de dono; avatares externos antigos continuam no banco; arquivos antigos sem prefixo `s<id>-` não contam para nenhuma loja | Tabela compartilhada de contabilidade (`store_storage_usage`) com incrementos e reconciliação periódica; medição em segundo plano; `max_storage_mb` nos planos públicos e no cadastro de loja; alerta de armazenamento no dashboard e coluna na lista de lojas; script para zerar avatares fora da lista permitida e prefixo de dono nos avatares do cadastro |
| Frete por CEP | Zona pelo bairro do CEP (ViaCEP/BrasilAPI, cache por instância) e por faixas de CEP, mais a política de recusa. O retrato do pedido e as telas da equipe mostram só o bairro digitado; endereço já conferido não é reconferido se a base de CEPs mudar (só ao editar); os nomes de bairro dos Correios podem diferir dos populares (a loja cadastra os dos Correios ou usa faixas); o app mobile mostra a mensagem do 400, mas não conhece o `code` nem o bairro do CEP | Lista pública de bairros e faixas atendidos e selo "Entrega só nos bairros atendidos" na vitrine; bairro do CEP no pedido para a equipe; reconferência periódica e cache de CEP compartilhado (Redis) |
| Pedido mínimo e frete grátis | Disponíveis (seções 5.3 e 11.2). (a) Loja só de retirada só tem mínimo depois de cadastrar zonas de entrega (as regras moram no JSON da entrega); (b) uma zona não desliga o frete grátis da loja, só aumenta o valor; (c) as telas da equipe e o pedido não mostram que o frete grátis valeu (só `delivery_fee` 0); (d) o app mobile mostra "Grátis" e a mensagem do 400, sem aviso antes de enviar; (e) uma página web desatualizada (cache antigo) que salva a seção Entrega descarta as regras, porque a tela remonta o JSON | Campo ou coluna própria para o mínimo da retirada; opção "sem frete grátis nesta zona"; taxa original e frete grátis no retrato do pedido e no detalhe para a equipe; aviso no app mobile |
| Entrega por distância | Disponível (seções 5.3 e 11.2). (a) As telas da equipe, o detalhe e o retrato do pedido não mostram a distância nem a faixa (só o orçamento e o carrinho); (b) o app mobile mostra o 400 (inclusive `ADDRESS_NOT_LOCATED`), mas não a distância; (c) o Nominatim tem 1 requisição por segundo **por instância** e caches por instância; (d) não há correção manual das coordenadas de um cliente (`MANUAL` reservado); (e) o simulador recebe CEP e número e completa o resto pela busca de CEP; (f) a ferramenta de localizar e o simulador usam o limite `CEP_LOOKUP` (por loja), não um limite próprio; (g) os serviços gratuitos (Nominatim, AwesomeAPI) não têm disponibilidade garantida: fora do ar, o endereço segue a regra de fora da área e é tentado de novo depois de 1 h; (h) com `GOOGLE_MAPS_API_KEY`, as coordenadas do Google ficam gravadas no endereço sem prazo e o ponto da loja aparece num mapa do OpenStreetMap: confira os termos do Google Maps Platform (limite de cache e uso fora de um mapa do Google) antes de ligar em produção (`operacao.md`, seção 8.4) | Distância e faixa no retrato do pedido e nas telas da equipe; correção manual das coordenadas pela loja; limite de taxa próprio para as ferramentas do painel; fila compartilhada do Nominatim entre instâncias (ou `GEOCODING_NOMINATIM_URL` próprio); prazo de validade das coordenadas por provedor (`geo_source = GOOGLE`); distância no app mobile |
| Desempenho | Índices, caches e pool da seção 11.11. Ainda sobram ~0,5 s de event loop num relatório de um ano de uma loja com 200 mil pedidos (parse das linhas e GC); `GET /store/customers` leva ~0,6 s com 200 mil pedidos; o histórico pagina por `OFFSET` (até 10 mil páginas); a auditoria cresce sem limite; com várias instâncias, os caches valem por instância | Agregar relatórios e métricas no SQL (`GROUP BY` dia no fuso da loja; adiado pelo risco com `created_at` sem fuso, que pede testes de borda de horário de verão); agregados diários para o superpainel e estatísticas por cliente (índice coberto, cache ou tabela); paginação por cursor (aditiva) e rota incremental `?updated_since=` para o quadro (e `?recent_limit=` só no web); retenção ou arquivamento da auditoria; caches compartilhados (Redis) |
| Uploads e parse | Multer 2.5 com limites de nome, aninhamento e índice (seção 11.1); o `UPLOAD` conta a falha só no fim do parse; `TOKEN_REDEEM` e `STORE_SIGNUP` são consumidos depois do `ValidationPipe` | Reserva atômica da vaga antes de ler o corpo (`RateLimitService.take`, junto da atualização dos dublês nos specs de usuários); mover `TOKEN_REDEEM` e `STORE_SIGNUP` para guards (defesa em profundidade; não é mais necessário com a validação de senha linear) |
| Dependências | Backend: 0 altas/críticas; `overrides` de `body-parser`, `multer` e `proxy-addr`. Moderadas restantes só com versão maior: `typeorm` 0.3 (glob/minimatch; a SQLi de `orderBy` é só MySQL), `@nestjs/swagger` 11 (js-yaml; Swagger desligado em produção), `mercadopago` 2 (uuid). Frontend web: 0 em produção (`--omit=dev`); 12 moderadas só de desenvolvimento (minimatch via eslint 9/typescript-eslint 8). E2E: 0 | Rodada dedicada às versões maiores (`typeorm` 1.x, `@nestjs/swagger` 12, `mercadopago` 3.6, eslint 10) com a suíte completa; remover os `overrides` quando o Nest publicar as versões corrigidas |
| Docker | Funciona com mesma origem (seção 11.12). O `db` ainda recebe o `.env.docker` inteiro e a API conecta como superusuário do banco; a imagem da API tem ~555 MB | `db` só com `POSTGRES_PASSWORD` (arquivo `.env.docker.db` ou Docker secret com `POSTGRES_PASSWORD_FILE`); papel `comestra_app` sem superusuário, dono do schema `public` e sem `pg_execute_server_program` (script em `/docker-entrypoint-initdb.d` nos volumes novos e SQL documentado nos existentes; antes, conferir se alguma migration faz `CREATE EXTENSION` não confiável); imagem menor (sem `.d.ts`/`.map`); script para gerar o `.env.docker` |
| Exposição de desenvolvimento | `HOST` disponível (padrão `0.0.0.0` mantido por causa do app mobile na rede local); `/health` só com `status`; segredo JWT de desenvolvimento aleatório por instalação; logins das contas de demonstração aceitos de qualquer origem | Padrão loopback em development quando o app não depender da rede local; recusar logins de demonstração fora da rede local |
