# Comestra SaaS — Instalação, migração e operação

Guia prático para instalar a plataforma do zero, atualizar uma instalação existente, aplicar as migrations,
criar e recuperar o superadministrador, configurar, operar e publicar em produção. Decisões e contratos:
[`arquitetura.md`](arquitetura.md). Todos os comandos rodam a partir da raiz do repositório, salvo indicação.

## 1. Requisitos

- Node.js 22+ e PostgreSQL 14+ (testado no 18), com `pg_dump`/`pg_restore` para os backups.
- Dependências instaladas em `backend/` e `frontend-web/` (`npm install` em cada pasta).
- Para os testes E2E: Google Chrome instalado e `npm install` em `e2e/`.
- O app mobile (`frontend-mobile/`) não faz parte desta fase; ele continua funcionando pelas rotas antigas,
  na loja padrão.

## 2. Instalação do zero

### 2.1 Desenvolvimento

```bash
createdb -U postgres comestra            # ou o nome que for usar em DB_DATABASE
cd backend
cp .env.example .env                     # Windows: Copy-Item .env.example .env
#   edite o .env: NODE_ENV=development e DB_PASSWORD (deixe DB_SYNCHRONIZE vazio = false)
npm install
npm run start:dev                        # aplica as 13 migrations na subida (DB_MIGRATIONS_RUN) e cria a demo

cd ../frontend-web
npm install
npm run dev                              # http://localhost:5173
```

Num banco vazio, com `NODE_ENV=development`, a subida cria os dados de demonstração (seção 6): a
**Lanchonete Demo** (`/loja/demo`, loja padrão, aberta, plano interno gratuito), a equipe demo dessa loja e um
cliente demo, todos com senhas públicas. O superadmin de demonstração **não** é criado em development: crie o
seu pelo comando da seção 5 (ou ligue `SEED_DEMO_SUPERADMIN=true` numa máquina isolada).

Para conferir: `http://localhost:3000/health` responde `{"status":"ok"}` (sem nome nem versão; a versão fica
no Swagger), o Swagger fica em `http://localhost:3000/api` e `cd backend && npm run migration:show` lista as 13
migrations com `[X]`. O log da subida mostra `API Comestra escutando em 0.0.0.0:3000 (todas as interfaces:
acessível pela rede local)` (seção 7.2). Sem `JWT_SECRET`, a primeira subida em development cria um segredo
aleatório desta máquina em `backend/.temp/dev-jwt-secret` (fora do Git; seção 7).

### 2.2 Com Docker

Para subir banco, API e site com um comando (`docker compose up -d --build`, site em `http://localhost:8080`), veja
[`docker.md`](docker.md): primeira subida, contas, backup, HTTPS e solução de problemas. O resto deste guia vale
para a instalação sem Docker; as variáveis são as mesmas (no Docker ficam no `.env.docker` da raiz).

### 2.3 Produção

```bash
createdb -U postgres comestra
cd backend
npm ci
npm run build
#   .env ou variáveis do servidor: NODE_ENV=production, JWT_SECRET, CREDENTIALS_ENCRYPTION_KEY, DB_*,
#   CORS_ORIGINS, APP_WEB_URL, PUBLIC_API_URL, TRUST_PROXY (atrás de proxy), MAIL_DRIVER=smtp + SMTP_* + MAIL_FROM
#   — ver a seção 9
npm run migration:run:prod               # ou deixe DB_MIGRATIONS_RUN ligado (padrão) com uma única instância
npm run platform:superadmin:prod -- --email=ops@suaempresa.com.br --name="Nome Sobrenome"
npm run start:prod                       # sempre com NODE_ENV=production

cd ../frontend-web
npm ci
VITE_API_URL=https://api.suaempresa.com.br npm run build   # a CSP do build usa esta URL (ou /api, mesma origem)
#   sirva frontend-web/dist com rewrite da SPA e os cabeçalhos de segurança (seção 9)
```

Em produção nenhum dado de demonstração é criado (`SEED_DEMO_USERS=true` é ignorado, com erro no log). Depois
da primeira subida, entre em `/login` com o superadmin (vai para `/platform`) e configure a plataforma
(seção 8): configurações, planos, lojas e convites dos responsáveis.

## 3. Atualizar uma instalação existente

### 3.1 Antes de começar

1. **Backup do banco e das imagens**:

   ```bash
   pg_dump -U postgres -Fc comestra > comestra-AAAAMMDD.dump
   # cópia completa no mesmo servidor (sem conexões abertas no banco de origem):
   createdb -U postgres -T comestra comestra_backup_AAAAMMDD
   # restaurar, se precisar:
   createdb -U postgres comestra_restaurado && pg_restore -U postgres -d comestra_restaurado comestra-AAAAMMDD.dump
   ```

   Copie também a pasta `UPLOADS_DIR` (padrão `backend/uploads`). Faça o `pg_dump` **sempre** antes de uma
   atualização com migrations novas: algumas preenchem dados a partir do histórico (`StoreSlugHistoryAndCancelOrigin`)
   e o `down()` de outras apaga dados ou encerra as sessões de todos (seção 4).
2. **`DB_SYNCHRONIZE=false`** (ou vazio, que é o padrão) no `backend/.env`, inclusive em desenvolvimento.
   Com `true`, o TypeORM roda **depois** das migrations e cria por fora delas os índices, colunas e CHECKs que
   as entidades declaram: o banco fica diferente do de produção, uma migration esquecida passa despercebida e o
   synchronize pode até apagar colunas. Bancos de desenvolvimento antigos (subidos com `true`) podem já ter
   índices que as migrations também criam: a `TenancyIndexes` usa `IF NOT EXISTS` e tolera isso.
3. Atualize o código e as dependências (`npm install` em `backend/` e `frontend-web/`).
4. **Tokens antigos e login de novo** (atualização que aplica a `AuthSessions` — as sessões registradas — vinda de uma
   versão anterior a ela): os tokens emitidos antes não têm `jti`. Em produção, eles só continuam valendo se você
   definir `JWT_LEGACY_ISSUED_BEFORE` com o instante do deploy (ex.: `JWT_LEGACY_ISSUED_BEFORE=2026-11-01T12:00:00Z`):
   ficam aceitos até o corte + `JWT_EXPIRES_IN` (7 dias por padrão). **Sem a variável, todos — site, app mobile e
   equipe — precisam entrar de novo** depois do deploy (o token antigo recebe 401 e o log avisa uma vez). Em
   development/test os tokens antigos continuam aceitos até expirar. Quem já tinha a `AuthSessions` aplicada não é
   afetado. Em development, sem `JWT_SECRET`, o segredo dos tokens passou a ser aleatório por máquina: quem já estava
   logado num ambiente de desenvolvimento entra de novo uma vez.
5. **Sessão do site em cookie**: depois do deploy desta versão (API e web), cada pessoa que entrar pelo site passa a
   usar o token curto + cookie (seção 7.3); as sessões antigas continuam no modo bearer até expirarem. Confira a
   topologia (mesmo site, HTTPS, `CORS_ORIGINS`/`APP_WEB_URL` exatos) antes de publicar.

### 3.2 Aplicar as migrations

Suba a API (`npm run start:dev` ou `npm run start:prod`; `DB_MIGRATIONS_RUN` aplica as pendentes antes de
tudo) ou rode explicitamente:

```bash
cd backend
npm run migration:show      # pendentes aparecem com [ ]
npm run migration:run       # produção: npm run migration:run:prod (depois do npm run build)
npm run migration:show      # as 13 com [X]
npm run migration:check     # "No changes in database schema were found"
```

Banco que já tinha as 7 primeiras (`BaselineSchema` … `AuthSessions`): faltam as 6 novas desta versão
(`AddressZoneLocation`, `PlanStorageLimit`, `StoreSlugHistoryAndCancelOrigin`, `PerformanceIndexes`,
`AccountEmailVerification` e `AuthSessionRefresh`). Todas são aditivas (colunas opcionais, tabelas e índices novos);
nenhuma altera pedidos, pagamentos ou contas existentes. Faça o `pg_dump` antes (seção 3.1).

O que cada migration faz em um banco existente:

| Migration | Efeito num banco que já tem dados |
|---|---|
| `BaselineSchema` | Nada (o schema da loja única já existe). Irreversível |
| `MultiTenantFoundation` | Converte a loja única em SaaS (seção 3.3) |
| `TenancyIndexes` | Índices de consulta e únicos parciais (convite pendente por loja + e-mail; fatura por período). Idempotente |
| `MaintenanceJobs` | Tabela da manutenção em segundo plano |
| `PlatformIntegrity` | `subscriptions.suspended_by` preenchida pelo histórico (suspensões do superadmin → `PLATFORM`; as demais → `BILLING`), CHECK do papel global, triggers de mesma loja e de `store_id` imutável. **Recusa subir** se alguma conta com papel global também for da equipe de uma loja: a mensagem lista as contas; remova o papel (`npm run platform:superadmin -- --email=<e-mail> --revoke`) ou tire a conta da equipe e rode de novo. Nenhum caminho HTTP produz essa combinação, só SQL manual |
| `OrderNumbersAndCustomerBlocks` | **Renumera os pedidos existentes por loja**, na ordem de criação (1, 2, 3... em cada loja), cria o contador por loja e os gatilhos que numeram todo pedido novo, e a tabela de clientes bloqueados pela loja. Tolera a coluna e o índice já criados por `DB_SYNCHRONIZE=true` num banco de desenvolvimento |
| `AuthSessions` | Tabela `auth_sessions` (uma linha por token de sessão emitido). Tokens emitidos antes da atualização (sem `jti`) só continuam valendo com `JWT_LEGACY_ISSUED_BEFORE` = instante do deploy (seção 3.1, item 4); sem ela, em produção, todos entram de novo. Enquanto valem, não aparecem em "Sessões ativas" nem são encerrados por `POST /auth/logout` (só pela versão das sessões: "Sair de todos os aparelhos", troca ou redefinição de senha, bloqueio ou "encerrar sessões" no superpainel) |
| `AddressZoneLocation` | Colunas opcionais de localização pelo CEP em `addresses` e dois CHECKs. Sem backfill: os endereços existentes ficam "não conferidos" e são conferidos no primeiro orçamento de entrega. Tolera as colunas e CHECKs já criados por `DB_SYNCHRONIZE=true`. Nenhum dado é alterado |
| `PlanStorageLimit` | `plans.max_storage_mb` (nulo): os planos existentes ficam **ilimitados** até você definir o limite no superpainel |
| `StoreSlugHistoryAndCancelOrigin` | `subscriptions.cancel_scheduled_by`, preenchida nos cancelamentos agendados em aberto pelo autor do último agendamento (conta da plataforma → `PLATFORM`; senão `STORE`), e a tabela `store_slug_history`, preenchida com os slugs antigos registrados na auditoria (o último dono de cada um fica reservado contra o autoatendimento) |
| `PerformanceIndexes` | Índices de desempenho (seção 8.7), com `CREATE INDEX CONCURRENTLY` e **fora de transação**: não trava as tabelas, mas numa tabela grande pode levar alguns minutos. Se falhar no meio, rode de novo (o índice inválido é recriado). Os índices de busca de contas exigem a extensão `pg_trgm`: sem permissão para criá-la, a migration segue sem eles e o log avisa (a busca funciona, só mais lenta) |
| `AccountEmailVerification` | `users.email_verified_at` (todas as contas existentes ficam "Não confirmado" até confirmarem) e a tabela `account_email_tokens` |
| `AuthSessionRefresh` | Colunas da sessão do site em cookie em `auth_sessions`. As sessões existentes viram `BEARER` pelo padrão, sem reescrever a tabela (os CHECKs e a FK são criados `NOT VALID` e validados em seguida) |

