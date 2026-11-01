# ⚙️ Comestra | API (NestJS)

> **Cozinha, balcão e entrega no mesmo compasso.**

API REST **multi-tenant** da plataforma Comestra. Ela concentra o isolamento entre lojas, o superpainel (lojas, usuários, planos, assinaturas, auditoria, suporte), o painel de cada loja (equipe, convites, configurações, cardápio, pedidos, clientes), a vitrine pública por slug, os pagamentos do delivery (Mercado Pago de cada loja) e a cobrança da assinatura SaaS. Atende o site e os painéis (`frontend-web`) e, pelas rotas antigas, o app mobile (`frontend-mobile`, fora do escopo desta fase).

Visão geral do produto e contas de demonstração: [README da raiz](../README.md). Arquitetura e contratos: [`docs/saas/arquitetura.md`](../docs/saas/arquitetura.md). Instalação, migrations e operação: [`docs/saas/operacao.md`](../docs/saas/operacao.md).

---

## 🛠 Stack

| Camada | Tecnologia |
|---|---|
| Framework | NestJS 11 (TypeScript) |
| Banco de dados | PostgreSQL 14+ com TypeORM 0.3 e **migrations** versionadas (`src/database/migrations`) |
| Autenticação | JWT (Passport) com versão de sessão (`token_version`) e sessões registradas por token (`jti` em `auth_sessions`) + bcrypt; guards de loja, de perfil e da plataforma |
| Validação | `ValidationPipe` global com class-validator / class-transformer (`whitelist`, `forbidNonWhitelisted`) |
| Documentação | Swagger (OpenAPI) em `/api` (ligado em development/test) |
| Imagens | Multer + Sharp (conversão para WebP, limite de resolução e fila de conversões) |
| Pagamentos | SDK oficial do Mercado Pago: delivery por loja (cartão e PIX) e assinaturas SaaS (preapproval) |
| Cache | cache-manager em memória (banner do dia) |
| E-mail | nodemailer **10.1.7** (SMTP; traz os próprios tipos, sem `@types/nodemailer`; Node ≥ 20). Driver de log por padrão (`MAIL_DRIVER`) |
| Testes | Jest (unitários) e Jest + Supertest (`test/`); suíte Playwright em [`../e2e`](../e2e/README.md) |

---

## 🚀 Como executar

### Pré-requisitos
- **Node.js 22+** e npm
- **PostgreSQL 14+** com um banco vazio (padrão: `comestra`)

### Passo a passo

```bash
cd backend
cp .env.example .env          # Windows (PowerShell): Copy-Item .env.example .env
# edite o .env: NODE_ENV=development e DB_PASSWORD (senha do usuário postgres); deixe DB_SYNCHRONIZE vazio
npm install
npm run start:dev
```

