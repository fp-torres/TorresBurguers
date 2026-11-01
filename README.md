<div align="center">

<img src="frontend-web/public/favicon.svg" alt="Marca Comestra" width="96" height="96" />

# Comestra

**Cozinha, balcão e entrega no mesmo compasso.**

Plataforma SaaS multi-loja de delivery e gestão para restaurantes: cada estabelecimento tem a própria vitrine, painel, equipe, cardápio, pedidos, pagamentos e assinatura, e a Comestra administra tudo por um superpainel.

![NestJS](https://img.shields.io/badge/NestJS_11-E0234E?style=for-the-badge&logo=nestjs&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)
![React](https://img.shields.io/badge/React_19-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![Vite](https://img.shields.io/badge/Vite_7-646CFF?style=for-the-badge&logo=vite&logoColor=white)
![Expo](https://img.shields.io/badge/Expo_SDK_54-000020?style=for-the-badge&logo=expo&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Mercado Pago](https://img.shields.io/badge/Mercado_Pago-00B1EA?style=for-the-badge&logo=mercadopago&logoColor=white)
![Playwright](https://img.shields.io/badge/E2E-Playwright-2EAD33?style=for-the-badge&logo=playwright&logoColor=white)

[Produto](#-o-comestra) · [Funcionalidades](#-funcionalidades) · [Contas de demonstração](#-contas-de-demonstração) · [Como rodar](#-como-rodar) · [Variáveis](#-variáveis-de-ambiente) · [Pagamentos](#-pagamentos-em-sandbox) · [Testes](#-testes) · [Produção](#-checklist-de-produção) · [Documentação](#-documentação)

</div>

---

## 🍳 O Comestra

O **Comestra** é um SaaS multi-tenant: uma única instalação atende muitos estabelecimentos, com os dados de cada um isolados no servidor. Quatro frentes usam a mesma API:

| Frente | Para quem | O que oferece |
|---|---|---|
| 🌐 **Diretório e vitrines** (web) | Clientes | Diretório de lojas em `/` e a vitrine de cada loja em `/loja/<slug>`: cardápio, carrinho por loja, checkout com PIX, cartão ou pagamento na entrega e Meus Pedidos (de todas as lojas) |
| 🧑‍🍳 **Painel da loja** (web) | Dono, atendentes, cozinha e entregadores | Dashboard, quadro de pedidos por etapa, despacho, cardápio, equipe e convites, clientes, configurações da loja (entrega, horários, identidade, Mercado Pago) e assinatura |
| 🛡 **Superpainel** (web, `/platform`) | Superadministrador da Comestra | Lojas, usuários, planos, assinaturas e faturas, financeiro (MRR, ARR, churn, GMV), auditoria, configurações da plataforma e sessão de suporte somente leitura |
| 📱 **App mobile** (Android e iOS) | Clientes e equipe | Fora do escopo desta fase: continua funcionando pelas rotas antigas, na **loja padrão** da plataforma |

**Diferenciais**

- **Isolamento entre lojas no servidor.** A loja vem do usuário autenticado ou do slug da rota, nunca de um campo enviado pelo navegador. Recurso de outra loja responde `404`, e o banco reforça com `store_id` obrigatório, chaves estrangeiras, triggers e `store_id` imutável.
- **Cada pessoa vê só o próprio trabalho.** Superadmin (global), Administrador, Atendente, Cozinha, Entregador e Cliente, com as permissões aplicadas pela API. A cozinha só vê os pedidos em preparo e o entregador só as entregas dele.
- **Dinheiro separado.** O pagamento do delivery cai na conta Mercado Pago **da loja**; a assinatura SaaS é cobrada da loja pela Comestra em outro fluxo, com outras tabelas, credenciais e webhooks.
- **O preço é calculado no servidor** e cada item guarda o preço e os adicionais cobrados na hora da compra.
- **O cartão nunca passa pelo servidor.** Ele é tokenizado pelo Mercado Pago no navegador com a chave pública da loja.
- **Tudo auditado.** Ações do superpainel, autenticação, equipe, configurações, assinaturas, sessões de suporte e pagamentos que não viram pedido ficam na auditoria, sem senhas nem segredos.

---

## ✨ Funcionalidades

### 🛡 Superpainel (plataforma)
- **Dashboard:** lojas por situação, assinaturas, MRR, ARR (projeção), churn, pedidos, GMV das lojas e receita da plataforma em blocos separados, distribuição por plano e alertas (inadimplência, suspensões, estornos pendentes, lojas sem administrador, teste acabando, loja desativada ainda cobrada...)
- **Lojas:** criação (com assinatura e convite do responsável), dados administrativos, slug e responsável, suspender, reativar, desativar e restaurar (com motivo; nada é apagado), equipe, convites, métricas e auditoria da loja
- **Usuários:** busca global, bloqueio com motivo, encerrar sessões e link de redefinição de senha
- **Planos e assinaturas:** planos configuráveis (preço, periodicidade, teste grátis, limites de equipe/produtos/pedidos/**armazenamento** e recursos), troca de plano, cancelamento agendado (pela loja ou pela plataforma) ou imediato, suspensão e reativação, faturas com registro manual de pagamento
- **Sessão de suporte:** o superadmin vê o painel de uma loja como o administrador dela, **somente leitura**, por tempo limitado e com motivo registrado
- **Configurações:** loja padrão, tolerância da inadimplência, duração do suporte e autoatendimento de novas lojas; **e-mail transacional** (driver, servidor SMTP, remetente e e-mail de teste); **manutenção** em segundo plano: otimização de imagens, limpeza dos arquivos sem uso em `/uploads` (verificar e apagar, ou **automática** com `UPLOADS_CLEANUP_INTERVAL_HOURS`) e regravação das credenciais Mercado Pago das lojas no formato atual

### 🧾 Painel da loja
- **Quadro de pedidos (kanban)** por etapa: Novos → Preparando → Aguardando motoboy / Retirar no balcão → Em entrega → Concluídos (e Cancelados), atualizado a cada 5 s. Cada loja numera os próprios pedidos (**Pedido #1, #2, #3...**), sem buraco nem repetição
- **Ações e visão por perfil**, validadas pela API ([tabela de transições](#transições-de-status-por-perfil)): a cozinha só vê e prepara os pedidos novos e em preparo (sem dados de contato do cliente); o entregador vê as entregas prontas e as dele; atendente e administrador conduzem tudo
- **Despacho** com sugestão de pedidos do mesmo bairro; o entregador também pode pegar uma entrega pronta
- **Cardápio** com fotos, preço promocional, ingredientes, adicionais permitidos, pausa de esgotados e lixeira
- **Equipe por convite** (link de uso único), lixeira e proteção do responsável pela loja
- **Clientes** que compraram na loja, com o histórico de pedidos dela, e **bloqueio de cliente** com motivo (só o administrador): o cliente bloqueado não compra naquela loja e continua comprando nas outras
- **Configurações:** dados comerciais, endereço, horários, fuso, entrega e retirada (zonas por **bairro e/ou faixa de CEP**, taxas próprias e a escolha entre cobrar uma taxa padrão ou **recusar** endereços fora das zonas), mensagens de aberto/fechado, logo e cor (conforme o plano) e credenciais Mercado Pago da loja
- **Assinatura:** plano, limites e uso (inclusive o medidor de armazenamento), faturas e cancelamento no fim do período
- **Pagamento estornado no Mercado Pago:** o quadro destaca em vermelho o pedido cujo pagamento foi estornado ou contestado depois da aprovação, para a equipe não entregar sem receber
- **Dashboard e relatórios** no fuso da loja (relatórios avançados conforme o plano)

### 🛒 Vitrine e checkout
- Diretório de lojas e vitrine por slug, com a identidade visual da loja
- Cardápio com busca, categorias, combos e ofertas; personalização (ponto da carne, ingredientes, adicionais, observação)
- Carrinho **por loja**, retirada no balcão ou entrega com endereço salvo e busca de CEP (ViaCEP, com BrasilAPI como reserva)
- Taxa e tempo de entrega calculados pela API conforme as zonas da loja, com o **bairro conferido pelo CEP**; fora da área de uma loja que recusa, o carrinho avisa antes de pagar e oferece a retirada
- **Minha conta:** e-mail confirmado por link, troca de e-mail com confirmação no endereço novo e "Não fui eu" no antigo, troca de senha com a senha atual
- Pagamento online por PIX ou cartão (Mercado Pago da loja) ou na entrega/retirada (dinheiro com troco ou maquininha)
- **O servidor cria o pedido quando o pagamento é aprovado**, mesmo que o cliente feche a página; se a loja não puder mais vender, o valor é estornado
- Loja fechada ou indisponível: o cardápio continua visível e o checkout fica bloqueado com uma mensagem neutra
- Tema claro, escuro ou automático

### 🔐 Segurança
- Autorização no backend em todas as rotas; `404` uniforme para recursos de outra loja
- **Sessão do site em cookie:** token de acesso de 15 min só na memória da aba e refresh rotativo em cookie `HttpOnly`/`SameSite=Strict`, com detecção de reuso (o app mobile continua com o token de sempre)
- Sessões registradas por token (`jti`): sair encerra a sessão no servidor, **Sessões ativas** lista os aparelhos (encerrar um ou todos) e o suporte é encerrado pelo próprio token. Também: sessões revogáveis (`token_version`), conta bloqueável, recuperação de senha por link de uso único (com SMTP, o link do superpainel vai só ao dono da conta) e convites que só valem enquanto quem convidou ainda pode convidar
- Limites de tentativas e de abuso: login (por IP e **por conta**), cadastro, links, pedidos, cobranças, webhook, uploads, endereços, equipe, troca de credenciais, e-mails de conta e convites por destinatário
- Uploads com tipo conferido pelo conteúdo, limite de resolução e de campos e conversão para WebP
- Cabeçalhos de segurança na API, Content-Security-Policy no build do site e sessão independente por aba (sincronizada entre abas)
- Detalhes em [`docs/saas/arquitetura.md`](docs/saas/arquitetura.md) (seções 4 e 11.7)

---

<a id="-usuários-padrão-um-por-perfil"></a>

## 👥 Contas de demonstração

Criadas na subida da API **somente com `NODE_ENV=development` ou `test`** (variável `SEED_DEMO_USERS`, ligada por padrão nesses ambientes), se ainda não existirem. Num banco vazio, a subida também cria a loja **Lanchonete Demo** (`/loja/demo`), que vira a loja padrão; a equipe demo trabalha na loja padrão.

| Perfil | E-mail | Senha | Onde entrar | O que pode fazer |
|---|---|---|---|---|
| **Administrador**<br>`ADMIN` | `admin@comestra.com.br` | `Admin@123` | [localhost:5173/login](http://localhost:5173/login) → Dashboard | Tudo da própria loja: Dashboard, pedidos, cardápio, equipe e convites, clientes, lixeira, configurações e assinatura |
| **Atendente**<br>`EMPLOYEE` | `atendente@comestra.com.br` | `Atendente@123` | [localhost:5173/login](http://localhost:5173/login) → Pedidos | Conduz todo o fluxo dos pedidos, despacha, cancela, abre e fecha a loja e consulta os clientes |
| **Cozinha**<br>`KITCHEN` | `cozinha@comestra.com.br` | `Cozinha@123` | [localhost:5173/login](http://localhost:5173/login) → Monitor da Cozinha | Vê os pedidos novos e em preparo: aceita e marca como pronto |
| **Entregador**<br>`COURIER` | `entregador@comestra.com.br` | `Entregador@123` | [localhost:5173/login](http://localhost:5173/login) → Painel de Entregas | Pega entregas prontas, vê endereço e troco e confirma as próprias entregas |
| **Cliente**<br>`CLIENT` | `cliente@comestra.com.br` | `Cliente@123` | [localhost:5173/signin](http://localhost:5173/signin) → diretório | Compra em qualquer loja: carrinho, checkout, Meus Pedidos e dados da conta |
| **Superadmin**<br>`SUPER_ADMIN` (global) | `superadmin@comestra.com.br` | `Superadmin@123` | [localhost:5173/login](http://localhost:5173/login) → `/platform` | Superpainel inteiro. **Não é criado em development por padrão**: só em `test` (suíte E2E), com `SEED_DEMO_SUPERADMIN=true` ou com `npm run seed -- --with-superadmin` |

- **Seu próprio superadmin:** `cd backend && npm run platform:superadmin -- --email=voce@exemplo.com --name="Seu Nome"` (a senha aparece uma única vez). Detalhes e recuperação de acesso em [`docs/saas/operacao.md`](docs/saas/operacao.md#5-superadministrador-criação-e-recuperação-de-acesso).
- **Restaurar:** `cd backend && npm run seed` recria as contas que faltam, tira da lixeira e redefine nome, perfil e senha. Ele nunca roda em produção (o antigo `--force` não existe mais).
- Na subida, contas que já existem nunca são alteradas. Os e-mails usam o domínio de `BRAND.domain` (`backend/src/config/brand.ts`).

> [!WARNING]
> **As senhas desta tabela são públicas.** Em produção (`NODE_ENV=production` ou vazio) a API nunca cria essas contas. Antes de expor uma API de desenvolvimento pela rede ou por túnel (`npm run tunnel` do app, ngrok), desligue `SEED_DEMO_USERS`, troque ou exclua as contas demo e confira o superadmin: bancos criados por versões anteriores podem ter `superadmin@comestra.com.br` com a senha pública (a subida avisa no log). Corrija com `npm run platform:superadmin -- --email=superadmin@comestra.com.br --reset-password` (ou `--revoke`).

### Transições de status por perfil

Status do pedido: `PENDING` (novo) → `PREPARING` (em preparo) → `READY_FOR_PICKUP` (pronto) → `DELIVERING` (em entrega) → `DONE` (concluído), ou `CANCELED`. A API valida cada mudança: uma transição impossível responde `400`, e uma transição possível que não cabe ao perfil responde `403`. Se outra pessoa mexeu no pedido antes, a resposta é `409`.

| Ação | Administrador e Atendente | Cozinha | Entregador |
|---|:---:|:---:|:---:|
| Aceitar: `PENDING` → `PREPARING` | ✅ | ✅ | — |
| Marcar como pronto: `PREPARING` → `READY_FOR_PICKUP` | ✅ | ✅ | — |
| Despachar com entregador escolhido (`PATCH /orders/:id/assign`) | ✅ | — | — |
| Pegar para entrega: `READY_FOR_PICKUP` → `DELIVERING` | ✅ | — | ✅ (assume o pedido sem responsável) |
| Confirmar entrega: `DELIVERING` → `DONE` | ✅ | — | ✅ (só as próprias entregas) |
| Entregar no balcão (retirada): `READY_FOR_PICKUP` → `DONE` | ✅ | — | — |
| Cancelar | ✅ (até o pedido ser concluído) | — | — |

- `DONE` e `CANCELED` são finais, e pedidos de retirada nunca passam por `DELIVERING`.
- A cozinha lê só pedidos `PENDING` e `PREPARING`; o entregador lê as entregas prontas sem responsável, as próprias em andamento e as próprias concluídas ou canceladas nas últimas 24 h. Fora disso, `404`.
- O **cliente** cancela o próprio pedido enquanto ele está `PENDING`. Pedidos e pagamentos são feitos apenas por contas de cliente: a equipe e o superadmin não compram pelo sistema.

---

## 🏗 Arquitetura e stack

```
  Diretório, vitrines, painel da loja e superpainel (web)     App mobile (Expo, fora do escopo)
  React 19 · Vite 7 · :5173                                   React Native 0.81 · SDK 54
                         │                                          │
                         └──────────── REST/JSON + JWT ─────────────┘
                                            │
                                            ▼
                    API multi-tenant · NestJS 11 · :3000
                    Swagger /api · /health · /uploads ──▶ Mercado Pago de cada loja (cartão e PIX)
                                            │         ──▶ Mercado Pago da Comestra (assinaturas SaaS)
                                            │         ──▶ ViaCEP / BrasilAPI · football-data.org
                                            ▼
                         PostgreSQL 14+ (TypeORM + migrations)
```

| Camada | Tecnologias |
|---|---|
| **API** | NestJS 11, TypeScript, TypeORM 0.3 (migrations), PostgreSQL, Passport JWT, bcrypt, class-validator, Swagger, Sharp, SDK do Mercado Pago, cache-manager, nodemailer 10.1.7 (e-mail por SMTP; tipos próprios, Node ≥ 20) |
| **Web** | React 19, Vite 7, TailwindCSS 4, React Router 7, Axios, Recharts, Lucide e Iconify, SDK JS v2 do Mercado Pago |
| **Mobile** | React Native 0.81, Expo SDK 54, NativeWind 2, React Navigation 7, Axios, AsyncStorage |
| **Testes** | Jest (unitários da API) e Playwright (ponta a ponta: API e navegador) |

### Estrutura do projeto

```bash
comestra/
├── backend/                  # API REST multi-tenant (NestJS + TypeORM + PostgreSQL)
│   ├── src/
│   │   ├── tenancy/          # resolução da loja, guards e situação da loja × capacidades
│   │   ├── platform/         # superpainel: lojas, usuários, suporte, configurações, métricas, CLI do superadmin
│   │   ├── billing/          # planos, assinaturas, faturas, rotina e webhook da cobrança SaaS
│   │   ├── audit/            # auditoria (metadados sanitizados)
│   │   ├── auth/             # login, JWT, sessões registradas (logout, sessões ativas), sessão do site em cookie, recuperação de senha, suporte somente leitura
│   │   ├── account/          # minha conta: troca de senha, confirmação e troca de e-mail ("Não fui eu")
│   │   ├── invitations/      # convites da equipe
│   │   ├── users/            # clientes e equipe, regras de acesso, avatar
│   │   ├── products/         # cardápio e adicionais por loja
│   │   ├── orders/           # pedidos, preço no servidor, transições, visão por perfil, dashboard e relatórios
│   │   ├── payment/          # Mercado Pago por loja (cartão e PIX), sandbox, webhook e conciliação
│   │   ├── store/            # configurações, status, clientes e credenciais da loja
│   │   ├── addresses/        # endereços, busca de CEP e conferência do bairro pelo CEP
│   │   ├── promotions/       # banner do dia
│   │   ├── notifications/    # e-mails em texto e HTML com a marca da loja (driver de log ou SMTP) e links
│   │   ├── common/           # uploads, limites, criptografia, manutenção, validações
│   │   ├── config/           # marca, variáveis de ambiente, JWT, CORS e cabeçalhos (app-setup.ts)
│   │   └── database/         # data source, migrations, seeds (loja e contas de demonstração)
│   ├── scripts/              # scripts opcionais de dados (loja padrão)
│   ├── uploads/              # imagens enviadas (servidas em /uploads)
│   ├── Dockerfile
│   └── .env.example
├── frontend-web/             # diretório, vitrines, painel da loja e superpainel (React + Vite)
│   ├── src/                  # pages (Client, Directory, Auth, painel e Platform), components/ui, contexts,
│   │                         # layouts, routes, services, hooks, types, utils, config
│   ├── Dockerfile · nginx.conf # imagem do site (Nginx, mesma origem: /api → API)
│   └── .env.example
├── frontend-mobile/          # app do cliente e da equipe (Expo) — fora do escopo desta fase
├── e2e/                      # testes ponta a ponta (Playwright): identity, commerce, tenancy, platform, billing, security, web
├── docker-compose.yml · .env.docker.example   # Docker: banco, API e site (docs/saas/docker.md)
└── docs/
    ├── saas/                 # arquitetura.md, operacao.md, docker.md, diagnostico.md
    └── guia-completo-comestra.html / Guia_Completo_Comestra.pdf
```

Cada parte tem o próprio README: [backend](backend/README.md) · [web](frontend-web/README.md) · [mobile](frontend-mobile/README.md) · [e2e](e2e/README.md).

---

## 🚀 Como rodar

### Pré-requisitos

- **Node.js 22+** (LTS) e npm
- **PostgreSQL 14+** (com `pg_dump` para os backups)
- Para os testes E2E: **Google Chrome**
- Para o app (opcional, fora do escopo): **Expo Go** compatível com o **SDK 54**

```bash
git clone <URL_DO_REPOSITORIO> comestra
cd comestra
```

### 🐳 Rodando com Docker

Sobe banco, API e site com um comando (requer Docker Desktop ou Docker Engine com Compose v2):

```bash
cp .env.docker.example .env.docker      # PowerShell: Copy-Item .env.docker.example .env.docker
# preencha POSTGRES_PASSWORD, JWT_SECRET e CREDENTIALS_ENCRYPTION_KEY (os comandos de geração estão no arquivo)
docker compose up -d --build
```

Abra <http://localhost:8080> (API em <http://localhost:8080/api/health>). O modelo vem no modo demonstração: loja `/loja/demo` e as [contas de demonstração](#-contas-de-demonstração). Superadmin: `docker compose exec api npm run platform:superadmin:prod -- --email=voce@empresa.com.br --name="Seu Nome"`. Parar: `docker compose down` (os dados ficam nos volumes). Backup, HTTPS, produção e problemas: [`docs/saas/docker.md`](docs/saas/docker.md).

### Do zero

**1. Banco de dados.** Crie um banco vazio chamado `comestra`. As tabelas são criadas pelas **migrations** na primeira subida da API.

```powershell
# Windows (PowerShell): troque 18 pela versão instalada (ou use o pgAdmin)
& "C:\Program Files\PostgreSQL\18\bin\createdb.exe" -U postgres comestra
```

```bash
# Linux
sudo -u postgres createdb comestra
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'sua_senha';"   # se o postgres ainda não tem senha
```

**2. API (backend)**

```bash
cd backend
cp .env.example .env    # Windows: Copy-Item .env.example .env
# edite o .env: NODE_ENV=development e DB_PASSWORD (deixe DB_SYNCHRONIZE vazio, que vale false)
npm install
npm run start:dev
```

> O `.env.example` vem com `NODE_ENV=production`, que é o modo seguro. Para desenvolver, troque para `development`: só assim a API cria os dados de demonstração, liga o sandbox de pagamentos e usa segredos de desenvolvimento.

Na primeira subida, a API aplica as migrations e cria a loja demo e as [contas de demonstração](#-contas-de-demonstração).

- Saúde: <http://localhost:3000/health> → `{"status":"ok"}`
- Swagger: <http://localhost:3000/api>. Faça `POST /auth/login` e cole o `access_token` no botão **Authorize**
- Superadmin: `npm run platform:superadmin -- --email=voce@exemplo.com --name="Seu Nome"`

**3. Web (diretório, vitrines, painel e superpainel)**

```bash
cd frontend-web
npm install
npm run dev
```

- Diretório: <http://localhost:5173> · Vitrine demo: <http://localhost:5173/loja/demo> · Cliente: <http://localhost:5173/signin> · Equipe e superadmin: <http://localhost:5173/login>
- A web usa a API em `http://localhost:3000`. Para outro endereço, copie `.env.example` para `.env`, defina `VITE_API_URL` e reinicie o `npm run dev`.

**4. App mobile (opcional, fora do escopo desta fase).** O app continua funcionando na loja padrão. Veja o [README do mobile](frontend-mobile/README.md) (`npm run start:lan`, emulador ou túnel).

### Atualizar uma instalação existente

1. **Backup:** `pg_dump -U postgres -Fc comestra > comestra-AAAAMMDD.dump` e uma cópia da pasta `backend/uploads`.
2. No `backend/.env`, use `DB_SYNCHRONIZE=false` (ou vazio). Com `true`, o TypeORM cria índices e colunas por fora das migrations e o banco fica diferente do de produção.
3. Atualize o código, rode `npm install` em `backend/` e `frontend-web/` e suba a API: as migrations pendentes são aplicadas na subida. Para conferir: `cd backend && npm run migration:show` (13 migrations com `[X]`) e `npm run migration:check`. A `PerformanceIndexes` cria índices com `CONCURRENTLY`, fora de transação: se falhar no meio, basta subir de novo.
4. **Login de novo?** Vindo de uma versão sem as sessões registradas (`AuthSessions`), defina `JWT_LEGACY_ISSUED_BEFORE` com o instante do deploy (ex.: `2026-11-01T12:00:00Z`) para os tokens antigos valerem até expirar; sem ela, em produção, todos (site, app e equipe) entram de novo.
5. Vindo da versão de **loja única**, a migration cria a loja inicial com todos os dados atuais (nome e slug em `INITIAL_STORE_NAME`/`INITIAL_STORE_SLUG`) e a define como loja padrão.
6. **Número do pedido:** a migration `OrderNumbersAndCustomerBlocks` renumera os pedidos existentes **por loja**, na ordem de criação. Telas e conversas antigas que citavam `Pedido #<id>` passam a mostrar outro número; o `id` continua nas rotas da API e no app mobile. Avise as lojas antes de atualizar.
7. Depois de subir: se havia credenciais Mercado Pago gravadas, rode **Regravar credenciais** em Superpainel → Configurações → Manutenção. Os planos existentes ficam com armazenamento ilimitado e as contas existentes com o e-mail "Não confirmado" até confirmarem.

Passo a passo completo, reversão e problemas conhecidos: [`docs/saas/operacao.md`](docs/saas/operacao.md#3-atualizar-uma-instalação-existente).

---

## 🔐 Variáveis de ambiente

Cada app tem um `.env.example` comentado. Valores vazios usam o padrão indicado. A lista completa da API está em [`backend/.env.example`](backend/.env.example) e explicada em [`docs/saas/operacao.md`](docs/saas/operacao.md#7-configuração).

### API: `backend/.env` (principais)

| Variável | Padrão | Para que serve |
|---|---|---|
| `NODE_ENV` | vazio = produção | `development` ou `test` liberam as facilidades de desenvolvimento. Qualquer outro valor, ou nenhum, vale como **produção** |
| `PORT` · `HOST` | `3000` · `0.0.0.0` | Porta e interface da API. `0.0.0.0` = acessível pela rede local (app mobile no celular); `127.0.0.1` = só este computador (túnel ou proxy na mesma máquina) |
| `DB_HOST` · `DB_PORT` · `DB_USERNAME` · `DB_PASSWORD` · `DB_DATABASE` | `localhost` · `5432` · `postgres` · vazio · `comestra` | Conexão com o PostgreSQL |
| `DB_MIGRATIONS_RUN` | `true` | Aplica as migrations pendentes na subida |
| `DB_SYNCHRONIZE` | `false` | Synchronize do TypeORM. Mantenha `false` (o schema vem das migrations) |
| `DB_POOL_SIZE` · `DB_STATEMENT_TIMEOUT_MS` · `DB_POOL_ACQUIRE_TIMEOUT_MS` | `10` · `60000` · `30000` | Pool da API, tempo máximo de cada consulta e espera máxima por uma conexão |
| `JWT_SECRET` · `JWT_EXPIRES_IN` | aleatório por máquina em dev, fixo em teste · `7d` | Tokens. **Obrigatório em produção** (32+ caracteres) |
| `JWT_LEGACY_ISSUED_BEFORE` | vazio | Instante do deploy que aplicou as sessões registradas: tokens antigos (sem `jti`) valem até ele + `JWT_EXPIRES_IN`. Vazio, em produção: todos entram de novo |
| `AUTH_WEB_COOKIE` · `JWT_ACCESS_EXPIRES_IN` · `AUTH_COOKIE_ORIGINS` | `true` · `15m` · vazio | Sessão do site em cookie (token curto + refresh `HttpOnly`); mais opções em [`operacao.md`](docs/saas/operacao.md#73-sessão-do-site-em-cookie) |
| `ACCOUNT_SECURITY_MODE` | `compat` | Verificação e troca de e-mail (`strict` ainda não existe) |
| `CREDENTIALS_ENCRYPTION_KEY` | fixo só em dev/teste | Chave das credenciais Mercado Pago das lojas. **Obrigatória em produção** |
| `CORS_ORIGINS` · `TRUST_PROXY` | vazio | Domínios liberados e IP real atrás de proxy/túnel (`TRUST_PROXY` = número de proxies, ex.: `1`; `true` vale como `1`) |
| `APP_WEB_URL` · `PUBLIC_API_URL` | `http://localhost:5173` · vazio | Links dos e-mails (convite, redefinição, conta) · endereço público da API para o logo das lojas nos e-mails |
| `UPLOADS_CLEANUP_INTERVAL_HOURS` | vazio (desligada) | Limpeza automática dos arquivos sem uso, em horas (ex.: `24`) |
| `MAIL_DRIVER` · `SMTP_HOST` · `SMTP_PORT` · `SMTP_SECURE` · `SMTP_USER` · `SMTP_PASSWORD` · `MAIL_FROM` | `log` · vazio · `587` · só na porta 465 · vazio · vazio · vazio | E-mail transacional. `log` não envia nada; `smtp` envia convites e links de redefinição pelo servidor configurado (teste em Superpainel → Configurações). Detalhes em [`operacao.md`](docs/saas/operacao.md#71-e-mail-transacional-smtp) |
| `DEFAULT_STORE_SLUG` | vazio | Loja das rotas antigas sem slug (app mobile) |
| `SEED_DEMO_USERS` · `SEED_DEMO_SUPERADMIN` | dev/teste · só teste | Dados de demonstração (nunca em produção) |
| `RATE_LIMIT_ENABLED` · `RATE_LIMIT_<NOME>` | ligado | Limites de tentativas e de abuso (`limite/segundos`) |
| `MP_ACCESS_TOKEN` · `MP_PUBLIC_KEY` · `PAYMENT_SANDBOX` · `MP_NOTIFICATION_URL` | vazio · automático | Mercado Pago da loja padrão (as demais lojas usam as credenciais do painel), sandbox e webhook |
| `SAAS_BILLING_PROVIDER` · `MP_SAAS_*` | `MANUAL` | Cobrança da assinatura SaaS (conta da Comestra) |

**Zonas de entrega da loja padrão.** `DELIVERY_ZONES_JSON` ou `DELIVERY_ZONES_FILE` (padrão em `backend/src/orders/delivery-zones.config.ts`). As outras lojas configuram as próprias zonas no painel e, sem zonas, não fazem entrega.

```json
{
  "fallback": { "fee": 15, "time": "50-60 min" },
  "zones": [
    { "neighborhoods": ["Centro", "Lapa"], "cities": ["Rio de Janeiro"], "fee": 5, "time": "30-40 min" }
  ]
}
```

### Web: `frontend-web/.env`

| Variável | Padrão | Para que serve |
|---|---|---|
| `VITE_API_URL` | `http://localhost:3000` | Endereço da API, sem barra no final. Também entra na Content-Security-Policy do build: gere o build de produção com a URL real |
| `VITE_APP_NAME` | `Comestra` | Nome da plataforma exibido (logo, título da aba e rodapé) |
| `VITE_MP_PUBLIC_KEY` | chave **de teste** | Chave pública de compatibilidade. Cada loja usa a chave pública do próprio perfil |
| `VITE_AUTH_TRANSPORT` | `auto` | `bearer` desliga a sessão em cookie no site (exige build novo) |

> Tudo que começa com `VITE_*` vai para o JavaScript público do site. Nunca coloque segredos nessas variáveis.

No Docker, as variáveis da API ficam no `.env.docker` da raiz (modelo `.env.docker.example`).

O app mobile usa `frontend-mobile/.env.local` (veja o [README do mobile](frontend-mobile/README.md)).

---

## 💳 Pagamentos em sandbox

Com o sandbox ligado, dá para testar o checkout inteiro sem cobrar ninguém. Ele só funciona com `NODE_ENV=development` ou `test`. Nesses modos, liga com `PAYMENT_SANDBOX=true` ou, com a variável vazia, quando não há `MP_ACCESS_TOKEN` ou quando ele é de teste (`TEST-...`).

| | Sem `MP_ACCESS_TOKEN` | Com token de teste (`TEST-...`) |
|---|---|---|
| **Cartão** | Aprovação simulada | Enviado ao Mercado Pago. Se for recusado ou houver falha, vira uma aprovação simulada |
| **PIX** | QR Code de teste (não pode ser pago), aprovado automaticamente | QR do Mercado Pago (sandbox), aprovado automaticamente. Se houver falha, usa o QR de teste |

**Cartão de teste** (Mercado Pago)

| Número | Validade | CVV | Titular | CPF |
|---|---|---|---|---|
| `5031 4332 1540 6351` | `11/30` | `123` | `APRO` | `123.456.789-09` |

**PIX:** gere o QR Code e aguarde cerca de **5 s** (`PIX_SANDBOX_APPROVAL_SECONDS`). Aprovado o pagamento, **o servidor cria o pedido**, mesmo que o cliente saia da tela (pela consulta de status, pelo webhook ou pela conciliação a cada 60 s). Voltar ao carrinho retoma o mesmo código, sem gerar outra cobrança. Respostas simuladas trazem `simulation: true`.

**O que muda em produção** (`PAYMENT_SANDBOX=false`, ou `NODE_ENV=production`):

- Não existe aprovação simulada. Recusas e falhas do Mercado Pago chegam ao cliente.
- Cada loja informa as **próprias credenciais** em Configurações → Pagamentos (o token é cifrado com `CREDENTIALS_ENCRYPTION_KEY`). O `MP_ACCESS_TOKEN` do ambiente vale só para a loja padrão sem credencial própria. Loja sem credencial: pagamento online indisponível (o pagamento na entrega continua).
- Pagamento aprovado numa loja que não pode mais vender (suspensa, desativada ou sem assinatura válida) é estornado automaticamente e não vira pedido.
- Limites: até 5 cobranças pendentes por cliente e loja, e limites de criação por cliente e por IP (`RATE_LIMIT_PAYMENT_*`).

---

## 🧪 Testes

**Unitários da API** (sem banco):

```bash
cd backend
npx jest            # ou: npm test
npm run test:cov    # com cobertura
```

Cobrem isolamento por loja (guards, situação da loja), superpainel, planos e assinaturas, auditoria, migrations, regras de pedidos e pagamentos, autenticação, convites, limites, uploads e configuração.

**Web:** `cd frontend-web && npm run build` (verificação de tipos + build) e `npm run lint`. Os testes de navegador ficam na suíte E2E.

**Ponta a ponta** (Playwright, API + navegador):

```bash
cd e2e
npm install
npm test            # ou: npm run test:api / npm run test:web
npm run report      # relatório HTML da última execução
```

- Ambiente isolado: a API de teste roda em **:3001** com o banco **`comestra_e2e`** (recriado do zero, schema só pelas migrations) e a web de teste em **:5174**. O banco de desenvolvimento nunca é tocado.
- Suítes de API: `identity` (inclui sessões e logout, sessão em cookie, conta e troca de e-mail, e a manutenção de uploads e credenciais), `commerce` (inclui o número do pedido por loja, frete por CEP e desempenho), `tenancy` (isolamento entre lojas e bloqueio de cliente pela loja), `platform` (superpainel, sessão de suporte, e-mails com a marca da loja e correções das revisões), `billing` (planos, assinaturas, faturas, cota de armazenamento, webhook e garantias do banco) e `security` (parse de requisições); suítes web: `client` (diretório, vitrine, checkout, cabeçalhos de segurança, sessões ativas, sessão em cookie e segurança da conta), `admin` (painel, quadro de pedidos, sessão entre abas, assinatura e equipe), `platform` (superpainel no navegador, inclusive no celular) e `multistore` (vitrine com várias lojas).
- Requer PostgreSQL local, Google Chrome e as dependências instaladas em `backend/` e `frontend-web/`. Se o usuário `postgres` tiver senha: `DB_PASSWORD=... npm test` (Linux) ou `$env:DB_PASSWORD="..."; npm test` (PowerShell).
- Execuções paralelas isoladas e o spec de CSP contra o build: [`e2e/README.md`](e2e/README.md).

---

## ✅ Checklist de produção

- [ ] `NODE_ENV=production`, `JWT_SECRET` forte e `CREDENTIALS_ENCRYPTION_KEY` (32 bytes) guardada em cofre
- [ ] `DB_SYNCHRONIZE=false`, migrations aplicadas (`npm run migration:run:prod`) e backup antes de cada deploy
- [ ] Superadmin criado com `npm run platform:superadmin:prod`; nenhuma conta de demonstração no banco
- [ ] `CORS_ORIGINS` com os domínios reais, `TRUST_PROXY` com o número de proxies (nunca `true`) e `SWAGGER_ENABLED` desligado
- [ ] `JWT_LEGACY_ISSUED_BEFORE` no deploy que aplica as sessões registradas (ou aceite o login de novo); site e API no mesmo site, com HTTPS, para a sessão em cookie, e o proxy sem registrar `Cookie`/`Authorization` nos logs
- [ ] HTTPS; build da web com `VITE_API_URL` real, rewrite da SPA para `index.html` e os cabeçalhos de segurança/CSP no servidor que hospeda o site
- [ ] Credenciais Mercado Pago de cada loja, `MP_NOTIFICATION_URL` pública e `PAYMENT_SANDBOX` desligado
- [ ] `UPLOADS_DIR` em volume persistente, limite de corpo no proxy, `APP_WEB_URL` e `PUBLIC_API_URL` reais
- [ ] E-mail por SMTP (`MAIL_DRIVER=smtp`, `SMTP_*`, `MAIL_FROM`) conferido com o e-mail de teste do superpainel; `HOST=127.0.0.1` quando o proxy roda na mesma máquina
- [ ] Cobrança SaaS em `MANUAL` até validar a conta Mercado Pago da plataforma

Checklist completo e comentado: [`docs/saas/operacao.md`](docs/saas/operacao.md#9-checklist-de-produção).

---

## 📚 Documentação

| Documento | Conteúdo |
|---|---|
| [`docs/saas/arquitetura.md`](docs/saas/arquitetura.md) | Decisões, modelo de dados, migrations, isolamento, papéis, contratos de API, planos e assinaturas, pagamentos por loja, segurança HTTP e do SPA |
| [`docs/saas/operacao.md`](docs/saas/operacao.md) | Instalação do zero, atualização, migrations, superadmin, seeds, configuração (inclusive sessão em cookie e banco), operação, checklist de produção, pendências e integrações externas |
| [`docs/saas/docker.md`](docs/saas/docker.md) | Rodar com Docker: subir, contas, backup e restauração, HTTPS, produção e solução de problemas |
| [`docs/saas/diagnostico.md`](docs/saas/diagnostico.md) | Diagnóstico técnico inicial (fase 1) |
| [`docs/guia-completo-comestra.html`](docs/guia-completo-comestra.html) · [PDF](docs/Guia_Completo_Comestra.pdf) | Guia completo para implantação e operação |

---

## 🗃 Scripts opcionais de dados

Estes scripts alteram dados do banco de desenvolvimento e atuam **somente na loja padrão** da plataforma. Todos mostram uma prévia antes de aplicar.

- **Fotos dos produtos que sumiram:** `cd backend && node scripts/reparar-imagens-produtos.mjs` mostra a prévia; com `--aplicar`, grava.
- **Cardápio de demonstração neutro:** `psql -U postgres -d comestra -f backend/scripts/renomear-catalogo-demo.sql` tira o antigo "Torres" dos nomes dos produtos, por exemplo "Torres Bacon Grill" → "Bacon Grill".
- **Histórico de faturamento:** pedidos concluídos antes desta versão com pagamento na entrega ficaram com `payment_status = PENDING`, e o Dashboard soma só pedidos pagos. Para contar esse histórico como pago:

  ```sql
  UPDATE orders SET payment_status = 'PAID'
  WHERE status = 'DONE' AND payment_id IS NULL AND payment_status = 'PENDING';
  ```

---

## 🎨 Personalização

| O quê | Onde |
|---|---|
| Nome, logo, cor, endereço, horários, entrega e mensagens **de cada loja** | Painel da loja → Configurações (a identidade visual depende do plano) |
| Nome exibido da plataforma | `APP_NAME` (API), `VITE_APP_NAME` (web), `EXPO_PUBLIC_APP_NAME` (app) |
| Marca da plataforma (nome padrão, slug, domínio, slogan, e-mail de suporte) | `src/config/brand.ts` em cada app |
| Logo e ícones da plataforma | Web: `frontend-web/public/favicon.svg` e o componente `src/components/BrandLogo`. App: `frontend-mobile/assets/` |
| Zonas de entrega da loja padrão | `DELIVERY_ZONES_JSON` / `DELIVERY_ZONES_FILE` (padrão em `backend/src/orders/delivery-zones.config.ts`) |
| Promoções do dia da semana | `backend/src/promotions/promotions.service.ts` |

---

## 🔄 Migração a partir do TorresBurgers

O Comestra é a evolução do antigo **TorresBurgers**. Para quem já tinha uma instalação:

- **Banco de dados:** o nome padrão agora é `comestra`. Para continuar com os dados antigos, use `DB_DATABASE=torresburgers` no `backend/.env`. Se a instalação dependia da senha padrão antiga do código, use também `DB_PASSWORD=0000`. Também é possível copiar o banco: `createdb -U postgres -T torresburgers comestra`, sem conexões abertas no banco antigo.
- **Loja única → SaaS:** na primeira subida desta versão, as migrations transformam a instalação em plataforma: o cardápio, os pedidos, os pagamentos e a equipe vão para a **loja inicial** (que vira a loja padrão), com um plano interno sem cobrança. Faça o backup antes ([passo a passo](docs/saas/operacao.md#33-da-loja-única-para-o-saas)).
- **Sessões:** as chaves de armazenamento mudaram (web: `torresburgers.*` → `comestra.*`; app: `@TorresBurgers:*` → `@comestra:*`). Todos os usuários precisam **entrar de novo**. O carrinho e o tema salvos no navegador e o tema do app voltam ao padrão.
- **Contas da equipe:** o cadastro público (`POST /users`) cria apenas clientes. A equipe entra por convite ou é criada pelo administrador da loja. Para recuperar o acesso, use o link de redefinição gerado no superpainel ou, em desenvolvimento, `npm run seed`.
- **`.env` antigo:** `PORT`, `JWT_EXPIRES_IN` (antes fixo em 1 dia) e `MP_ACCESS_TOKEN` (antes fixo no código) passaram a valer, e há variáveis novas da plataforma (`CREDENTIALS_ENCRYPTION_KEY`, `DB_MIGRATIONS_RUN`, `TRUST_PROXY`...). Compare com o `backend/.env.example`.
- **Túnel do app:** o `npm run tunnel` não altera mais `src/services/api.ts`. A URL vai para `EXPO_PUBLIC_API_URL` no `.env.local`.

---

## 🛣 Roadmap

**Já disponível:** plataforma multi-loja com isolamento no servidor · superpainel · planos, assinaturas e faturas · painel da loja com convites e configurações · vitrine por slug · Mercado Pago por loja com estorno e conciliação · auditoria · migrations versionadas · testes de isolamento, superpainel e cobrança · e-mail por SMTP em texto e HTML com a marca da loja · logout no servidor e sessões ativas · número do pedido por loja · bloqueio de cliente pela loja · limpeza dos arquivos sem uso (manual ou agendada) · cota de armazenamento por plano · frete por CEP com recusa fora da área · confirmação e troca de e-mail com "Não fui eu" · sessão do site com token curto e refresh em cookie `HttpOnly` · Docker

**Próximos passos**

- [ ] Fila de reenvio dos e-mails e provedores por API; modo `strict` da conta (respostas neutras, equipe pendente até confirmar)
- [ ] Cobrança recorrente validada no Mercado Pago real (pausa da preapproval na suspensão)
- [ ] Refresh do token no app mobile e sessão deslizante
- [ ] Limites e caches distribuídos (Redis) para várias instâncias
- [ ] Domínio próprio e subdomínio por loja
- [ ] App mobile multi-loja (escolha da loja, carrinho por loja, chave pública por loja)
- [ ] Status do pedido em tempo real (WebSockets) e notificações push
- [ ] Cupons e promoções aplicados no checkout

Pendências técnicas detalhadas: [`docs/saas/operacao.md`](docs/saas/operacao.md#10-limitações-conhecidas-e-pendências).

---

## 🔖 Marca

**Comestra** · slug `comestra` · domínio `comestra.com.br` · *Cozinha, balcão e entrega no mesmo compasso.*

> [!IMPORTANT]
> Antes do lançamento comercial, faça a busca da marca no INPI (pePI) e o pedido de registro pelo **e-Marcas** nas classes **9** (software), **35** (gestão de negócios), **42** (SaaS) e **43** (serviços de alimentação). Registre também o domínio **comestra.com.br** no Registro.br.