> **Número do pedido muda nas telas.** Antes, as telas mostravam `Pedido #<id>` (o id global, compartilhado
> por todas as lojas). Depois da `OrderNumbersAndCustomerBlocks`, mostram o número **da loja**: o pedido que era
> "Pedido #1532" pode virar "Pedido #87". Avise as lojas antes de atualizar: conversas, comprovantes, prints e
> anotações que citavam "Pedido #<id>" passam a não bater com o número exibido. O `id` não muda: continua nas
> rotas da API (`/orders/:id`), nos pagamentos e no app mobile (que ainda mostra o id). Para achar um pedido
> antigo pelo id, use `SELECT id, store_id, number FROM orders WHERE id = <id>`.

Se uma migration falhar, a API não sobe e o log mostra o motivo; a migration que falhou é desfeita (cada uma
roda em transação) e as anteriores continuam aplicadas. Exceção: a `PerformanceIndexes` roda fora de transação
(`CONCURRENTLY`); se ela falhar, os índices já criados ficam e a próxima execução completa os que faltam.

Para conferir o efeito da `AccountEmailVerification` (contas confirmadas):

```sql
SELECT count(*) FILTER (WHERE email_verified_at IS NOT NULL) AS confirmadas, count(*) AS total FROM users;
```

### 3.3 Da loja única para o SaaS

1. Faça o backup (seção 3.1).
2. Defina, se quiser, o nome e o slug da loja que vai receber os dados atuais:
   `INITIAL_STORE_NAME="Minha Lanchonete"` e `INITIAL_STORE_SLUG=minha-lanchonete` (padrão: "Loja principal" e
   `loja-principal`).
3. Aplique as migrations (seção 3.2). A `MultiTenantFoundation`:
   - cria a loja inicial com o status e as mensagens de `store_config`;
   - associa a ela cardápio, pedidos, pagamentos e a equipe (clientes continuam globais);
   - cria o plano interno **legado** (sem cobrança e sem limites) e uma assinatura ativa;
   - grava o retrato do endereço nos pedidos de entrega antigos;
   - define a loja inicial como **loja padrão** (rotas antigas e app mobile).
4. Crie o superadmin (seção 5) e confira a loja no superpainel.
5. **Checklist pós-migração** (painel da loja → Configurações): nome, endereço, telefone e horários (a migração
   copia os valores que a vitrine antiga exibia fixos), fuso, zonas e taxas de entrega, prazo de retirada,
   credenciais do Mercado Pago, logo e cor. Produtos sem adicionais marcados deixaram de aceitar adicionais:
   marque-os no cadastro do produto se a loja dependia do comportamento antigo.

Banco criado por uma versão muito antiga (sem colunas que o synchronize das últimas versões criou): a migration
recusa com a lista do que falta. Nesse caso, suba uma vez a versão anterior com `DB_SYNCHRONIZE=true` (com backup)
e rode as migrations de novo.

## 4. Migrations

| Comando (em `backend/`) | Para quê |
|---|---|
| `npm run migration:show` | Lista as migrations e o estado (`[X]` aplicada, `[ ]` pendente) |
| `npm run migration:run` | Aplica as pendentes (ts-node, código-fonte) |
| `npm run migration:revert` | Desfaz **a última** aplicada (repita para voltar mais) |
| `npm run migration:check` | Falha se as entidades divergem do banco. Use no CI ou numa cópia do banco de produção, já migrado |
| `npm run migration:generate -- src/database/migrations/NomeDaMudanca` | Gera uma migration nova a partir das entidades (revise e registre em `migrations/index.ts`) |
| `npm run migration:run:prod` / `npm run migration:show:prod` | O mesmo a partir do build (`dist/`), sem ts-node |
| `npx typeorm -d dist/database/data-source.js migration:revert` | Reverter a partir do build (não há script `:prod` para isso) |

Regras:

- Migrations já aplicadas em algum ambiente nunca são editadas: crie uma nova.
- `DB_MIGRATIONS_RUN` (padrão `true`) aplica as pendentes na subida. Com várias instâncias da API, deixe
  `false` nelas e rode `npm run migration:run:prod` uma única vez no deploy.
- Reverter (sempre junto com o código da versão anterior): `AuthSessionRefresh` remove as colunas da sessão em
  cookie (quem estava no modo cookie entra de novo; contas e pedidos não mudam); `AccountEmailVerification` apaga
  as confirmações de e-mail e os links pendentes; `PerformanceIndexes` remove os índices (não a extensão
  `pg_trgm`); `StoreSlugHistoryAndCancelOrigin` perde a origem dos agendamentos e as reservas de slug;
  `PlanStorageLimit` remove o limite de armazenamento dos planos; `AddressZoneLocation` remove a localização pelo
  CEP (volta a valer só o bairro digitado); `AuthSessions` incrementa a versão das sessões de **todas** as contas
  (todo mundo entra de novo: a API anterior ignora o `jti` e as sessões revogadas já podem ter sido apagadas) e apaga
  a tabela de sessões; `OrderNumbersAndCustomerBlocks` remove os números dos pedidos, o contador, os gatilhos e os
  bloqueios de clientes (os bloqueios continuam só na auditoria) — com bloqueios gravados, ela **recusa** reverter,
  salvo com `DB_ALLOW_DESTRUCTIVE_REVERT=true`; `PlatformIntegrity` perde a origem das suspensões; `MaintenanceJobs` apaga o histórico da
  manutenção (a auditoria fica); `TenancyIndexes` remove os índices; `MultiTenantFoundation` só reverte com
  **uma** loja e recusa se for apagar auditoria, cobrança SaaS, sessões de suporte, convites ou redefinições,
  ou desfazer bloqueios e revogações de sessão — salvo com `DB_ALLOW_DESTRUCTIVE_REVERT=true`, só com backup
  (status e mensagens voltam para `store_config`; lojas, planos e assinaturas criados depois são perdidos);
  `BaselineSchema` é irreversível. Em produção, prefira restaurar o backup a reverter.
- Valide uma atualização numa cópia antes: `createdb -T comestra comestra_copia`, aponte `DB_DATABASE` para a
  cópia e rode `migration:run` → `migration:check` → `migration:revert` → `migration:run`.

## 5. Superadministrador: criação e recuperação de acesso

O papel global **nunca** é concedido por uma requisição HTTP. No servidor, com acesso ao banco:

```bash
cd backend
npm run platform:superadmin -- --email=ops@suaempresa.com.br --name="Nome Sobrenome"
# produção (após npm run build):
npm run platform:superadmin:prod -- --email=ops@suaempresa.com.br --name="Nome Sobrenome"
```

| Situação / opção | O que acontece |
|---|---|
| E-mail sem conta | Cria o superadmin com uma senha forte aleatória exibida **uma única vez** (ou a de `SUPERADMIN_PASSWORD`, com no mínimo 12 caracteres, maiúscula, minúscula e número ou símbolo) |
| E-mail de um **cliente** já existente | Recusado: o comando mostra os dados da conta. O cadastro de clientes é público, então alguém poderia "plantar" a conta antes. Para promovê-la mesmo assim: `--promote-existing`, que **troca a senha** (aleatória ou `SUPERADMIN_PASSWORD`), encerra as sessões abertas e invalida os links de redefinição pendentes. Prefira um e-mail sem conta |
| E-mail da **equipe** de uma loja | Nunca vira superadmin (papéis separados): use outro e-mail |
| `--reset-password` | Recuperação de acesso de um superadmin: senha nova (aleatória ou `SUPERADMIN_PASSWORD`) e sessões encerradas. Substitui o antigo `npm run seed -- --force` |
| `--revoke` | Remove o papel global e encerra as sessões da conta |

- Toda concessão, revogação e troca fica na auditoria (escopo SYSTEM).
- Para escolher a senha sem deixá-la no `.env`, defina-a só no ambiente do comando:
  `SUPERADMIN_PASSWORD='...' npm run platform:superadmin -- --email=... --reset-password` (Linux) ou
  `$env:SUPERADMIN_PASSWORD='...'; npm run platform:superadmin -- --email=... --reset-password; Remove-Item Env:SUPERADMIN_PASSWORD` (PowerShell).
- O superadmin entra pela tela de login do painel (`/login`) e cai em `/platform`.
- **Demais contas** (equipe e clientes): o superadmin gera um link de redefinição de uso único no superpainel
  (Usuários → redefinir senha). Com o e-mail por SMTP configurado (seção 7.1), o link vai **só** para o e-mail da
  conta (o operador vê apenas "enviado para j***@...") e, se o envio falhar, nenhum link é gerado (503: corrija o
  SMTP e tente de novo); com o driver de log (padrão), o link é exibido uma vez para o operador. Contas da plataforma
  não recebem link pelo superpainel: usam "Esqueci minha senha" ou `--reset-password`. "Esqueci a senha" envia o
  link por e-mail com SMTP (no máximo 3 por conta em 24 h); com o driver de log, o link só vai para o log da API em
  development/test.