Na subida, a API aplica as migrations pendentes (`DB_MIGRATIONS_RUN`, ligado por padrão) e, com `NODE_ENV=development`, cria a loja **Lanchonete Demo** (só num banco sem lojas) e as [contas de demonstração](#-contas-de-demonstração). O `.env.example` vem com `NODE_ENV=production`: sem trocar o valor, a API segue as regras de produção e não sobe sem um `JWT_SECRET` forte (veja [Ambiente e segurança](#-ambiente-e-segurança)).

Crie o seu superadmin (o de demonstração não é criado em development):

```bash
npm run platform:superadmin -- --email=voce@exemplo.com --name="Seu Nome"   # a senha aparece uma vez
```

| Endereço | O que é |
|---|---|
| <http://localhost:3000/health> | Saúde: `{ "status": "ok" }` (sem nome nem versão; a versão fica no Swagger) |
| <http://localhost:3000/api> | Swagger. Faça `POST /auth/login` e use o `access_token` no botão **Authorize** |
| `http://localhost:3000/uploads/<arquivo>` | Imagens enviadas (pasta `UPLOADS_DIR`) |

Por padrão a API escuta em `0.0.0.0` (`HOST`), então o app mobile alcança a API pelo IP da máquina na rede local (não exponha uma API de desenvolvimento com contas de demonstração; veja o aviso do [README da raiz](../README.md#-contas-de-demonstração)). Com `HOST=127.0.0.1` ela fica só neste computador. O log da subida mostra `API Comestra escutando em <host>:<porta> (<alcance>)`.

### Scripts

| Comando | O que faz |
|---|---|
| `npm run start:dev` | Desenvolvimento com recarga automática |
| `npm run start:debug` | Desenvolvimento com o inspetor do Node |
| `npm run build` | Compila para `dist/` |
| `npm run start:prod` | Executa o build (`node dist/main`) sempre com `NODE_ENV=production` |
| `npm run migration:show` · `migration:run` · `migration:revert` | Estado, aplicação e reversão (da última) das migrations, pelo código-fonte |
| `npm run migration:check` | Falha se as entidades divergem do banco (CI ou cópia do banco migrado) |
| `npm run migration:generate -- src/database/migrations/Nome` | Gera uma migration nova a partir das entidades (revise e registre em `migrations/index.ts`) |
| `npm run migration:run:prod` · `migration:show:prod` | O mesmo a partir do build (`dist/`). Reverter pelo build: `npx typeorm -d dist/database/data-source.js migration:revert` |
| `npm run platform:superadmin -- --email=...` | Cria, promove (`--promote-existing`), recupera (`--reset-password`) ou revoga (`--revoke`) um superadmin. Pelo build: `npm run platform:superadmin:prod -- ...` |
| `npm run seed` | Cria/restaura a loja e as contas de demonstração e redefine as senhas (`-- --with-superadmin` inclui o superadmin demo). Nunca roda em produção |
| `npx jest` (ou `npm test`) | Testes unitários |
| `npm run test:cov` | Testes unitários com cobertura (`coverage/`) |
| `npm run test:e2e` | Teste E2E da API (Jest + Supertest, precisa de PostgreSQL) |
| `npm run build:e2e` | Build próprio da suíte Playwright (`dist-e2e/`) |
| `npm run lint` · `npm run format` | ESLint (com correção) e Prettier |

---

## 🔐 Variáveis de ambiente

Modelo comentado, com todas as variáveis e padrões, em [`.env.example`](.env.example); explicação completa em [`docs/saas/operacao.md`](../docs/saas/operacao.md#7-configuração). Variáveis definidas no próprio ambiente (servidor, Docker, CI) têm prioridade sobre o `.env`.

| Variável | Padrão | Descrição |
|---|---|---|
| `NODE_ENV` | vazio = produção | `development` (máquina local) ou `test` (testes) liberam as facilidades de desenvolvimento. Vazio ou qualquer outro valor conta como `production` |
| `PORT` | `3000` | Porta HTTP |
| `HOST` | `0.0.0.0` | Interface de escuta: `0.0.0.0` = todas (rede local, app mobile); `127.0.0.1` = só este computador (túnel ou proxy na mesma máquina); IPv6 com ou sem colchetes |
| `DB_HOST` · `DB_PORT` · `DB_USERNAME` · `DB_PASSWORD` · `DB_DATABASE` | `localhost` · `5432` · `postgres` · vazio · `comestra` | PostgreSQL (`DB_DATABASE` vazio = slug da marca em `src/config/brand.ts`) |
| `DB_MIGRATIONS_RUN` | `true` | Aplica as migrations pendentes na subida (várias instâncias: `false` e `migration:run:prod` no deploy) |
| `DB_SYNCHRONIZE` | `false` em todos os ambientes | Synchronize do TypeORM. Mantenha `false`: com `true` ele cria índices e colunas por fora das migrations |
| `DB_ALLOW_DESTRUCTIVE_REVERT` | vazio | Libera o `down()` destrutivo das migrations `MultiTenantFoundation` e `OrderNumbersAndCustomerBlocks` (só com backup) |
| `DB_POOL_SIZE` · `DB_STATEMENT_TIMEOUT_MS` · `DB_POOL_ACQUIRE_TIMEOUT_MS` | `10` · `60000` · `30000` | Pool da API (1 a 200), tempo máximo de cada consulta (`0` desliga; não vale para as migrations nem para o CLI) e espera máxima por uma conexão livre (`0` = sem limite) |
| `INITIAL_STORE_NAME` · `INITIAL_STORE_SLUG` | "Loja principal" · `loja-principal` | Loja que recebe os dados na migração de uma instalação de loja única |
| `DEFAULT_STORE_SLUG` | vazio | Loja das rotas antigas sem slug (senão, a escolhida no superpainel) |
| `JWT_SECRET` | development: aleatório por máquina (`.temp/dev-jwt-secret`, caminho em `JWT_DEV_SECRET_FILE`); test: fixo | **Obrigatório em produção, com 32+ caracteres**: sem ele, a API não sobe |
| `JWT_EXPIRES_IN` | `7d` | `7d`, `12h`, `30m` ou segundos. Valor inválido cai no padrão, com aviso. Validade do token bearer (app mobile, suporte) |
| `JWT_LEGACY_ISSUED_BEFORE` | vazio | Instante ISO 8601 do deploy que aplicou `AuthSessions`: tokens sem `jti` emitidos antes valem até ele + `JWT_EXPIRES_IN`. Vazio: em produção, nenhum é aceito (todos entram de novo); em dev/test, todos até expirar |
| `AUTH_WEB_COOKIE` · `JWT_ACCESS_EXPIRES_IN` · `AUTH_SESSION_MAX_AGE` · `AUTH_REFRESH_GRACE_SECONDS` · `AUTH_COOKIE_ORIGINS` · `AUTH_COOKIE_SAMESITE` | `true` · `15m` · = `JWT_EXPIRES_IN` · `30` · vazio · `strict` | Sessão do site em cookie (refresh rotativo `HttpOnly`): liga/desliga, validade do token de acesso e da sessão, tolerância do refresh anterior, origens com credenciais e `SameSite` |
| `ACCOUNT_SECURITY_MODE` | `compat` | Verificação e troca de e-mail; `strict` ainda não existe nesta versão (só gera aviso) |
| `CREDENTIALS_ENCRYPTION_KEY` | chave fixa só em development/test | AES-256 (32 bytes em base64 ou hex) das credenciais Mercado Pago das lojas. **Obrigatória em produção** |
| `APP_NAME` · `APP_WEB_URL` | `Comestra` · `http://localhost:5173` | Nome da plataforma; endereço do site nos links de convite, de redefinição e dos e-mails de conta |
| `PUBLIC_API_URL` | vazio | Endereço público da API (logo das lojas nos e-mails: `<PUBLIC_API_URL>/uploads/<arquivo>`); vazio = sem logo |
| `UPLOADS_DIR` | `./uploads` | Pasta das imagens (use um volume persistente em produção) |
| `UPLOADS_CLEANUP_INTERVAL_HOURS` | vazio (desligada) | Limpeza automática dos arquivos sem uso, em horas (ex.: `24`) |
| `PLATFORM_INSIGHTS_CACHE_MS` | `30000` | Cache do dashboard e do financeiro do superpainel (`0` desliga) |
| `SWAGGER_ENABLED` | ligado em development/test | Documentação em `/api` (desligada em produção) |
| `CORS_ORIGINS` | vazio = qualquer origem | Domínios do site e do painel, separados por vírgula (em produção, vazio gera aviso) |
| `TRUST_PROXY` | vazio | IP real atrás de proxy/túnel: número de proxies (ex.: `1`) ou lista de IPs/sub-redes. `true` vale como `1`, com aviso. Vazio com `X-Forwarded-For` recebido gera aviso |
| `RATE_LIMIT_ENABLED` · `RATE_LIMIT_<NOME>` | ligado | Limites (`limite/segundos`) de login (por IP e por conta), cadastro, links, pedidos, cobranças, webhook, uploads, endereços, equipe, troca de credenciais, e-mails de conta, renovação da sessão do site, checkout da assinatura e e-mail de teste do superpainel (`RATE_LIMIT_TEST_EMAIL`, padrão `5/600` por operador; em memória por instância, como os demais) |
| `CEP_LOOKUP_FAKE` | vazio | Só com `NODE_ENV=test`: mapa JSON de CEPs no lugar de ViaCEP/BrasilAPI (testes determinísticos) |
| `MAIL_DRIVER` | `log` | E-mail transacional: `log` (nada é enviado; em produção só destinatário e assunto vão para o log, com aviso na subida) ou `smtp` |
| `SMTP_HOST` · `SMTP_PORT` · `SMTP_SECURE` | vazio · `587` (ou `465` com `SMTP_SECURE=true`) · ligado só na porta 465 | Servidor SMTP. Sem `SMTP_SECURE`, usa STARTTLS (obrigatório quando há usuário e senha) |
| `SMTP_USER` · `SMTP_PASSWORD` | vazio | Opcionais, sempre juntos; nunca aparecem em respostas, logs ou auditoria |
| `MAIL_FROM` | vazio | Remetente (`"Nome <endereco@dominio>"` ou só o endereço), obrigatório com `smtp` |
| `SEED_DEMO_USERS` | ligado em development/test | Loja e contas de demonstração na subida. **Nunca em produção** (`true` é ignorado, com erro no log) |
| `SEED_DEMO_SUPERADMIN` | ligado em test, desligado em development | Superadmin de demonstração (senha pública). Nunca em produção |
| `SUPERADMIN_PASSWORD` | vazio | Senha do comando `platform:superadmin` no lugar da aleatória |
| `MP_ACCESS_TOKEN` · `MP_PUBLIC_KEY` | vazio | Conta Mercado Pago da **loja padrão** sem credencial própria (`TEST-...` = teste) |
| `PAYMENT_SANDBOX` | automático só em development/test | Vazio = sandbox quando não há token ou ele é `TEST-`. Em produção o sandbox nunca é ligado |
| `PIX_SANDBOX_APPROVAL_SECONDS` · `PIX_EXPIRATION_MINUTES` | `5` · `30` | Aprovação do PIX no sandbox; validade do QR Code (30 min a 30 dias) |
| `MP_NOTIFICATION_URL` | vazio | URL pública de `POST /payment/webhook` |
| `SAAS_BILLING_PROVIDER` · `MP_SAAS_ACCESS_TOKEN` · `MP_SAAS_WEBHOOK_SECRET` · `SAAS_BILLING_BACK_URL` · `SAAS_BILLING_INTERVAL_MS` | `MANUAL` · vazio · vazio · vazio · `300000` | Cobrança da assinatura SaaS (conta Mercado Pago da Comestra) e intervalo da rotina (mínimo 10000) |
| `STORE_TIME_ZONE` | `America/Sao_Paulo` | Fuso das lojas que não têm o próprio |
| `DELIVERY_ZONES_JSON` · `DELIVERY_ZONES_FILE` | vazio | Faixas de entrega da loja padrão (as demais lojas configuram no painel) |
| `FOOTBALL_DATA_TOKEN` | vazio | Token de football-data.org para o banner de jogos (opcional) |

Valores booleanos aceitam `true/false`, `1/0`, `yes/no`, `sim/não` e `on/off`. Um valor diferente (ex.: `fasle`) usa o padrão e gera um aviso no log.

### 🛡 Ambiente e segurança

A API **falha fechada**: só `NODE_ENV=development` ou `NODE_ENV=test` liberam as facilidades de desenvolvimento. Sem `NODE_ENV`, ou com um valor desconhecido (`prod`, `staging`...), ela segue as regras de produção e avisa no log.

| | development / test | produção |
|---|---|---|
| `JWT_SECRET` vazio | development: segredo aleatório desta máquina em `.temp/dev-jwt-secret` (fora do Git; aviso no log); test: segredo fixo | a API **não sobe** (também com menos de 32 caracteres) |
| Tokens antigos sem `jti` | aceitos até expirar | só na janela de `JWT_LEGACY_ISSUED_BEFORE` (sem ela, recusados) |
| `CREDENTIALS_ENCRYPTION_KEY` vazia | chave fixa de desenvolvimento | aviso no log; as lojas não gravam nem usam credenciais próprias |
| Loja e contas de demonstração (senhas públicas) | criadas na subida (`SEED_DEMO_USERS=false` desliga); superadmin demo só em test ou com `SEED_DEMO_SUPERADMIN=true` | **nunca** criadas; `SEED_DEMO_USERS=true` gera erro no log |
| `npm run seed` | roda | **recusado** (com ou sem `--force`) |
| Swagger | ligado | desligado (`SWAGGER_ENABLED=true` liga) |
| Sandbox de pagamentos | automático sem token ou com token `TEST-` | nunca é ligado |
| `DB_SYNCHRONIZE` | desligado (recomendado) | desligado (ligado gera aviso) |

`npm run start:prod` define `NODE_ENV=production` (com `cross-env`, funciona no Windows e no Linux). A subida registra `Ambiente: <modo>` e os avisos de configuração.

---

## 👥 Contas de demonstração

Criadas na subida com `NODE_ENV=development` ou `test` (desligue com `SEED_DEMO_USERS=false`), só as que faltam; contas existentes nunca são alteradas nessa etapa. A lista fica em [`src/database/seeds/default-users.ts`](src/database/seeds/default-users.ts) e a loja demo em [`src/database/seeds/demo-store.ts`](src/database/seeds/demo-store.ts).

| Perfil | E-mail | Senha |
|---|---|---|
| `ADMIN` (Administrador) | `admin@comestra.com.br` | `Admin@123` |
| `EMPLOYEE` (Atendente) | `atendente@comestra.com.br` | `Atendente@123` |
| `KITCHEN` (Cozinha) | `cozinha@comestra.com.br` | `Cozinha@123` |
| `COURIER` (Entregador) | `entregador@comestra.com.br` | `Entregador@123` |
| `CLIENT` (Cliente) | `cliente@comestra.com.br` | `Cliente@123` |
| `SUPER_ADMIN` (global) | `superadmin@comestra.com.br` | `Superadmin@123` — só em test ou com `SEED_DEMO_SUPERADMIN=true` / `npm run seed -- --with-superadmin` |

A equipe demo trabalha na loja padrão (a loja demo num banco novo; a loja inicial num banco migrado da loja única). `npm run seed` recria as contas que faltam, restaura as que estão na lixeira e redefine nome, perfil e senha. Onde cada perfil entra e o que pode fazer: [README da raiz](../README.md#-contas-de-demonstração).

> ⚠️ **Senhas públicas.** A API nunca cria essas contas em produção, e `npm run seed` se recusa a rodar lá. Bancos antigos podem ter o superadmin demo com a senha pública: com `SEED_DEMO_USERS` ligado, a subida avisa no log. Antes de expor a API (rede, `npm run tunnel` do app, ngrok), rode `npm run platform:superadmin -- --email=superadmin@comestra.com.br --reset-password` (ou `--revoke`) e troque ou exclua as contas demo.

---

## 🧱 Módulos

| Módulo | Pasta | Responsabilidade |
|---|---|---|
| Tenancy | `src/tenancy` | Resolução da loja (equipe, slug, loja padrão), guards (`@StaffRoute`, `@PublicStoreRoute`, `@PlatformRoute`) e situação da loja × capacidades (`store-access.ts`) |
| Platform | `src/platform` | Superpainel: lojas, usuários, sessões de suporte, configurações, dashboard/financeiro, autoatendimento de lojas e o comando `platform:superadmin` (`cli/`) |
| Billing | `src/billing` | Planos, assinaturas, faturas, limites do plano, rotina do ciclo de vida, provedores `MANUAL`/`MERCADO_PAGO` e webhook da cobrança SaaS |
| Audit | `src/audit` | Registro de auditoria com metadados sanitizados |
| Auth | `src/auth` | Login, JWT e versão de sessão, sessões registradas (`SessionJwtService` + `SessionIssuanceInterceptor`, `auth_sessions`), sessão do site em cookie (`web-session.*`, `refresh-token.ts`, `/auth/web/*`), `GET /auth/me`, logout, lista e encerramento de sessões, recuperação de senha e interceptor da sessão de suporte somente leitura |
| Account | `src/account` | Minha conta (`/account/*`): troca de senha com a senha atual, confirmação do e-mail, troca de e-mail confirmada no endereço novo, "Não fui eu" e os avisos por e-mail (`account_email_tokens`) |
| Invitations | `src/invitations` | Convites da equipe (painel da loja e superpainel) e aceite |
| Users | `src/users` | Clientes e equipe, perfil, avatar, lixeira, responsável da loja e regras de acesso (`users.policy.ts`) |
| Products | `src/products` | Produtos, categorias, adicionais e lixeira, por loja |
| Orders | `src/orders` | Orçamento e pedidos (`order-pricing.service.ts`), regras puras (`order-rules.ts`), visão por perfil e etapa, transições, dashboard, relatórios e logística |
| Payment | `src/payment` | Mercado Pago por loja (cartão e PIX), sandbox, finalização no servidor, estornos, webhook e conciliação |
| Store | `src/store` | Status, configurações, logo, credenciais Mercado Pago e clientes da loja (com bloqueio por loja); diretório e perfil público (`/stores`) |
| Addresses | `src/addresses` | Endereços do cliente, busca de CEP compartilhada (`CepLookupService`: ViaCEP → BrasilAPI, com cache) e conferência do bairro pelo CEP (`AddressLocationService`) |
| Promotions | `src/promotions` | Banner do dia (jogo de futebol ou sugestão do dia da semana) |
| Notifications | `src/notifications` | E-mails em texto e HTML com a marca da loja ou da plataforma (`MailService`: driver de log ou SMTP; `mail-layout.ts`, `mail-brand.ts`, modelos em `mail-templates.ts`) e links de convite/redefinição |
| Common | `src/common` | Uploads e imagens (cota de armazenamento por loja: `storage-usage.ts`, `storage-quota.ts`), limites (`RateLimitService`), criptografia (`secret-box.ts`), manutenção em segundo plano (otimização de imagens, limpeza dos arquivos sem uso, manual ou agendada, regravação das credenciais Mercado Pago) e validações |
| Config | `src/config` | Marca (`brand.ts`), variáveis (`env.ts`), JWT, CORS, validação e cabeçalhos de segurança (`app-setup.ts`) |
| Database | `src/database` | Data source do CLI, configuração do TypeORM, migrations e seeds |

---

## 🔑 Autenticação, perfis e isolamento

- `POST /auth/login` com `{ email, password }` devolve `{ access_token, user }`. As rotas protegidas usam `Authorization: Bearer <token>`.
- A cada requisição, a `JwtStrategy` recarrega o usuário do banco: conta excluída, bloqueada ou com sessões encerradas (`token_version`) recebe `401`; mudança de perfil vale na hora.
- **Sessões registradas:** todo token emitido numa requisição leva `jti` e ganha uma linha em `auth_sessions`, gravada antes de a resposta sair (no máximo 100 sessões ativas por conta). Token com `jti` só vale com a sessão existente, não revogada e no prazo (uma consulta indexada a mais por requisição); token antigo sem `jti` só vale na janela de `JWT_LEGACY_ISSUED_BEFORE`. `POST /auth/logout` encerra a sessão atual (com o token de suporte, encerra também o suporte), `GET /auth/sessions` e `DELETE /auth/sessions/:id` listam e encerram as próprias sessões, e `POST /auth/logout-all` revoga todas. Tokens de link (convite, redefinição, conta) usam `link-token.ts`, nunca o JWT de sessão.
- **Sessão do site em cookie:** com o cabeçalho `X-Auth-Transport: cookie` (só o site envia), login, aceite de convite, cadastro de loja, troca da própria conta e `POST /account/password` devolvem um token de 15 min e gravam um refresh rotativo num cookie `HttpOnly` (`__Host-comestra_rt` em produção/HTTPS). `POST /auth/web/refresh` renova (com detecção de reuso) e `POST /auth/web/logout` encerra. Sem o cabeçalho, o contrato é o de sempre (app mobile).
- A loja da equipe vem sempre de `users.store_id`; a da vitrine, do slug da rota. Nenhum `storeId` enviado pelo navegador é aceito. Recurso de outra loja → `404` uniforme.
- **Política de senha:** de 9 caracteres a 72 bytes, com uma letra maiúscula e um número ou símbolo.
- **Sessão de suporte:** token temporário do superadmin para uma loja, **somente leitura em toda a API** (`POST/PUT/PATCH/DELETE` → `403`).
- **Limites:** login e resgate de links reservam a vaga antes de conferir a senha ou o link; cadastro e equipe são limitados antes de ler o corpo. O login também tem teto de falhas por conta (somando os IPs) e todo 429 do login demora o mesmo que uma conferência de senha. Valores em `.env.example`.

| Perfil | Papel |
|---|---|
| `SUPER_ADMIN` (global, `platform_role`) | Superpainel; não opera lojas nem compra; sessão de suporte somente leitura |
| `ADMIN` | Tudo da própria loja: dashboard, pedidos, cardápio, equipe e convites, clientes, configurações, assinatura |
| `EMPLOYEE` | Atendente: todos os pedidos da loja, despacho, cancelamento, abrir/fechar a loja, clientes (leitura) |
| `KITCHEN` | Cozinha: só pedidos `PENDING` e `PREPARING`, sem dados de contato do cliente |
| `COURIER` | Entregador: entregas prontas sem responsável e as próprias (nome, telefone, endereço e troco do cliente) |
| `CLIENT` | Cliente global: compra em qualquer loja, endereços e dados da conta |

Pedidos e pagamentos online são exclusivos de `CLIENT` (`ClientOnlyGuard`): a equipe e o superadmin recebem `403`.

---

## 📡 Endpoints

Use o Swagger (`/api`) para os schemas. Contratos detalhados, mensagens e limites: [`docs/saas/arquitetura.md`](../docs/saas/arquitetura.md) (seções 5 e 11). Rotas com `stores/:storeSlug/...` atuam na loja do slug; as antigas sem slug, na loja da equipe autenticada (leituras) ou na loja padrão.

| Área | Rotas principais | Acesso |
|---|---|---|
| Saúde | `GET /health` (`{ "status": "ok" }`) | Público |
| Autenticação | `POST /auth/login`, `GET /auth/me`, `POST /auth/logout`, `POST /auth/logout-all`, `GET /auth/sessions`, `DELETE /auth/sessions/:id`, `POST /auth/forgot-password`, `GET /auth/reset-password/:token`, `POST /auth/reset-password`, `POST /auth/web/refresh`, `POST /auth/web/logout` (sessão do site em cookie) | Público (limitado) / autenticado |
| Minha conta | `GET /account/security`, `POST /account/password`, `POST/DELETE /account/email-change`, `POST /account/email-verification` (autenticado); `GET /account/email-change/:token`, `POST /account/email-change/confirm`, `GET /account/email-revert/:token`, `POST /account/email-revert`, `GET /account/email-verification/:token`, `POST /account/email-verification/confirm` (links públicos, limitados) | Autenticado (escritas: não na sessão de suporte) / público |
| Convites | `GET /invitations/:token`, `POST /invitations/:token/accept` | Público (limitado) |
| Conta e equipe | `POST /users` (cadastro de cliente ou equipe pelo ADMIN), `GET /users`, `GET /users/trash`, `GET/PATCH/DELETE /users/:id`, `PATCH /users/:id/restore`, `DELETE /users/:id/permanent` | Próprio usuário · ADMIN (equipe da própria loja) |
| Painel da loja | `GET/PATCH /store/status`, `GET/PATCH /store/settings`, `PUT/DELETE /store/settings/payments`, `POST/DELETE /store/logo`, `GET/POST /store/invitations`, `DELETE /store/invitations/:id`, `GET /store/customers`, `GET /store/customers/:userId`, `POST/DELETE /store/customers/:userId/block` | ADMIN (status e leitura dos clientes: também EMPLOYEE; bloquear e desbloquear: só ADMIN) |
| Assinatura da loja | `GET /store/subscription`, `POST /store/subscription/{checkout,cancel,resume}` | ADMIN |
| Vitrine | `GET /stores`, `GET /stores/default`, `GET /stores/:storeSlug`, `GET /stores/:storeSlug/status`, `GET /plans`, `POST /stores/signup` | Público |
| Cardápio | `GET /products`, `GET /products/:id`, `GET /addons` (e por slug); `GET /products/trash`, `POST/PATCH/DELETE /products...`, `PATCH /products/:id/restore`, `DELETE /products/:id/permanent`, `POST/PATCH/DELETE /addons...` | Público (leitura) · ADMIN |
| Pedidos | `POST /orders/quote`, `POST /orders`, `GET /orders/my-orders`, `PATCH /orders/:id/cancel` (cliente); `GET /orders`, `GET /orders/:id`, `PATCH /orders/:id`, `PATCH /orders/:id/assign`, `GET /orders/:id/nearby`, `GET /orders/drivers/list`, `GET /orders/summary`, `GET /orders/charts`, `GET /orders/reports` (equipe, conforme o perfil) | Cliente · equipe |
| Pagamentos do delivery | `POST /payment/card`, `POST /payment/pix`, `GET /payment/status/:id`, `POST /payment/:id/cancel`, `POST /payment/webhook` | Cliente (status: pagador ou ADMIN/EMPLOYEE da loja) · webhook público |
| Endereços | `GET /addresses/cep/:cep`, `POST/GET /addresses`, `GET/PATCH/DELETE /addresses/:id` | Público (CEP) · dono |
| Banner e imagens | `GET /promotions/banner`, `POST /uploads` | Público · ADMIN |
| Superpainel | `/platform/dashboard`, `/platform/stores/**`, `/platform/users/**`, `/platform/auth-events`, `/platform/plans/**`, `/platform/subscriptions/**`, `/platform/invoices/**`, `/platform/finance`, `/platform/audit`, `/platform/settings`, `/platform/settings/test-email`, `/platform/support-sessions/**`, `/platform/maintenance/{optimize-images,cleanup-uploads,store-credentials,store-credentials/reencrypt}` | `SUPER_ADMIN` (token normal; o de suporte recebe 403) |
| Cobrança SaaS | `POST /billing/webhook/mercadopago` | Público (assinatura validada com `MP_SAAS_WEBHOOK_SECRET`) |

Ids fora de `1..2147483647` (ou não numéricos) respondem `400 "Id inválido."`. Listas novas são paginadas (`{ items, total, page, pageSize }`); `GET /orders` e `GET /orders/my-orders` mantêm o formato de lista, com `?page`/`?pageSize` (padrão: os 100 mais recentes).

---

## 📦 Regras de negócio dos pedidos

As regras ficam em funções puras em [`src/orders/order-rules.ts`](src/orders/order-rules.ts), cobertas por `order-rules.spec.ts`.

**Preço calculado no servidor.** O cliente envia apenas produtos, quantidades e opções:

```json
{
  "type": "DELIVERY",
  "addressId": 3,
  "items": [
    { "productId": 1, "quantity": 2, "addonIds": [4, 4], "meatPoint": "Ao Ponto",
      "removedIngredients": ["Cebola"], "observation": "Capricha no molho" }
  ],
  "paymentMethod": "MONEY",
  "changeFor": "R$ 100,00"
}
```

- O preço unitário é o promocional quando ele existe e é menor que o normal. Adicionais repetidos em `addonIds` indicam a quantidade (`[4, 4]` = 2×).
- Só os adicionais permitidos no produto são aceitos; **produto sem adicionais configurados não aceita nenhum** (400). Produtos e adicionais indisponíveis, na lixeira ou de outra loja são recusados ("não encontrado", sem revelar o nome).
- Limites por pedido: 50 linhas, até 50 unidades por item, até 50 adicionais por item e observação de até 300 caracteres.
- **Retrato do preço:** cada item grava `unit_price` e `addons_snapshot`, e o pedido de entrega grava o retrato do endereço.
- **Loja fechada:** o orçamento devolve `store_open: false`, e o pedido e os pagamentos novos respondem `400`. **Loja que não pode vender** (suspensa, desativada, assinatura suspensa/cancelada ou ausente): `403` com mensagem neutra para o cliente.
- **Limites de abuso:** `ORDER_CREATE` (cliente + loja) e `ORDER_CREATE_IP`; no máximo N pedidos pagos na entrega aguardando a loja por cliente (N = limite de `ORDER_CREATE`, padrão 10) → `429`. O limite mensal do plano conta também os pagamentos online em andamento.
- **Número do pedido por loja:** toda resposta de pedido traz `number` (1..N na loja, sem buraco nem repetição), atribuído pelo banco num gatilho com o contador `store_order_counters` e imutável; `number` no corpo → `400`. O `id` continua sendo a chave das rotas e do app mobile.
- **Cliente bloqueado pela loja** (`POST/DELETE /store/customers/:userId/block`): `403 "Não é possível fazer pedidos nesta loja. Fale com a loja."` no orçamento, no pedido pago na entrega e nas cobranças PIX/cartão daquela loja (conferido em `OrderPricingService.price()`); outras lojas não são afetadas, e um pagamento já aprovado continua virando pedido.

**Entrega por bairro.** A loja padrão usa as zonas da plataforma (`DELIVERY_ZONES_JSON`/`DELIVERY_ZONES_FILE`, padrão em [`src/orders/delivery-zones.config.ts`](src/orders/delivery-zones.config.ts)); as demais lojas configuram as próprias zonas e taxas no painel e, sem zonas, não fazem entrega. O nome inteiro do bairro é comparado, sem diferenciar maiúsculas nem acentos; uma zona também pode ter **faixas de CEP**. O bairro usado é o do CEP, conferido pela API (ViaCEP/BrasilAPI) no cadastro do endereço, na edição e no orçamento; sem o serviço, vale o digitado. Fora das zonas, a loja cobra a taxa padrão (`outside_zones: fallback`) ou recusa (`refuse` → `400` com `code: DELIVERY_OUT_OF_AREA` no orçamento, no pedido e nas cobranças, antes de cobrar). Retirada (`TAKEOUT`) é grátis.

**Pagamento:** `PIX`, `CREDIT_CARD`, `DEBIT_CARD` ou `MONEY`. Com `paymentId`, o pedido foi pago online; sem ele, na entrega ou na retirada.
- O troco só vale para `MONEY`, precisa ser maior ou igual ao total e no máximo **R$ 200,00 acima** dele.
- Pagamentos online **viram pedido no servidor** quando são aprovados. `POST /orders` com `paymentId` é idempotente: devolve o pedido já criado com aquele pagamento (pagamento de outro cliente ou loja responde como inexistente).
- Um pedido pago na entrega ou na retirada vira `PAID` quando é concluído (`DONE`).

**Status e transições** (`PATCH /orders/:id`):

| Perfil | Pode fazer |
|---|---|
| `ADMIN`, `EMPLOYEE` | Qualquer transição válida, inclusive cancelar |
| `KITCHEN` | `PENDING → PREPARING` e `PREPARING → READY_FOR_PICKUP` |
| `COURIER` | `READY_FOR_PICKUP → DELIVERING` (assume o pedido se ainda não tiver entregador) e `DELIVERING → DONE` só nas próprias entregas |

- `DONE` e `CANCELED` são finais. `TAKEOUT` nunca entra em `DELIVERING`. Transição impossível → `400 "Transição inválida: X → Y"`; não permitida ao perfil → `403`; pedido alterado por outra pessoa → `409`. Cozinha e entregador recebem `404 "Pedido não encontrado."` ao alterar ou cancelar um pedido fora da própria etapa (inclusive o entregador que perde a corrida para pegar uma entrega).
- **Cancelamento** (`PATCH /orders/:id/cancel`): o dono enquanto `PENDING`; a gestão enquanto não for final. Pedido pago online gera **estorno**.
- **Despacho** (`PATCH /orders/:id/assign`): só para `DELIVERY` em `PREPARING`, `READY_FOR_PICKUP` ou `DELIVERING`, com um `COURIER` ativo da mesma loja.
- **Dashboard e relatórios:** no fuso da loja; o faturamento conta apenas pedidos `PAID` e não cancelados. Relatórios avançados dependem do plano.

---

## 💳 Pagamentos (Mercado Pago)

- **Por loja:** cada loja informa a própria conta em `PUT /store/settings/payments` (token cifrado com `CREDENTIALS_ENCRYPTION_KEY`, nunca devolvido). `MP_ACCESS_TOKEN` vale só para a loja padrão sem credencial própria. Loja sem credencial: pagamento online indisponível.
- **Modo** (`src/payment/payment-rules.ts`): sandbox só com `NODE_ENV=development` ou `test` (`PAYMENT_SANDBOX=true`, ou vazio sem token / com token `TEST-`): cartão recusado vira aprovação simulada e o PIX é aprovado após `PIX_SANDBOX_APPROVAL_SECONDS`; respostas simuladas trazem `simulation: true`. Em produção não há simulação.
- **Fluxo:** o front envia o `order` e uma `idempotencyKey` para `/payment/card` ou `/payment/pix`; a API calcula o valor, grava o pagamento (`payments`, com o retrato do carrinho) e cobra. Quando o pagamento é aprovado (resposta do cartão, `GET /payment/status/:id`, webhook ou conciliação a cada 60 s), **a própria API cria o pedido**.
- **Loja que não pode vender:** o pagamento aprovado não vira pedido; o valor é estornado e o caso fica na auditoria. Loja apenas fechada continua recebendo o pedido do pagamento aprovado.
- **Limites:** `PAYMENT_CREATE` (cliente + loja), `PAYMENT_CREATE_IP` e no máximo 5 cobranças pendentes por cliente e loja (`429`); o mesmo carrinho com um PIX pendente devolve o mesmo PIX.
- **Webhook** (`POST /payment/webhook`): o corpo não é confiável; cada pagamento é reconsultado no Mercado Pago (no máximo a cada 15 s), com limite por IP (`PAYMENT_WEBHOOK`) e fila limitada.
- PIX vence em `PIX_EXPIRATION_MINUTES` e pode ser cancelado em `POST /payment/:id/cancel`. Cancelar um pedido pago online gera estorno (`REFUNDED`); se falhar, `REFUND_PENDING`.
- **Estorno ou contestação feitos no Mercado Pago** depois da aprovação: o webhook reconsulta também os pagamentos aprovados e marca o pedido com `payment_status = REFUNDED` (auditoria `payment.reversed`); o painel avisa a equipe para não entregar. A finalização de um pagamento aprovado usa uma trava do banco por pagamento (segura com várias instâncias), e `GET /payment/status/:id` consulta o Mercado Pago no máximo a cada 5 s por pagamento.

Cartão de teste: `5031 4332 1540 6351`, validade `11/30`, CVV `123`, titular `APRO`, CPF `123.456.789-09`.

---

## 🖼 Imagens

- Produtos, adicionais, logo da loja, avatares e `POST /uploads` aceitam **JPG, PNG ou WebP de até 5 MB**, no campo `file`, com o tipo conferido pelo conteúdo. A imagem é rotacionada conforme o EXIF, limitada a 800 px de largura e convertida para **WebP** (qualidade 80).
- Limites: `UPLOAD` por conta ou IP (antes de ler o corpo; conta também o multipart que falha no parse), até 40 megapixels, multipart com até 300 campos de 16 KB, nomes de campo com no máximo 2 níveis de aninhamento e índice até 300, e no máximo 2 conversões simultâneas por processo. Só os decodificadores de JPEG, PNG e WebP ficam ligados no libvips.
- **Cota de armazenamento por plano** (`max_storage_mb`): soma das imagens da loja (`s<storeId>-`), conferida **antes de gravar** (403 com o aviso do plano); avatares não contam. Uso × limite em `storage` nas respostas da assinatura.
- Os arquivos ficam em `UPLOADS_DIR` e são servidos em `/uploads/<arquivo>` com `nosniff` e CSP restrita. Imagens da loja levam o prefixo `s<storeId>-`; fotos de perfil enviadas por uma conta existente, `u<id>-` (a foto anterior da própria conta é apagada).
- O campo `image` de produtos e adicionais aceita só arquivos da própria loja, URLs `https://` ou o valor que já tinha. O avatar em texto aceita só os ícones prontos de `src/users/avatar.ts`.
- Se a operação falhar depois do upload, a imagem recém-gravada é apagada. A otimização das imagens antigas roda em segundo plano pelo superpainel.
- **Limpeza dos arquivos sem uso** (superpainel, `POST /platform/maintenance/cleanup-uploads`): `check` só conta; `delete` (com `confirm: true`) apaga as imagens do primeiro nível de `UPLOADS_DIR` sem referência há mais de 24 h (produtos e adicionais, inclusive na lixeira, avatares, inclusive de contas apagadas, e logos), reconferindo cada lote no banco e no disco logo antes. Nunca segue atalhos nem apaga arquivos fora do padrão da API; o resumo guarda só números. Com `UPLOADS_CLEANUP_INTERVAL_HOURS`, o `delete` também roda sozinho a cada intervalo (auditado como sistema). `/uploads` sai com cache de 30 dias (`immutable`).

---

## 🗄 Banco de dados

O schema vem das migrations em [`src/database/migrations`](src/database/migrations) (registradas em `index.ts`):

| Migration | O que faz |
|---|---|
| `BaselineSchema` | Schema da versão de loja única (não faz nada num banco existente) |
| `MultiTenantFoundation` | Tabelas da plataforma, `store_id` nas tabelas operacionais e migração dos dados para a loja inicial |
| `TenancyIndexes` | Índices por loja/cliente e únicos parciais (idempotente) |
| `MaintenanceJobs` | Execuções da manutenção em segundo plano |
| `PlatformIntegrity` | `subscriptions.suspended_by`, CHECK do papel global e triggers de mesma loja / `store_id` imutável |
| `OrderNumbersAndCustomerBlocks` | `orders.number` com backfill por loja (ordem de criação), contador `store_order_counters`, gatilhos de numeração e de imutabilidade, e `store_customer_blocks` |
| `AuthSessions` | Tabela `auth_sessions` (uma linha por token de sessão emitido, com `jti` único). O `down()` encerra as sessões de todas as contas |
| `AddressZoneLocation` | Bairro, cidade e UF conferidos pelo CEP em `addresses` (colunas opcionais, sem backfill) |
| `PlanStorageLimit` | `plans.max_storage_mb` (nulo = ilimitado) |
| `StoreSlugHistoryAndCancelOrigin` | `subscriptions.cancel_scheduled_by` (preenchida pelo histórico) e `store_slug_history` (slugs antigos reservados) |
| `PerformanceIndexes` | Índices de desempenho com `CONCURRENTLY`, fora de transação (os de trigramas só com `pg_trgm`) |
| `AccountEmailVerification` | `users.email_verified_at` e `account_email_tokens` |
| `AuthSessionRefresh` | Colunas da sessão do site em cookie em `auth_sessions` |

- Tabelas globais: `stores`, `store_slug_history`, `plans`, `subscriptions`, `subscription_events`, `subscription_invoices`, `billing_webhook_events`, `platform_settings`, `audit_logs`, `support_sessions`, `auth_sessions`, `maintenance_jobs`, `users`, `account_email_tokens`, `addresses`, `invitations`, `password_reset_tokens`. Por loja: `products`, `addons`, `orders`, `payments` (+ junções), `store_customer_blocks` e `store_order_counters` (sem entidade: só o gatilho usa). `store_config` fica como histórico da versão de loja única.
- A `OrderNumbersAndCustomerBlocks` renumera os pedidos existentes por loja: telas e conversas antigas que citavam `Pedido #<id>` passam a mostrar outro número (o `id` não muda). Depois de restaurar ou importar pedidos, confira o contador ([`operacao.md`](../docs/saas/operacao.md#83-clientes-bloqueados-e-número-do-pedido)).
- `users`, `products` e `addons` usam exclusão lógica (`deleted_at`); lojas nunca são apagadas, só desativadas.
- Atualizar, reverter e validar migrations: [`docs/saas/operacao.md`](../docs/saas/operacao.md#4-migrations). Mantenha `DB_SYNCHRONIZE=false`.

---

## 🧪 Testes

```bash
npx jest              # unitários (sem banco)
npm run test:cov      # com cobertura
```

O teste E2E da API com Jest (`test/app.e2e-spec.ts`) sobe o `AppModule` completo e precisa de um banco de teste já criado:

```bash
DB_DATABASE=comestra_test npm run test:e2e                  # Linux
$env:DB_DATABASE="comestra_test"; npm run test:e2e          # Windows (PowerShell)
```

A suíte ponta a ponta completa (API + navegador, com Playwright, inclusive isolamento entre lojas, superpainel e cobrança) fica em [`../e2e`](../e2e/README.md).

---

## ✅ Produção (resumo)

- [ ] `npm run build`, migrations (`npm run migration:run:prod`) e `npm run start:prod` (que já define `NODE_ENV=production`).
- [ ] `JWT_SECRET` aleatório com 32+ caracteres e `CREDENTIALS_ENCRYPTION_KEY` guardada em cofre.
- [ ] Superadmin criado com `npm run platform:superadmin:prod -- --email=...`; nenhuma conta de demonstração no banco.
- [ ] `DB_SYNCHRONIZE=false`, `SWAGGER_ENABLED` desligado, `CORS_ORIGINS` com os domínios reais e `TRUST_PROXY` com o número de proxies (nunca `true`).
- [ ] `JWT_LEGACY_ISSUED_BEFORE` com o instante do deploy que aplica `AuthSessions` (ou aceite que todos entrem de novo).
- [ ] HTTPS, `UPLOADS_DIR` em volume persistente, `APP_WEB_URL` e `PUBLIC_API_URL` reais e `MP_NOTIFICATION_URL` pública; site e API no mesmo site para a sessão em cookie.
- [ ] E-mail por SMTP (`MAIL_DRIVER=smtp`, `SMTP_*`, `MAIL_FROM`) conferido com o e-mail de teste do superpainel; `HOST=127.0.0.1` quando o proxy roda na mesma máquina.
- [ ] Log da subida: `Ambiente: production` e nenhum aviso de configuração.

Checklist completo: [`docs/saas/operacao.md`](../docs/saas/operacao.md#9-checklist-de-produção).

---

## 🛣 Roadmap da API

- [x] E-mails em HTML com a marca da loja, confirmação e troca de e-mail (modo `compat`)
- [x] Access token curto com refresh rotativo em cookie HttpOnly no site e recusa dos tokens sem `jti` fora da janela de transição
- [x] Cota de armazenamento por plano, limpeza agendada, frete por CEP e índices de desempenho
- [ ] Fila de reenvio dos e-mails, provedores por API e o modo `strict` da conta (fase 1b)
- [ ] Refresh no app mobile, sessão deslizante e checkout da assinatura sem conexão aberta durante a chamada ao provedor
- [ ] Agregar relatórios no SQL, paginação por cursor e retenção da auditoria
- [ ] Cancelar as cobranças pendentes do cliente ao bloqueá-lo na loja e busca de pedidos por número
- [ ] Validação de `x-signature` no webhook do delivery (segredo por loja)
- [ ] Limites distribuídos (Redis) e cancelamento imediato das cobranças pendentes ao bloquear uma loja
- [ ] Pausa/retomada da cobrança recorrente no Mercado Pago durante a suspensão pela plataforma
- [ ] Eventos em tempo real (WebSockets) e cupons aplicados no checkout