## 6. Seeds e contas de demonstração

| O quê | Quando é criado | Controle |
|---|---|---|
| Loja demo **Lanchonete Demo** (`/loja/demo`), aberta, com o plano interno "Plano demonstração" (gratuito, sem limites, não público) e assinatura ACTIVE; vira a loja padrão | Subida da API em development/test, **só num banco sem lojas** | `SEED_DEMO_USERS` |
| Equipe demo (administrador, atendente, cozinha, entregador) | Subida em development/test, se faltar; fica na loja padrão (num banco migrado da loja única, a loja inicial) ou na loja demo | `SEED_DEMO_USERS` (padrão: ligado em development/test) |
| Cliente demo (conta global) | Idem | `SEED_DEMO_USERS` |
| Superadmin demo (`superadmin@comestra.com.br`, senha pública) | Em test (suíte E2E) por padrão; em development só com `SEED_DEMO_SUPERADMIN=true` ou `npm run seed -- --with-superadmin` | `SEED_DEMO_SUPERADMIN` |

- E-mails e senhas: tabela "Contas de demonstração" do [README da raiz](../../README.md).
- As contas de demonstração (e-mails fictícios `@comestra.com.br`) nascem com o e-mail **confirmado**; `npm run seed`
  confirma as que ainda não estavam. Superadmins **criados** pelo comando `platform:superadmin` também nascem
  confirmados (`--promote-existing` mantém o estado da conta).
- Na subida, só as contas que faltam são criadas; contas existentes nunca são alteradas. Uma falha no seed não
  derruba a API (só registra no log).
- `npm run seed` (em `backend/`) recria os que faltam, tira da lixeira e **redefine nome, perfil e senha** para
  os valores documentados, mostrando uma tabela no fim. Ele se recusa a rodar em produção (inclusive com
  `NODE_ENV` vazio ou desconhecido), com ou sem o antigo `--force`.
- **Nunca em produção**: com `NODE_ENV=production` (ou vazio) nada de demonstração é criado, e
  `SEED_DEMO_USERS=true` gera um erro no log.

> **Senhas públicas.** As senhas de demonstração estão no README e no código. Qualquer pessoa que alcance a
> API (rede local, `npm run tunnel` do app mobile, ngrok) entra como ADMIN da loja padrão — e, se existir, como
> superadmin de **todas** as lojas. Bancos criados por versões anteriores podem ter `superadmin@comestra.com.br`
> com a senha pública `Superadmin@123`: com `SEED_DEMO_USERS` ligado, a subida avisa no log. Antes de expor a
> API, rode `npm run platform:superadmin -- --email=superadmin@comestra.com.br --reset-password` (ou `--revoke`),
> troque ou exclua as contas da equipe demo e use `SEED_DEMO_USERS=false`.

## 7. Configuração

Todas as variáveis estão comentadas em `backend/.env.example` (valores vazios usam o padrão). Variáveis do
próprio ambiente (servidor, Docker, CI) têm prioridade sobre o `.env`. Principais:

| Variável | Padrão | Observação |
|---|---|---|
| `NODE_ENV` | vazio = produção | `development`/`test` liberam as facilidades de desenvolvimento; qualquer outro valor segue as regras de produção (falha fechada) |
| `JWT_SECRET` | development: aleatório por máquina (`backend/.temp/dev-jwt-secret`, caminho em `JWT_DEV_SECRET_FILE`); test: fixo | **Obrigatório em produção** (32+ caracteres; a API não sobe sem ele). Para expor uma API de desenvolvimento por túnel, defina um próprio e troque a senha do superadmin demo |
| `JWT_EXPIRES_IN` | `7d` | Validade do token bearer (app mobile, sessões antigas, sessão de suporte) e padrão da validade total da sessão em cookie |
| `JWT_LEGACY_ISSUED_BEFORE` | vazio | Instante ISO 8601 do deploy que aplicou a `AuthSessions` (ex.: `2026-11-01T12:00:00Z`): tokens sem `jti` emitidos antes valem até o corte + `JWT_EXPIRES_IN`. Vazio, em produção: todos entram de novo (seção 3.1). `none` recusa todos |
| `AUTH_WEB_COOKIE` · `JWT_ACCESS_EXPIRES_IN` · `AUTH_SESSION_MAX_AGE` · `AUTH_REFRESH_GRACE_SECONDS` · `AUTH_COOKIE_ORIGINS` · `AUTH_COOKIE_SAMESITE` | `true` · `15m` · = `JWT_EXPIRES_IN` · `30` · vazio · `strict` | Sessão do site em cookie (seção 7.3) |
| `ACCOUNT_SECURITY_MODE` | `compat` | Verificação e troca de e-mail. `strict` ainda não existe nesta versão (só gera aviso) |
| `DB_MIGRATIONS_RUN` | `true` | Migrations na subida. Várias instâncias: `false` nelas e `migration:run:prod` no deploy |
| `DB_SYNCHRONIZE` | `false` | Recomendado `false` em todos os ambientes (seção 3.1) |
| `DB_ALLOW_DESTRUCTIVE_REVERT` | vazio | Libera o `down()` destrutivo da `MultiTenantFoundation` (seção 4) |
| `INITIAL_STORE_NAME` / `INITIAL_STORE_SLUG` | "Loja principal" / `loja-principal` | Só na migração de uma instalação de loja única |
| `DEFAULT_STORE_SLUG` | vazio | Força a loja das rotas antigas (senão vale a escolhida no superpainel) |
| `CREDENTIALS_ENCRYPTION_KEY` | dev/test: chave fixa | **Obrigatória em produção** para gravar e ler as credenciais Mercado Pago das lojas. 32 bytes: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Guarde em cofre: trocá-la torna as credenciais gravadas ilegíveis (cada loja precisará informá-las de novo) |
| `CORS_ORIGINS` | vazio = qualquer origem | Produção: domínios reais do site e do painel (vazio gera aviso na subida) |
| `TRUST_PROXY` | vazio | Atrás de proxy/túnel/balanceador: número de saltos (recomendado: `1` atrás de um único Nginx, ngrok ou balanceador) ou a lista de IPs/sub-redes dos proxies. `true` é convertido para `1` com aviso: com `true` o Express usaria a entrada mais à esquerda do `X-Forwarded-For`, que é a escrita pelo cliente (Nginx `$proxy_add_x_forwarded_for`, ALB, Cloudflare e ngrok só acrescentam o IP real), e qualquer um furaria os limites por IP e forjaria o IP da auditoria. Cadeias com 2+ proxies: informe o número exato (ex.: `2`). Evite sub-redes IPv4-mapeadas em IPv6 com prefixo curto (`::ffff:10.0.0.0/8`); use `10.0.0.0/8`. Sem ele, todos os clientes caem no IP do proxy; a API avisa no log ao receber `X-Forwarded-For`. Não ligue sem um proxy real na frente |
| `APP_WEB_URL` | `http://localhost:5173` | Endereço do site, usado nos links de convite, de redefinição de senha e dos e-mails de conta |
| `PUBLIC_API_URL` | vazio | Endereço público da API (ex.: `https://api.suaempresa.com.br` ou `https://suaempresa.com.br/api`; no Docker, `http://localhost:8080/api`): base do logo das lojas nos e-mails. Vazio = e-mails sem logo |
| `UPLOADS_CLEANUP_INTERVAL_HOURS` | vazio (desligada) | Limpeza automática dos arquivos sem uso, em horas (ex.: `24`; seção 8.2) |
| `DB_POOL_SIZE` · `DB_STATEMENT_TIMEOUT_MS` · `DB_POOL_ACQUIRE_TIMEOUT_MS` | `10` · `60000` · `30000` | Pool e prazos do banco da API (seção 7.4) |
| `PLATFORM_INSIGHTS_CACHE_MS` | `30000` | Cache do dashboard e do financeiro do superpainel (`0` desliga) |
| `CEP_LOOKUP_FAKE` | vazio | Só em testes automatizados (`NODE_ENV=test`); ignorada com aviso nos outros ambientes |
| `SWAGGER_ENABLED` | dev/test: `true`; produção: `false` | Documentação em `/api` (expõe todas as rotas, inclusive as do superpainel) |
| `RATE_LIMIT_ENABLED` / `RATE_LIMIT_<NOME>` | `true` / padrões do `.env.example` | Limites por instância, formato `limite/segundos`: login (`LOGIN_FAILURES`, `LOGIN_FAILURES_IP`, `LOGIN_FAILURES_ACCOUNT` 50/3600 por conta, `LOGIN_SUCCESS` 200/600), recuperação, cadastro, pedidos (`ORDER_CREATE`, `ORDER_CREATE_IP`), cobranças do delivery (`PAYMENT_CREATE`, `PAYMENT_CREATE_IP`), webhook (`PAYMENT_WEBHOOK`), uploads, endereços, equipe, troca de credenciais, e-mails de conta (`ACCOUNT_EMAIL` 5/3600, `ACCOUNT_EMAIL_TARGET` 3/3600), renovação da sessão do site (`REFRESH` 120/300), checkout da assinatura (`SUBSCRIPTION_CHECKOUT` 10/600 por loja) e e-mail de teste do superpainel (`TEST_EMAIL`, padrão `5/600` por operador). Tabela completa: `arquitetura.md`, seção 11.8 |
| `HOST` | `0.0.0.0` | Interface de escuta da API (seção 7.2) |
| `MAIL_DRIVER` | `log` | `log` (nada é enviado) ou `smtp` (seção 7.1) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | vazio / `587` (ou `465` com `SMTP_SECURE=true`) / ligado só na porta 465 | Servidor SMTP, obrigatório com `MAIL_DRIVER=smtp` |
| `SMTP_USER` / `SMTP_PASSWORD` | vazio | Credenciais do SMTP, sempre juntas. Nunca aparecem em respostas, logs, auditoria nem no superpainel |
| `MAIL_FROM` | vazio | Remetente, obrigatório com `smtp`: `"Nome <endereco@dominio>"` ou só o endereço (entre aspas no `.env`) |
| `SEED_DEMO_USERS` / `SEED_DEMO_SUPERADMIN` | seção 6 | Dados de demonstração (nunca em produção) |
| `SUPERADMIN_PASSWORD` | vazio | Senha do comando `platform:superadmin` no lugar da aleatória |
| `MP_ACCESS_TOKEN` / `MP_PUBLIC_KEY` | vazio | Conta Mercado Pago usada **só pela loja padrão** sem credencial própria |
| `PAYMENT_SANDBOX` | automático em dev/test | Produção: nunca liga (e `true` é recusado) |
| `PIX_EXPIRATION_MINUTES` | `30` | De 30 min a 30 dias |
| `MP_NOTIFICATION_URL` | vazio | URL pública de `POST /payment/webhook`; sem ela, a conciliação a cada 60 s confirma os pagamentos |
| `SAAS_BILLING_PROVIDER` | `MANUAL` | `MANUAL` (faturas registradas pelo superadmin) ou `MERCADO_PAGO` (assinaturas recorrentes) |
| `MP_SAAS_ACCESS_TOKEN` / `MP_SAAS_WEBHOOK_SECRET` / `SAAS_BILLING_BACK_URL` | vazio | Conta Mercado Pago **da Comestra** (nunca a de uma loja), segredo do webhook `POST /billing/webhook/mercadopago` e página de retorno |
| `SAAS_BILLING_INTERVAL_MS` | `300000` | Intervalo da rotina de assinaturas (mínimo 10000) |
| `UPLOADS_DIR` | `./uploads` | Produção: volume persistente, com backup |

Frontend web (`frontend-web/.env`): `VITE_API_URL` (endereço da API; também entra na CSP do build e nos
cabeçalhos do `vite preview`, então o build de produção precisa da URL real; uma URL relativa como `/api` serve para
site e API na mesma origem, como no Docker), `VITE_APP_NAME`, `VITE_MP_PUBLIC_KEY` (chave pública de
compatibilidade; cada loja usa a chave do próprio perfil público) e `VITE_AUTH_TRANSPORT` (`auto`, padrão: sessão
em cookie quando a API permite; `bearer`: desliga o modo cookie no site, exige build novo — seção 7.3).
Tudo que começa com `VITE_*` é público: nunca coloque segredos.

### 7.1 E-mail transacional (SMTP)

Convites da equipe, links de redefinição de senha, os e-mails de conta (confirmação, troca de e-mail, "Não fui
eu" e avisos de senha alterada) e o e-mail de teste do superpainel saem pelo driver de `MAIL_DRIVER`. Com `log`
(padrão), **nada é enviado**: em development/test o texto completo (com o link) vai para o log da API; em produção,
só o destinatário e o assunto, e a subida avisa no log. Com `smtp`, a API envia pelo servidor configurado
(nodemailer). Sem SMTP, o superpainel mostra uma vez os links que ele gera; **com** SMTP, a redefinição pedida no
superpainel e os convites de Lojas → detalhe → Convites vão só por e-mail (se o envio falhar, nada vale: 503 e o
convite é cancelado). O convite do responsável na criação da loja também vai só por e-mail com SMTP (se o envio
falhar, a loja é criada e a tela avisa).

Os e-mails saem em **texto e HTML** com a marca certa: convite e redefinição de contas da equipe com o nome, a cor e
o logo da loja; o resto com a marca da plataforma. Para o logo, defina `PUBLIC_API_URL` com o endereço público da API
(https recomendado; o `/uploads` já responde com `Cross-Origin-Resource-Policy: cross-origin`). Na subida, com SMTP
ativo, o log mostra `Logo das lojas nos e-mails: <url>/uploads/...` ou `Sem PUBLIC_API_URL: os e-mails das lojas
saem sem o logo.`; um valor inválido gera aviso. O driver de log mostra só o texto: para ver o HTML em
desenvolvimento, use o Mailpit/MailHog do item 1. Limitações: os logos são WebP (o Outlook clássico do Windows não
os exibe; o nome da loja continua ao lado) e muitos clientes bloqueiam imagens remotas até a pessoa liberar.

> Com `MAIL_DRIVER=log` em produção, a troca de e-mail pelo site **não se completa** (o link de confirmação não chega
> a ninguém); a troca pela rota antiga (app mobile) continua funcionando. Configure o SMTP antes de divulgar
> "Minha conta".

1. **Configuração** (no `backend/.env` ou no ambiente do servidor):

   ```bash
   MAIL_DRIVER=smtp
   SMTP_HOST=smtp.seuprovedor.com.br
   SMTP_PORT=587                  # 587 com STARTTLS; ou 465 com SMTP_SECURE=true
   SMTP_SECURE=false
   SMTP_USER=usuario-do-smtp
   SMTP_PASSWORD=senha-do-smtp
   MAIL_FROM="Comestra <nao-responda@seudominio.com.br>"
   ```

   - Porta **587** com STARTTLS (`SMTP_SECURE` desligado) ou **465** com `SMTP_SECURE=true` (TLS desde o início).
     Vazios, `SMTP_PORT` vale 587 (465 com `SMTP_SECURE=true`) e `SMTP_SECURE` liga só na porta 465.
   - Com usuário e senha e `SMTP_SECURE` desligado, o **STARTTLS é obrigatório**: um servidor que não o oferece é
     recusado antes do envio das credenciais.
   - Para desenvolvimento, um Mailpit/MailHog local na porta 1025, sem autenticação, funciona com
     `SMTP_HOST=localhost`, `SMTP_PORT=1025` e `SMTP_SECURE=false` (sem `SMTP_USER`/`SMTP_PASSWORD`).
   - Use no `MAIL_FROM` um domínio com SPF/DKIM configurados no provedor; senão os e-mails tendem a cair no spam.
2. **Teste pelo superpainel**: Configurações → **E-mail transacional** mostra o driver, o servidor (host:porta,
   modo TLS, se há autenticação), o remetente e os problemas da configuração. "Enviar e-mail de teste" (o e-mail
   do operador vem preenchido) responde "E-mail de teste aceito pelo servidor SMTP...", "Driver de log ativo:
   nenhum e-mail foi enviado..." ou "O e-mail de teste não foi enviado." com o motivo e a dica de correção: `EAUTH` → `SMTP_USER`/`SMTP_PASSWORD`; `ENOAUTH` → defina usuário e senha; `EDNS` → `SMTP_HOST`;
   `ESOCKET`/`ETIMEDOUT` → `SMTP_HOST`, `SMTP_PORT` e firewall; `ETLS`/`ECONNECTION` → `SMTP_PORT` e `SMTP_SECURE`;
   `EENVELOPE` → `MAIL_FROM` e o destinatário. Limite: 5 testes a cada 10 min por operador
   (`RATE_LIMIT_TEST_EMAIL`, em memória por instância); cada teste fica na auditoria
   (`platform.settings.test_email`). Pela API: `POST /platform/settings/test-email` com `{ "to": "..." }`.
3. **Avisos na subida**: driver de log em produção, `MAIL_DRIVER=smtp` com a configuração incompleta (falta
   `SMTP_HOST`, `MAIL_FROM`, porta inválida, só um de `SMTP_USER`/`SMTP_PASSWORD`) e `MAIL_DRIVER` desconhecido (a
   API usa o log). Com o SMTP ativo, o log mostra o servidor e o remetente.
4. **Quando o envio falha**: uma linha no log, sem usuário nem senha, e o fluxo continua: o convite da loja é
   criado e o link aparece no painel; "esqueci a senha" continua respondendo 202; os avisos de conta não são
   reenviados. Não há nova tentativa automática: reenvie o convite ou peça um novo link. No superpainel com SMTP
   (redefinição e convites do detalhe da loja), a falha cancela o link (503), e o operador nunca o vê: corrija o
   SMTP e tente de novo.
5. **Prazos e segurança**: 10 s para conectar, 10 s para a saudação e 30 s no socket. A criação de um convite
   espera o envio (com o servidor SMTP fora do ar, a tela pode levar até ~50 s para responder); o "esqueci a
   senha" não espera, porque já roda em segundo plano. As mensagens levam o cabeçalho
   `Auto-Submitted: auto-generated`; em produção, o conteúdo e o link nunca vão para o log.

### 7.2 Interface de escuta (`HOST`)

`HOST` escolhe a interface em que a API escuta (padrão `0.0.0.0`, o comportamento de sempre):

| Valor | Alcance | Quando usar |
|---|---|---|
| vazio ou `0.0.0.0` | Todas as interfaces IPv4 (acessível pela rede local) | Necessário para o app mobile no celular, na mesma rede, e para proxies em outra máquina |
| `127.0.0.1` | Somente este computador | Túnel (`npm run tunnel`, ngrok) ou proxy reverso na **mesma** máquina: a API deixa de ficar exposta na rede local |
| IP de uma interface (IPv6 com ou sem colchetes) | Somente essa interface | Servidores com mais de uma rede |

A subida registra `API Comestra escutando em <host>:<porta> (<alcance>)` e `API Comestra rodando em http://...`.
Se não conseguir escutar (endereço inexistente, porta ocupada), registra o código do erro e encerra. Variáveis
do ambiente têm prioridade sobre o `.env`: em shells que já exportam `HOST` com o nome da máquina (ex.: tcsh),
defina o valor no ambiente do processo e confira o endereço no log da subida.

### 7.3 Sessão do site em cookie

O site pede a sessão em cookie em todo login (cabeçalho `X-Auth-Transport: cookie`): recebe um token de acesso de
15 min, guardado só na memória da aba, e um refresh rotativo num cookie `HttpOnly` (`__Host-comestra_rt` em produção
ou HTTPS; `comestra_rt` em http fora de produção). O app mobile e as integrações não enviam o cabeçalho e continuam
com o token de 7 dias, sem mudança. Detalhes: `arquitetura.md`, seção 11.10.

| Variável | Padrão | Para quê |
|---|---|---|
| `AUTH_WEB_COOKIE` | `true` | `false` para de emitir sessões em cookie **na hora** (as existentes renovam até vencer) |
| `JWT_ACCESS_EXPIRES_IN` | `15m` | Validade do token de acesso do site (`1m` a `60m`) |
| `AUTH_SESSION_MAX_AGE` | = `JWT_EXPIRES_IN` | Validade total da sessão em cookie (`5m` a `90d`; a renovação não estende) |
| `AUTH_REFRESH_GRACE_SECONDS` | `30` | Tolerância do refresh anterior (0 a 120 s): cobre duas abas renovando juntas e respostas perdidas |
| `AUTH_COOKIE_ORIGINS` | vazio | Origens que recebem credenciais. Vazio = `CORS_ORIGINS` explícito + origem de `APP_WEB_URL`. Em produção sem nenhuma origem, o modo cookie fica desligado (aviso na subida) |
| `AUTH_COOKIE_SAMESITE` | `strict` | `lax` só se houver um motivo (gera aviso em produção) |
| `RATE_LIMIT_REFRESH` | `120/300` | Renovações por IP |
| `VITE_AUTH_TRANSPORT` (web) | `auto` | `bearer` desliga o modo cookie no site (exige build novo) |

**Topologia** (confira antes de publicar): site e API no **mesmo site** — de preferência a mesma origem com proxy em
`/api` (como no Docker), ou `app.` e `api.` no mesmo domínio; HTTPS; `CORS_ORIGINS` e `APP_WEB_URL` exatos;
`TRUST_PROXY` correto; e o proxy **sem registrar** os cabeçalhos `Cookie`, `Set-Cookie` e `Authorization` no log (o
Nginx do Docker já usa um `log_format` sem eles). Site e API em sites diferentes, LAN por IP ou túnel em outro
domínio funcionam, mas voltam sozinhos ao modo bearer. Em desenvolvimento, `localhost:5173` e `localhost:3000` são o
mesmo site e o cookie funciona sem HTTPS.

**Kill switches**: `AUTH_WEB_COOKIE=false` na API (imediato) ou `VITE_AUTH_TRANSPORT=bearer` no build do site.

**Reuso de sessão** (`auth.refresh.reuse` na auditoria, em Superpainel → Usuários → eventos): um refresh antigo foi
apresentado de novo e a família inteira foi encerrada. Eventos isolados são esperados (aba que perdeu a resposta de
uma renovação, rede instável); **rajadas** na mesma conta indicam cookie roubado: encerre as sessões da conta e
oriente a troca de senha.

### 7.4 Banco: pool, prazos e compressão

- `DB_POOL_SIZE` (padrão `10`, o mesmo do driver): conexões da API. Aumente junto com o `max_connections` do
  PostgreSQL (somando todas as instâncias).
- `DB_STATEMENT_TIMEOUT_MS` (padrão `60000`; `0` desliga): tempo máximo de cada consulta da API. Não vale para as
  migrations da subida nem para o CLI (`migration:run`), que usam uma conexão própria. Combina com o
  `proxy_read_timeout` de 60 s do Nginx do Docker.
- `DB_POOL_ACQUIRE_TIMEOUT_MS` (padrão `30000`; `0` = sem limite): espera máxima por uma conexão livre. Com o pool
  esgotado, a requisição falha com 500 (`timeout exceeded when trying to connect` no log) em vez de esperar para
  sempre.
- A API comprime as respostas (gzip/br, acima de 1 KB). Um proxy na frente não precisa comprimir `/api` (o Nginx do
  Docker usa `gzip off` em `/api/` e só repassa a resposta comprimida; não há compressão dupla). `/uploads` sai com
  cache de 30 dias e `immutable`: trocar uma imagem gera um nome novo.

## 8. Operação do dia a dia

| Tarefa | Onde |
|---|---|
| Loja padrão, tolerância da inadimplência (0–60 dias, padrão 7), duração da sessão de suporte (5–240 min, padrão 30), autoatendimento de lojas e o plano dele | Superpainel → Configurações |
| Planos (preço, periodicidade, teste grátis, limites — inclusive **Armazenamento (MB)**, vazio/"Ilimitado" = sem limite; uma mudança vale na hora —, recursos, ativo/público) | Superpainel → Planos |
| Nova loja: nasce fechada, com a entrega desligada, a assinatura do plano escolhido e um convite do responsável cujo link aparece **uma vez** (com o SMTP configurado, o convite também vai por e-mail; com o driver de log, envie o link por outro canal) | Superpainel → Lojas → Nova loja |
| Convites seguintes de uma loja (detalhe → Convites): com SMTP, o link vai só por e-mail ("Convite enviado"); sem SMTP, aparece uma vez | Superpainel → Lojas → detalhe |
| Primeiros passos da loja: o responsável aceita o convite (`/convite/:token`), preenche Configurações (dados, endereço, horários, fuso, zonas e taxas de entrega, política para endereços fora das zonas, credenciais Mercado Pago, logo e cor), cadastra o cardápio, convida a equipe e abre a loja | Painel da loja |
| Entrega por bairro e/ou faixa de CEP, e "Entregar com uma taxa padrão" ou "Recusar a entrega" fora das zonas (seção 8.4) | Painel da loja → Configurações → Entrega |
| Minha conta: e-mail (confirmar, trocar com confirmação no endereço novo) e senha (com a senha atual) — seção 8.6 | Meus Dados (cliente) ou menu → Minha conta (painel e superpainel) |
| Suspender, reativar, desativar ou restaurar uma loja (motivo obrigatório para suspender e desativar; nada é apagado) | Superpainel → Lojas → detalhe |
| Assinatura: trocar plano, cancelar (motivo obrigatório no cancelamento imediato), desfazer cancelamento agendado, suspender (fica `PLATFORM`: pagamento não reativa) e reativar | Superpainel → Assinaturas ou detalhe da loja |
| Faturas (provedor `MANUAL`): registrar pagamento (idempotente), recusar e anular (ambos com motivo) | Superpainel → Assinaturas → faturas |
| Usuários: busca global, bloquear (com motivo), desbloquear, encerrar sessões, gerar link de redefinição | Superpainel → Usuários |
| Sessão de suporte: motivo de 10 a 300 caracteres; o superadmin vê o painel da loja como o ADMIN, **somente leitura**, até expirar ou encerrar | Superpainel → detalhe da loja |
| Auditoria (filtros por loja, ator, resultado, escopo, período, ação ou grupo, alvo) | Superpainel → Auditoria |
| Otimização das imagens antigas (tarefa em segundo plano, uma por vez) | Superpainel → Configurações → Manutenção (`POST /platform/maintenance/optimize-images`) |
| Limpeza dos arquivos sem uso em `/uploads` ("Verificar" = só relatório; "Apagar sem uso" = com confirmação; uma por vez, em segundo plano; seção 8.2) | Superpainel → Configurações → Manutenção (`POST /platform/maintenance/cleanup-uploads`) |
| Regravar as credenciais Mercado Pago das lojas no formato atual (depois de atualizar; seção 8.2) | Superpainel → Configurações → Manutenção (`POST /platform/maintenance/store-credentials/reencrypt`) |
| E-mail transacional: situação do driver e e-mail de teste (seção 7.1) | Superpainel → Configurações → E-mail transacional |
| Bloquear ou desbloquear um cliente na loja (motivo obrigatório; só ADMIN; seção 8.3) | Painel da loja → Clientes |
| Ver e encerrar as próprias sessões (por aparelho ou todas; seção 8.1) | Meus Dados (cliente) ou menu lateral → Sessões ativas (painel e superpainel) |
| Indicadores e alertas (`PAST_DUE_GRACE_ENDING`, `SUBSCRIPTION_SUSPENDED`, `REFUND_PENDING`, `INVOICE_FAILED`, `NO_ACTIVE_ADMIN`, `STORE_SUSPENDED`, `TRIAL_ENDING`, `ONLINE_PAYMENTS_WITHOUT_CREDENTIALS`, `INACTIVE_STORE_BILLED`, `CANCELED_STILL_BILLED`); os números podem ficar até 30 s atrasados (`PLATFORM_INSIGHTS_CACHE_MS`) | Superpainel → Dashboard e Financeiro |
| `CANCELED_STILL_BILLED` (crítico): assinatura cancelada com autorização ainda ativa no Mercado Pago e/ou cobranças depois do cancelamento (90 dias). Confira a autorização no painel do MP, cancele-a lá se preciso e devolva o valor indicado | Superpainel → Dashboard |
| Cancelamento agendado pela plataforma: a loja não consegue desfazer (vê "fale com o suporte"); só o superpainel desfaz | Superpainel → Assinaturas |
| Renomear a loja padrão (slug): atualize `DEFAULT_STORE_SLUG` no `backend/.env` logo depois (ou use a loja padrão por id em Configurações), senão as rotas antigas e o app mobile deixam de achá-la. O slug antigo fica reservado para sempre (o autoatendimento não o aceita; o superpainel pode reutilizá-lo, com aviso) | Superpainel → Lojas → detalhe |

Rotinas automáticas da API: ciclo das assinaturas (`SAAS_BILLING_INTERVAL_MS`; fim do teste, vencimento,
tolerância, renovação e novas tentativas de cancelar no Mercado Pago as assinaturas canceladas), conciliação dos
pagamentos do delivery (a cada 60 s; cancela os pendentes de lojas que não vendem e cria os pedidos dos aprovados),
heartbeat da manutenção (execução parada há 10 min vira FAILED), limpeza das sessões (seção 8.1) e, se ligada, a
limpeza agendada dos arquivos sem uso (`UPLOADS_CLEANUP_INTERVAL_HOURS`, seção 8.2).

Monitoramento: `GET /health` (público, responde só `{"status":"ok"}`) e o log da subida — `Ambiente:
production`, `API Comestra escutando em <host>:<porta> (...)` e `API Comestra rodando em ...`, e nenhum aviso de
configuração (`NODE_ENV`, `DB_SYNCHRONIZE`, `CREDENTIALS_ENCRYPTION_KEY`, `CORS_ORIGINS`, `TRUST_PROXY`,
superadmin de demonstração, e-mail transacional, `PUBLIC_API_URL`, `JWT_LEGACY_ISSUED_BEFORE`, sessão em cookie,
`ACCOUNT_SECURITY_MODE`, `UPLOADS_CLEANUP_INTERVAL_HOURS`, `PerformanceIndexes` sem `pg_trgm`).

### 8.1 Sessões

- Cada login (e cada token novo emitido pela API: cadastro de loja, aceite de convite, troca da própria senha
  ou e-mail, sessão de suporte) cria uma sessão registrada. "Sair da Conta"/"Sair do Sistema" encerra a sessão
  **no servidor** (`POST /auth/logout`): o token antigo deixa de valer mesmo que alguém o tenha copiado.
- **Sessões ativas** (Meus Dados para clientes; menu lateral → "Sessões ativas" no painel e no superpainel):
  lista os aparelhos com navegador resumido, IP e datas ("Este navegador" primeiro). "Encerrar" derruba a sessão
  de outro aparelho na hora; "Sair de todos os aparelhos" (`POST /auth/logout-all`) encerra todas as sessões
  registradas, incrementa a versão das sessões da conta (invalida também os tokens antigos, sem `jti`) e volta
  para o login. A lista fica oculta durante uma sessão de suporte.
- O superadmin continua derrubando as sessões de qualquer conta por Superpainel → Usuários → encerrar sessões
  ou bloquear (`token_version`).
- **Sessão de suporte**: "Encerrar e voltar ao superpainel" e "Sair do Sistema" encerram o suporte com o próprio
  token de suporte, na hora (também depois de recarregar a página). O superadmin também pode encerrar a sessão
  `SUPPORT` pela própria lista de sessões. Tudo fica na auditoria (`platform.support_session.end` com `via`).
- Limpeza automática: a cada sessão nova, as sessões mortas daquela conta são apagadas; no máximo uma vez por
  hora por instância, um lote de até 5000 sessões vencidas é apagado em segundo plano.
- Se a gravação da sessão falhar no login (banco indisponível, por exemplo), a resposta é 500 e nenhum token é
  entregue: a pessoa tenta de novo.
- No máximo 100 sessões ativas por conta: cada login novo encerra as mais antigas além disso.
- **Site em cookie** (seção 7.3): a sessão aparece uma vez na lista, mesmo com o token sendo renovado a cada ~12 min;
  "Encerrar" derruba também o cookie daquele navegador. Um login novo no mesmo navegador encerra a sessão anterior
  dele no servidor.
- Tokens emitidos antes das sessões registradas (sem `jti`) só valem com `JWT_LEGACY_ISSUED_BEFORE` e até o corte +
  `JWT_EXPIRES_IN` (seção 3.1); não aparecem na lista.
- 401 `Sessão inválida ou expirada. Faça login novamente.`: a sessão foi encerrada (por logout, pela lista, pelo
  superpainel ou pelo teto de 100), venceu, ou o token é antigo (sem `jti`) e está fora da janela.

### 8.2 Manutenção (superpainel → Configurações → Manutenção)

Todas as ações são só do superadmin (fora de sessão de suporte) e ficam na auditoria.

- **Otimizar imagens**: converte as imagens antigas em lotes, em segundo plano, uma execução por vez.
- **Limpar arquivos sem uso** (`/uploads`):
  1. Faça backup da pasta `UPLOADS_DIR`.
  2. **Verificar**: só conta os arquivos (total, em uso, recentes, sem uso e o tamanho deles). Nada é apagado.
  3. **Apagar sem uso**: pede confirmação mostrando o resultado da última verificação e apaga só as imagens que
     nenhum cadastro usa há mais de 24 h. São consideradas em uso as imagens de produtos e adicionais (inclusive na
     lixeira), as fotos de perfil (inclusive de contas apagadas) e os logos das lojas, por nome, `/uploads/nome`
     ou URL completa. Só o primeiro nível da pasta, só arquivos de imagem com nome no padrão da API: subpastas,
     atalhos, ocultos e arquivos como `.json`, `.txt` ou `.env` nunca são apagados (aparecem em "ignorados").
  - Uma limpeza por vez (verificar e apagar dividem a trava; 409 se outra estiver em andamento), com
    acompanhamento a cada 3 s. O resumo e a auditoria guardam só números, nunca os nomes dos arquivos.
  - **Limpeza automática**: com `UPLOADS_CLEANUP_INTERVAL_HOURS=24` (por exemplo), a API roda sozinha o "Apagar sem
    uso" (mesmas regras: só imagens sem uso há mais de 24 h) a cada intervalo, uma por vez entre todas as instâncias,
    auditada como sistema (`trigger: schedule`). Acompanhe pela linha "Limpeza automática ligada" (intervalo, última
    execução automática e a próxima prevista; uma execução automática aparece como "Exclusão automática"). Faça
    backup da pasta `UPLOADS_DIR` antes de ligar. Decimais são aceitos (`0.5` = 30 min); `0`, `off` ou vazio desligam;
    um valor inválido desliga com aviso na subida.
- **Cota de armazenamento** (plano → Armazenamento (MB)): a loja vê o medidor "Armazenamento" em Assinatura e, no
  limite, recebe 403 com o aviso do plano ao enviar imagem (produto, adicional, logo). Conta só as imagens da loja
  (prefixo `s<id>-`); fotos de perfil não contam. O uso é medido com cache de até 5 min por instância. Opções de
  suporte: aumentar o limite do plano ou trocar de plano (o downgrade é recusado se os arquivos não couberem) ou rodar
  a limpeza dos arquivos sem uso. Os arquivos sem uso da loja continuam contando até a limpeza os apagar (24 h).
- **Credenciais do Mercado Pago**: mostra quantas lojas têm credenciais no formato atual (v2, preso à loja) e
  no antigo (v1). **Depois de atualizar** uma instalação que já tinha credenciais gravadas, use "Regravar
  credenciais" para passar as v1 para v2. É idempotente (pode repetir), não expõe nenhum token, atualiza o
  `updated_at` só das lojas regravadas e lista as lojas com credenciais ilegíveis só na resposta (elas precisam
  informar as credenciais de novo no painel). Em produção, sem `CREDENTIALS_ENCRYPTION_KEY`, responde 503 e não
  regrava nada.

### 8.3 Clientes bloqueados e número do pedido

- **Bloqueio de cliente** (Painel da loja → Clientes, só ADMIN; o atendente vê o selo "Bloqueado" e o filtro, mas
  não bloqueia): motivo obrigatório (até 300 caracteres), registrado para a equipe e na auditoria. O cliente
  bloqueado não orça, não pede e não paga **naquela loja** (403 `Não é possível fazer pedidos nesta loja. Fale com
  a loja.`, sem o motivo) e continua comprando nas outras. Desbloquear devolve o acesso na hora. Um PIX gerado
  antes do bloqueio e pago depois ainda vira pedido: cancele e estorne no quadro.
- **Número do pedido**: cada loja numera os próprios pedidos (1, 2, 3...), sem buraco nem repetição, pelo banco.
  Nunca altere `orders.number` por SQL (o gatilho recusa). Ao restaurar ou importar dados de pedidos, o contador
  `store_order_counters.last_number` de cada loja precisa ser maior ou igual ao maior número dela (uma loja sem
  linha no contador recomeça do 1); senão os pedidos novos esbarram no índice único (`UQ_orders_store_number`) e
  são recusados. Para corrigir (cria as linhas que faltam e nunca diminui um contador):

  ```sql
  INSERT INTO store_order_counters (store_id, last_number)
  SELECT store_id, max(number) FROM orders GROUP BY store_id
  ON CONFLICT (store_id) DO UPDATE
     SET last_number = GREATEST(store_order_counters.last_number, EXCLUDED.last_number);
  ```

### 8.4 Entrega por CEP

- Em Configurações → Entrega, a loja escolhe **"Entregar com uma taxa padrão"** ou **"Recusar a entrega"** para
  endereços fora das zonas. As zonas aceitam bairros (use os nomes dos **Correios**, os mesmos da busca de CEP) e/ou
  faixas de CEP (`22010-000 a 22099-999` ou um CEP só; até 50 por zona).
- O bairro do cliente é conferido pelo CEP e **prevalece** sobre o digitado (evita taxa errada ou burla): um CEP
  digitado errado leva à zona do CEP, ou à recusa, e o carrinho mostra "Pelo CEP, o bairro é …" para o cliente
  corrigir. Com a recusa, o cliente vê o aviso no carrinho antes de pagar (nada é cobrado) e pode escolher a
  retirada. Pagamento já aprovado nunca é recusado.
- Sem saída para a internet (ou com ViaCEP e BrasilAPI fora do ar), os endereços ficam como "bairro informado
  manualmente" (vale o digitado) e o orçamento tenta de novo a cada 1 h; a primeira consulta pode levar ~6 s e depois
  cada serviço fica 60 s sem ser consultado. Os endereços antigos são conferidos no primeiro orçamento de entrega.
- O app mobile mostra a mensagem do 400 no orçamento quando a loja padrão recusa o endereço.

### 8.5 Pagamento estornado no Mercado Pago

Com `MP_NOTIFICATION_URL` configurada, um estorno, contestação ou cancelamento feito **direto no Mercado Pago** depois
da aprovação marca o pedido como "Estornado no Mercado Pago" (quadro em vermelho, faixa no topo do quadro para todos
os perfis e auditoria `payment.reversed`). Oriente as lojas a **não entregar** sem receber de outra forma, ou a
cancelar o pedido (o cancelamento não tenta estornar de novo). Sem a URL do webhook, essas reversões não são
detectadas.

### 8.6 Conta: confirmação e troca de e-mail

- **Minha conta** (Meus Dados no site; menu do painel e do superpainel): mostra o e-mail com o selo
  Confirmado/Não confirmado, reenvia a confirmação (link de 48 h), troca a senha com a senha atual e troca o e-mail
  **com confirmação no endereço novo** (link de 24 h). O endereço antigo recebe um aviso com "Não fui eu", que por
  7 dias desfaz a troca com uma senha nova; nesse período o endereço antigo fica reservado.
- Atendimento: "não recebi o e-mail" → confira o SMTP (seção 7.1), o spam e os limites (5 pedidos por hora por conta;
  3 e-mails por hora por destinatário, em silêncio). "Alguém trocou meu e-mail" → o dono usa o "Não fui eu" do e-mail
  recebido no endereço antigo; depois de 7 dias, use o superpainel (bloquear, encerrar sessões, link de redefinição).
- Contas existentes começam como "Não confirmado"; "Esqueci minha senha" também confirma o e-mail. A troca de e-mail
  pelo app mobile (rota antiga) continua imediata. Os eventos aparecem em Superpainel → Usuários (eventos `auth.*`).

### 8.7 Desempenho e índices

- A migration `PerformanceIndexes` cria `IDX_users_email_lower`, `IDX_addresses_user_id`, `IDX_payments_store_open`,
  `IDX_payments_open_created`, `IDX_audit_logs_created`, `IDX_orders_store_updated_at`, `IDX_orders_store_open`,
  `IDX_orders_driver_updated_at`, `IDX_order_items_product_id` e, com a extensão `pg_trgm`, `IDX_users_name_trgm` e
  `IDX_users_email_trgm`. Usa `CONCURRENTLY` e roda fora de transação: se falhar no meio, rode de novo. `pg_trgm` é
  opcional: sem permissão para criá-la (superusuário, ou extensão `trusted` com `CREATE` no banco), a busca de contas
  do superpainel funciona, só mais lenta, e o log avisa. Para ter esses dois índices depois que a migration já rodou,
  como superusuário: `CREATE EXTENSION IF NOT EXISTS pg_trgm;`, `CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "IDX_users_name_trgm" ON "users" USING gin ("name" gin_trgm_ops);` e o mesmo com `"IDX_users_email_trgm"` e
  `("email" gin_trgm_ops)`. O `down()` não remove a extensão.
- O quadro de pedidos guarda por 30 s os dados de outras tabelas (nome, telefone e foto do cliente, produto); o
  dashboard e o financeiro do superpainel, por 30 s (`PLATFORM_INSIGHTS_CACHE_MS`). Com várias instâncias, esses
  caches e os limites de tentativas valem por instância.
- Pool e prazos do banco: seção 7.4.
- No site, todas as consultas periódicas (quadro 5 s, indicadores 15 s, gráficos 60 s, status da loja 30 s, painel
  120 s, Meus Pedidos 10 s, dashboard do superpainel 60 s) pausam com a aba oculta e atualizam na volta; o quadro não
  redesenha quando a resposta é igual à anterior. O Recharts fica no pedaço `charts-*.js` (~364 kB, ~108 kB gzip,
  carregado sob demanda); o `charts-*.js` pequeno (~5,7 kB) é o módulo da página do Dashboard, não a biblioteca.

## 9. Checklist de produção

- [ ] `NODE_ENV=production` e `JWT_SECRET` forte: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
- [ ] `CREDENTIALS_ENCRYPTION_KEY` definida (32 bytes) e guardada em cofre.
- [ ] `CORS_ORIGINS` com os domínios do site e do painel.
- [ ] `TRUST_PROXY` configurado com o **número de saltos** (ex.: `1` atrás de um único Nginx/ngrok/balanceador; `2`
      com um proxy HTTPS na frente do Nginx do Docker) ou a lista de IPs dos proxies — nunca `true` (vira `1` com
      aviso). Sem ele, os limites por IP (login, cadastro, pedidos, cobranças, webhook) viram um balde único. Confira
      que o aviso de `X-Forwarded-For` não aparece no log. Com Docker, o Nginx do `web` já acrescenta o IP e o modelo
      usa `TRUST_PROXY=1`.
- [ ] `JWT_LEGACY_ISSUED_BEFORE` com o instante do deploy na atualização que aplica a `AuthSessions` (ex.:
      `2026-11-01T12:00:00Z`) — ou aceite que todos (site, app mobile e equipe) entrem de novo. Sem a variável, em
      produção, os tokens sem `jti` recebem 401 e o log avisa uma vez (seção 3.1).
- [ ] Sessão do site em cookie (seção 7.3): site e API no mesmo site (de preferência a mesma origem com proxy em
      `/api`), HTTPS, `CORS_ORIGINS`/`APP_WEB_URL` exatos (ou `AUTH_COOKIE_ORIGINS`) e o proxy **sem registrar**
      `Cookie`, `Set-Cookie` e `Authorization` no log. Confira que a subida não avisa "Sessão do site em cookie
      desligada".
- [ ] `DB_POOL_SIZE` compatível com o `max_connections` do PostgreSQL (somando as instâncias); `DB_STATEMENT_TIMEOUT_MS`
      e `DB_POOL_ACQUIRE_TIMEOUT_MS` nos padrões (60 s e 30 s) ou revisados (seção 7.4).
- [ ] `SWAGGER_ENABLED` vazio ou `false` (padrão em produção).
- [ ] `DB_SYNCHRONIZE=false` (padrão) e estratégia de migrations definida (`DB_MIGRATIONS_RUN` com uma
      instância, ou `migration:run:prod` no deploy). Backup antes de cada deploy com migrations.
- [ ] Superadmin criado pelo comando; nenhuma conta de demonstração no banco (e nenhuma com senha pública).
- [ ] `RATE_LIMIT_*` revisados (padrões do `.env.example`); com várias instâncias, os contadores são por
      instância.
- [ ] Loja padrão definida no superpainel (ou `DEFAULT_STORE_SLUG`) se o app mobile estiver publicado.
- [ ] Credenciais Mercado Pago **de cada loja** configuradas pelo painel da loja (o `MP_ACCESS_TOKEN` do ambiente
      vale só para a loja padrão), `PAYMENT_SANDBOX` não ligado e `MP_NOTIFICATION_URL` em `https://`.
- [ ] HTTPS na frente da API e do site. A API envia HSTS em produção.
- [ ] Web gerada com `VITE_API_URL` real (a CSP do build depende dela) ou relativa (`/api`, mesma origem) e servida com
      (com Docker, os cabeçalhos e o rewrite da SPA já estão no `frontend-web/nginx.conf`):
      - rewrite da SPA (`/loja/*`, `/platform/*`, `/convite/*`, `/redefinir-senha/*`, `/verificar-email/*`,
        `/confirmar-email/*`, `/desfazer-troca-de-email/*`, `/my-orders` etc. → `index.html`);
      - os cabeçalhos de `securityHeaders()` (`frontend-web/vite.config.ts`): `Content-Security-Policy` com
        `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
        `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` e `Strict-Transport-Security`.
        `frame-ancestors` e `X-Frame-Options` só funcionam como cabeçalho.
- [ ] Limite de corpo no proxy (ex.: Nginx `client_max_body_size 12m`) e timeout menor para uploads.
- [ ] `UPLOADS_DIR` em volume persistente; backup do banco e da pasta de imagens. Limpeza automática
      (`UPLOADS_CLEANUP_INTERVAL_HOURS=24`) só depois do backup da pasta.
- [ ] `APP_WEB_URL` com o endereço real do site (links de convite, de redefinição e dos e-mails de conta) e
      `PUBLIC_API_URL` com o endereço público da API (logo das lojas nos e-mails).
- [ ] Logs de acesso do proxy sem os tokens dos links de uso único (`/redefinir-senha/`, `/convite/`,
      `/verificar-email/`, `/confirmar-email/`, `/desfazer-troca-de-email/` e as rotas `/auth/reset-password`,
      `/invitations` e `/account/email-*` da API). O Nginx do Docker já troca o token por `[redacted]`.
- [ ] E-mail transacional: `MAIL_DRIVER=smtp`, `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`, `SMTP_USER`/`SMTP_PASSWORD` e
      `MAIL_FROM` (domínio com SPF/DKIM) configurados e conferidos com "Enviar e-mail de teste" no superpainel
      (seção 7.1). Sem isso, convites, links de redefinição e confirmações de e-mail não chegam às pessoas, e a
      troca de e-mail pelo site não se completa.
- [ ] `HOST`: `127.0.0.1` quando o proxy reverso roda na mesma máquina; `0.0.0.0` (padrão) só quando a API precisa
      ser alcançada por outra máquina. Confira a linha `escutando em ...` no log.
- [ ] Depois de atualizar uma instalação que já tinha credenciais Mercado Pago gravadas: "Regravar credenciais"
      (Superpainel → Configurações → Manutenção) até não restar nenhuma no formato antigo.
- [ ] Cobrança recorrente (`SAAS_BILLING_PROVIDER=MERCADO_PAGO`) só depois de configurar e validar a conta MP da
      plataforma (seção 11); até lá, `MANUAL`.
- [ ] Log da subida sem avisos de configuração.

## 10. Limitações conhecidas e pendências

Itens adiados na revisão de segurança, agrupados, com a recomendação de cada um.

**Sessão e autenticação**

- O site já usa token curto (15 min) com refresh rotativo em cookie `HttpOnly` (seção 7.3), com revogação no servidor
  da sessão substituída por um login novo, e os tokens sem `jti` só valem na janela de `JWT_LEGACY_ISSUED_BEFORE`.
  Continuam com o token de 7 dias: o app mobile (que também não chama `POST /auth/logout` ao sair), a sessão de
  suporte e o site quando site e API ficam em sites diferentes. Pendentes (fase 2): sessão deslizante e limite de
  ociosidade, token compartilhado entre abas, "último uso" na lista de sessões, refresh no app mobile, recusar de vez
  tokens sem `jti` e token CSRF double-submit; a médio prazo, superpainel em origin próprio (ex.:
  `admin.comestra.com.br`). Sem Web Locks (site em http num IP da rede local), duas abas renovando juntas dependem só
  da tolerância do servidor: uma resposta perdida fora dela desloga a aba e gera `auth.refresh.reuse` (risco aceito).
- As sessões não registram o "último acesso" (para não gravar no banco a cada requisição) e a limpeza só roda
  quando uma sessão nova é emitida. Recomendação: coluna `last_seen_at` e limpeza global periódica pela
  manutenção.
- Verificação e troca de e-mail em modo `compat` (seção 8.6): o modo `strict` (fase 1b) não existe ainda. Senha
  atual (`current_password`) obrigatória para contas da plataforma e no site (Minha conta), opcional na rota antiga
  usada pelo app; o ADMIN ainda define senha e e-mail de outros membros (exceto o responsável), e um ADMIN pode
  "reservar" e-mails de outras pessoas com contas da equipe na lixeira; cadastro, convite e a troca pela rota antiga
  respondem 409 quando o e-mail existe. Recomendação: fase 1b depois da
  atualização do app (link de redefinição pelo ADMIN, respostas neutras, equipe pendente até confirmar; considerar
  captcha no cadastro público).
- Limites de tentativas em memória, por instância (inclusive o do e-mail de teste do superpainel). Atrás de CGNAT
  (vários clientes no mesmo IPv4), os limites por IP de login, "esqueci a senha" e links podem bloquear todos pela
  janela. O teto de falhas por conta ainda deixa um atacante na mesma rede inferir, com esforço, que a conta tem
  sessão ativa naquele IP. Recomendação: armazenamento compartilhado (Redis) com CAPTCHA ou credencial de
  dispositivo antes de escalar para várias instâncias.

**E-mail transacional**

- O envio por SMTP existe, mas o padrão continua `log`. Os e-mails já saem em texto e HTML com a marca da loja ou
  da plataforma (logo só com `PUBLIC_API_URL`, em WebP). Uma falha é registrada uma vez, sem nova tentativa (o link da
  loja continua no painel; os avisos de conta não têm fila); a criação de um convite espera o envio; STARTTLS com
  credenciais e os prazos (10/10/30 s) não são configuráveis. Recomendação: fila de envio com novas tentativas,
  provedores por API (SES, SendGrid, Mailgun), assinatura DKIM, pool de conexões e tratamento de bounces; logo também
  em PNG para o Outlook clássico; pré-visualização dos e-mails no superpainel; remetente ou `Reply-To` por loja.

**Pagamentos do delivery**

- O webhook do delivery não valida `x-signature` (exige um segredo por loja). Mitigação atual: corpo não
  confiável (reconsulta no MP), limite por IP, reconsulta a cada 15 s e fila limitada. Recomendação: guardar
  `mp_webhook_secret` cifrado por loja e validar `x-signature`/`x-request-id` antes de consultar o MP.
- PIX pendentes de uma loja suspensa/desativada (ou com assinatura suspensa/cancelada) são cancelados pela
  conciliação em até 60 s por rodada; se algum for pago antes, a finalização estorna e nenhum pedido nasce.
  Recomendação: cancelamento imediato (`cancelPendingForStore`) nas próprias ações de bloqueio.
- Estorno que falhou (`finalize_error` com "estorno pendente") não tem nova tentativa automática: fica para a
  equipe (alerta `REFUND_PENDING`). Recomendação: rotina de nova tentativa com recuo exponencial e auditoria.
- `PIX_EXPIRATION_MINUTES` aceita até 30 dias. Recomendação: definir um teto operacional (ex.: 60 min ou 24 h),
  com aviso no log quando o valor for reduzido.
- Troco limitado a R$ 200 acima do total para todas as lojas. Recomendação: teto configurável por loja
  (coluna nova e campo nas configurações).
- O bloqueio de cliente pela loja existe (seção 8.3: Painel › Clientes, só ADMIN; o cliente vê só a mensagem
  genérica; vale só naquela loja; desbloquear devolve o acesso; auditado), mas as cobranças pendentes do cliente
  na loja não são canceladas ao bloquear: um PIX gerado antes do bloqueio e pago depois vira pedido (cancele e
  estorne no quadro). Recomendação: cancelar na hora as cobranças pendentes do cliente na loja ao bloquear e um
  cancelamento em lote auditado para o ADMIN (ainda pendente).
- Número do pedido por loja: o painel não busca nem filtra pedidos pelo número, as respostas de pagamento não
  trazem o número (a confirmação busca o pedido) e o app mobile ainda mostra o `id`. Recomendação:
  `GET /orders?number=`, o número nas respostas de pagamento e no app.

**Assinaturas SaaS**

- Assinatura suspensa pela plataforma com cobrança automática autorizada no Mercado Pago continua sendo cobrada
  pelo MP durante a suspensão (o pagamento quita a fatura, mas não reativa). Recomendação: pausar/retomar a
  preapproval no provedor nas ações de suspender/reativar, validado no sandbox do MP.
- O checkout da assinatura chama o Mercado Pago com uma conexão do banco aberta (no máximo uma por loja, por até
  15 s): numa lentidão do MP com muitas lojas pagando ao mesmo tempo, o pool pode encher (amenizado pelo limite
  `SUBSCRIPTION_CHECKOUT` e por `DB_POOL_ACQUIRE_TIMEOUT_MS`). Recomendação: reserva por coluna e chamada ao provedor
  fora da transação (`arquitetura.md`, seção 12).
- Qualquer ADMIN da loja, não só o responsável, troca ou remove as credenciais Mercado Pago da loja (auditado).
  Recomendação: avisar o responsável por e-mail ou restringir ao responsável (decisão de negócio).

**Arquivos**

- A limpeza dos arquivos sem referência pode ser manual ou agendada (seção 8.2) e a tela mostra só quantidade e
  tamanho, não os nomes. A reconferência final antes de apagar procura só as formas exatas (`nome`,
  `/uploads/nome`): uma URL completa gravada entre a varredura e a exclusão não seria vista (risco pequeno, porque o
  arquivo também precisa estar parado há mais de 24 h). A cota de armazenamento por loja existe, mas usa cache por
  instância (até 5 min de atraso; com várias instâncias, uploads simultâneos podem passar um pouco do limite) e o
  limite não aparece na página pública de planos. A foto enviada no cadastro (conta ainda sem id) não leva o prefixo
  de dono e não é apagada quando trocada depois; avatares externos gravados antes da correção continuam no banco (o
  web só exibe avatares de `/uploads` ou do host dos ícones prontos). Recomendação: contabilidade compartilhada do
  armazenamento, alerta de armazenamento no dashboard, renomear o avatar do cadastro para `u<id>-` e um script que
  zere avatares fora da lista permitida.

**Entrega por CEP**

- O retrato do pedido e as telas da equipe mostram só o bairro digitado; endereços já conferidos não são
  reconferidos se a base de CEPs mudar; não há frete por distância nem lista pública dos bairros atendidos.
  Recomendação: bairro do CEP no pedido, reconferência periódica, frete por raio e cache de CEP compartilhado.

**Desempenho**

- Relatórios de um ano de uma loja muito grande (200 mil pedidos) ainda ocupam ~0,5 s do processo; a lista de
  clientes da loja leva ~0,6 s nesse volume; o histórico pagina por `OFFSET`; a auditoria cresce sem limite.
  Recomendação: agregar no SQL, estatísticas por cliente, paginação por cursor e retenção da auditoria.

**Docker e dependências**

- No Docker, o banco ainda recebe o `.env.docker` inteiro e a API conecta como superusuário do PostgreSQL.
  Recomendação: segredo próprio do banco e um papel sem superusuário ([`docker.md`](docker.md)).
- Vulnerabilidades moderadas que só se resolvem com versão maior: `typeorm` 0.3, `@nestjs/swagger` 11 e
  `mercadopago` 2 no backend; ferramentas de desenvolvimento (eslint/typescript-eslint) no frontend. O
  `backend/package.json` usa `overrides` para `body-parser`, `multer` e `proxy-addr`; remova-os quando o Nest publicar
  as versões corrigidas.

**Rede e exposição**

- `HOST` escolhe a interface de escuta (seção 7.2), mas o padrão continua `0.0.0.0` (necessário para o app
  mobile na rede local); o `/health` público já não mostra nome nem versão. Recomendação: padrão `127.0.0.1` em
  development quando o app não depender da rede local e recusar logins das contas de demonstração vindos de fora
  da rede local ou com `TRUST_PROXY` ativo. A API não se recusa a subir em produção sem `CORS_ORIGINS` (só avisa).
- Com a CSP de produção, o script de perfil do dispositivo (antifraude) do Mercado Pago fica bloqueado sem um
  nonce gerado pelo servidor que hospeda o SPA (o pagamento com cartão funciona).

**Limites de exibição**

- O quadro de pedidos (`scope=active`) mostra os 500 pedidos mais recentes; Meus Pedidos (web e app) mostra os
  100 mais recentes (as telas não têm "carregar mais").
- Os limites de produtos e de equipe do plano são rígidos (conferidos sob trava por loja); o de pedidos do mês
  (`max_monthly_orders`) continua "suave": PIX aprovados de clientes diferentes no limite exato podem passar.

## 11. Integrações externas pendentes

| Integração | Situação | O que falta |
|---|---|---|
| Cobrança recorrente (Mercado Pago Assinaturas) | Implementada atrás de `SAAS_BILLING_PROVIDER=MERCADO_PAGO`, **não validada contra o Mercado Pago real** | Conta MP da Comestra, `MP_SAAS_ACCESS_TOKEN`, URL pública do webhook `POST /billing/webhook/mercadopago` cadastrada no painel MP com o segredo em `MP_SAAS_WEBHOOK_SECRET`, `SAAS_BILLING_BACK_URL`, testes em sandbox |
| Pagamentos do delivery (Mercado Pago por loja) | Implementados; cada loja informa as próprias credenciais no painel | Credenciais de produção de cada loja; `MP_NOTIFICATION_URL` pública; nonce de CSP no servidor do SPA para o antifraude |
| E-mail transacional | Driver SMTP implementado (nodemailer), com texto + HTML e a marca da loja ou da plataforma; o padrão continua `log` (nada é enviado) | Servidor SMTP de produção (`MAIL_DRIVER=smtp`, `SMTP_*`, `MAIL_FROM` com SPF/DKIM) conferido pelo e-mail de teste do superpainel e `PUBLIC_API_URL` para o logo (seção 7.1). Evolução: fila de reenvio, provedores por API e tratamento de bounces. Com SMTP, o superpainel deixa de mostrar os links de redefinição e de convite do detalhe da loja |
| Domínio próprio / subdomínio por loja | Campo `custom_domain` armazenado, sem roteamento | DNS curinga, certificados e resolução por host no front e no CORS |
| Rate limit distribuído | Em memória, por instância | Armazenamento compartilhado (ex.: Redis) se houver várias instâncias |
