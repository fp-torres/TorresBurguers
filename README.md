<div align="center">

<img src="frontend-web/public/favicon.svg" alt="Marca Comestra" width="96" height="96" />

# Comestra

**Cozinha, balcão e entrega no mesmo compasso.**

SaaS de delivery e gestão para restaurantes: loja online, app para clientes e equipe e back office em uma única plataforma.

![NestJS](https://img.shields.io/badge/NestJS_11-E0234E?style=for-the-badge&logo=nestjs&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)
![React](https://img.shields.io/badge/React_19-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![Vite](https://img.shields.io/badge/Vite_7-646CFF?style=for-the-badge&logo=vite&logoColor=white)
![Expo](https://img.shields.io/badge/Expo_SDK_54-000020?style=for-the-badge&logo=expo&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Mercado Pago](https://img.shields.io/badge/Mercado_Pago-00B1EA?style=for-the-badge&logo=mercadopago&logoColor=white)
![Playwright](https://img.shields.io/badge/E2E-Playwright-2EAD33?style=for-the-badge&logo=playwright&logoColor=white)

[Produto](#-o-comestra) · [Funcionalidades](#-funcionalidades) · [Usuários padrão](#-usuários-padrão-um-por-perfil) · [Como rodar](#-como-rodar) · [Variáveis](#-variáveis-de-ambiente) · [Pagamentos](#-pagamentos-em-sandbox) · [Testes](#-testes) · [Produção](#-checklist-de-produção) · [Roadmap](#-roadmap)

</div>

---

## 🍳 O Comestra

O **Comestra** cobre o pedido de ponta a ponta, do cardápio online até a entrega, em três frentes ligadas a uma única API:

| Frente | Para quem | O que oferece |
|---|---|---|
| 🛒 **Loja online** (web) | Clientes | Cardápio com busca e categorias, carrinho, checkout com PIX, cartão ou pagamento na entrega e acompanhamento dos pedidos |
| 📱 **App mobile** (Android e iOS) | Clientes e equipe | A mesma loja no celular e, para a equipe, o painel de pedidos de acordo com o perfil de quem entra |
| 🧑‍🍳 **Back office** (web) | Dono, atendentes, cozinha e entregadores | Dashboard de vendas, quadro de pedidos por etapa, despacho de entregas, cardápio, equipe e lixeira |

O cardápio já vem organizado para hamburguerias, lanchonetes e restaurantes de delivery: hambúrgueres (com ponto da carne), combos, entradas, acompanhamentos, bebidas, sobremesas, molhos e adicionais.

**Diferenciais**

- **Cada pessoa vê só o próprio trabalho.** Cinco perfis (Administrador, Atendente, Cozinha, Entregador e Cliente), com as permissões aplicadas pela API e não apenas escondidas nas telas.
- **O preço é calculado no servidor.** Subtotal, taxa de entrega e total vêm sempre da API, e o valor cobrado no PIX ou no cartão é o mesmo do pedido.
- **O histórico não muda.** Cada item guarda o preço e os adicionais cobrados no momento da compra. Alterar o cardápio não mexe em pedidos antigos.
- **O cartão nunca passa pelo servidor do restaurante.** Os dados são tokenizados pelo Mercado Pago no navegador ou no app, e a API recebe apenas o token.
- **Pronto para demonstrar.** Há um usuário de teste para cada perfil, pagamentos em modo sandbox e uma suíte de testes ponta a ponta.

---

## ✨ Funcionalidades

### 🛒 Loja online e app do cliente
- Cardápio com busca por nome e descrição (sem diferenciar acentos), filtros por categoria e seções de combos e ofertas
- Preço promocional, com o preço cheio riscado e o mesmo valor que a API cobra
- Personalização do item: ponto da carne (hambúrgueres), retirada de ingredientes, adicionais com quantidade e observação
- Carrinho salvo no navegador, que continua lá depois de recarregar a página
- **Retirada no balcão** (sem taxa, 15–20 min) ou **entrega**, com endereço salvo e busca automática de CEP (ViaCEP, com BrasilAPI como reserva)
- Taxa e tempo de entrega calculados pela API conforme o bairro, com orçamento atualizado no checkout (`POST /orders/quote`)
- Pagamento **online** por PIX (QR Code e copia e cola) ou cartão via Mercado Pago, ou **na entrega/retirada** em dinheiro (com troco) ou cartão na maquininha
- **Meus Pedidos**: status, forma de pagamento e cancelamento enquanto o pedido aguarda confirmação
- Conta do cliente: cadastro, edição dos dados e, na web, foto de perfil, troca de senha e exclusão da conta
- Com a loja fechada, o cardápio continua visível, mas carrinho e checkout ficam bloqueados
- Tema claro, escuro ou automático (segue o sistema), na web e no app

### 🧾 Pedidos e operação
- **Quadro de pedidos (kanban)** por etapa: Novos → Preparando → Aguardando motoboy / Retirar no balcão → Em entrega → Concluídos (e Cancelados). Atualiza sozinho a cada 5 s, na web e no app
- **Ações por perfil**, validadas pela API ([tabela de transições](#transições-de-status-por-perfil)): a cozinha só prepara, o entregador só entrega, e atendente e administrador conduzem tudo
- Cada cartão mostra itens, ponto da carne, ingredientes removidos, adicionais, observações, forma e situação do pagamento ("Pago online", "Cobrar na entrega"...) e um alerta de troco
- Pedidos pagos na entrega ou na retirada são marcados como pagos quando o pedido é concluído
- Proteção contra edição simultânea: se outra pessoa alterou o pedido nesse meio-tempo, a API responde `409` em vez de sobrescrever

### 🛵 Entregas
- **Despacho**: administrador ou atendente escolhe o entregador e o pedido passa para "Em entrega". O sistema sugere outros pedidos prontos do mesmo bairro para agrupar a rota
- O entregador também pode **pegar para entrega** um pedido pronto que ainda não tem responsável. Só ele conclui as próprias entregas
- Endereço com atalho para o Google Maps. No app há também os botões **Abrir no GPS** e **Ligar** para o cliente
- Alerta de troco com o valor a levar

### 💳 Pagamentos
- Mercado Pago: cartão tokenizado no navegador ou no app e PIX com QR Code (com vencimento e cancelamento)
- **O próprio servidor cria o pedido quando o pagamento é aprovado.** Isso vale para a resposta do cartão, a consulta de status, o webhook ou a conciliação automática a cada 60 s. Se o cliente fechar o app depois de pagar, o pedido aparece mesmo assim em "Meus Pedidos"
- Pagamentos ficam gravados no banco (tabela `payments`) com o retrato do carrinho e dos preços no momento da cobrança. O valor é sempre calculado pela API, e cada pagamento gera no máximo um pedido (chave de idempotência e `payment_id` único)
- Cancelamento de pedido pago online gera **estorno** automático (`REFUNDED`). Se o estorno falhar, o pedido fica como `REFUND_PENDING`, visível para a equipe
- Modo **sandbox** para desenvolvimento e demonstrações ([detalhes](#-pagamentos-em-sandbox))

### 🍔 Cardápio
- Produtos com foto, descrição, categoria, preço, preço promocional (sempre menor que o normal), ingredientes e adicionais permitidos
- Pausa de produtos esgotados: eles saem da vitrine até serem reativados
- Adicionais com preço e categoria, gerenciados no próprio cadastro do produto
- Lixeira com restauração. A exclusão definitiva é bloqueada para produtos que já aparecem em pedidos

### 🏪 Loja e marketing
- **Abrir/fechar a loja** com um clique (Administrador e Atendente). Com a loja fechada, a API recusa pedidos e pagamentos novos
- Mensagens opcionais de loja aberta e de loja fechada, exibidas na vitrine e definidas em `PATCH /store/status`
- **Banner do dia**: o jogo de futebol do dia (opcional, com `FOOTBALL_DATA_TOKEN`) ou uma sugestão do dia da semana. O texto é só informativo e não promete descontos nem cupons, que ainda não são aplicados no checkout ([roadmap](#-roadmap))

### 📊 Dashboard e equipe
- **Dashboard (web)**: faturamento (pedidos pagos e não cancelados), pedidos realizados, ticket médio, fila de produção, faturamento dos últimos 7 dias, 5 produtos mais vendidos e formas de pagamento
- **Painel no app**: indicadores do dia (faturamento, pedidos, ticket médio e fila)
- **Equipe**: cadastro por perfil, redefinição de senha pelo administrador e lixeira de usuários (contas com pedidos não podem ser excluídas definitivamente)
- Política de senha: no mínimo 9 caracteres, com uma letra maiúscula e um número ou símbolo

### 🔧 Plataforma
- Login com JWT (validade padrão de 7 dias). A cada requisição, a API recarrega o usuário: uma conta excluída perde o acesso na hora, e uma mudança de perfil vale imediatamente
- Imagens em JPG, PNG ou WebP de até 5 MB, com o tipo conferido pelo conteúdo do arquivo e conversão para **WebP** (largura máxima de 800 px, qualidade 80) com Sharp
- Validação de entrada em todos os endpoints: campos desconhecidos são recusados com `400`
- Documentação interativa (Swagger) em `/api` e verificação de saúde em `/health`
- White-label: o nome exibido é configurável por variável de ambiente (`APP_NAME`, `VITE_APP_NAME`, `EXPO_PUBLIC_APP_NAME`)

---

## 👥 Usuários padrão (um por perfil)

| Perfil | E-mail | Senha | Onde entrar | O que pode fazer |
|---|---|---|---|---|
| **Administrador**<br>`ADMIN` | `admin@comestra.com.br` | `Admin@123` | **Web:** [localhost:5173/login](http://localhost:5173/login) → Dashboard<br>**App:** Entrar → **Acesso de Funcionário** → Painel | Acesso total. Na web: Dashboard, quadro de pedidos completo (com despacho e cancelamento), abrir/fechar a loja, Cardápio, Equipe e Lixeira. No app: Dashboard do dia, Pedidos, Produtos e Usuários |
| **Atendente**<br>`EMPLOYEE` | `atendente@comestra.com.br` | `Atendente@123` | **Web:** [localhost:5173/login](http://localhost:5173/login) → Pedidos<br>**App:** Entrar → **Acesso de Funcionário** → Pedidos | Conduz todo o fluxo: aceita, marca como pronto, despacha para um entregador, entrega no balcão, confirma a entrega e cancela. Abre e fecha a loja. Não acessa financeiro, cardápio nem equipe |
| **Cozinha**<br>`KITCHEN` | `cozinha@comestra.com.br` | `Cozinha@123` | **Web:** [localhost:5173/login](http://localhost:5173/login) → Monitor da Cozinha<br>**App:** Entrar → **Acesso de Funcionário** → Monitor da Cozinha | Vê as colunas Novos e Preparando: aceita o pedido (inicia o preparo) e o marca como pronto |
| **Entregador**<br>`COURIER` | `entregador@comestra.com.br` | `Entregador@123` | **Web:** [localhost:5173/login](http://localhost:5173/login) → Painel de Entregas<br>**App:** Entrar → **Acesso de Funcionário** → Minhas Entregas | Pega entregas prontas, abre o endereço no mapa, vê o troco a levar e confirma as próprias entregas. No app, também liga para o cliente |
| **Cliente**<br>`CLIENT` | `cliente@comestra.com.br` | `Cliente@123` | **Web:** [localhost:5173/signin](http://localhost:5173/signin) → loja<br>**App:** Entrar → **Entrar como Cliente** (ou pelo carrinho) | Compra pela loja: cardápio, carrinho, checkout (PIX, cartão ou na entrega/retirada), Meus Pedidos (cancela enquanto aguarda confirmação) e dados da conta |

- **Criação automática:** os cinco usuários são criados quando a API sobe, se ainda não existirem, **somente com `NODE_ENV=development` ou `test`** (variável `SEED_DEMO_USERS`, ligada por padrão nesses ambientes). Contas que já existem nunca são alteradas nessa etapa. Sem `NODE_ENV` definido, a API se comporta como produção e não cria contas de demonstração.
- **Restaurar:** `cd backend && npm run seed` recria os usuários que faltam, tira da lixeira os excluídos e redefine nome, perfil e senha para os valores da tabela. Em produção o script se recusa a rodar sem `-- --force`.
- **Onde clicar:** na loja web, o menu do usuário tem os botões **Entrar** (`/signin`) e **Equipe** (`/login`). Uma conta da equipe que entra pela loja é levada ao painel, e um cliente que tenta `/login` volta para a loja. No app, o destino depende do perfil da conta, não do botão escolhido.
- Os e-mails usam o domínio de `BRAND.domain` (`backend/src/config/brand.ts`).

> [!WARNING]
> **Produção:** com `NODE_ENV=production` (ou sem `NODE_ENV`), a API nunca cria essas contas, mesmo com `SEED_DEMO_USERS=true`. As senhas desta tabela são públicas. Se essas contas já existirem no banco de produção, exclua-as ou troque as senhas antes de abrir a loja, e também antes de expor a API em desenvolvimento pela internet (`npm run tunnel`).

### Transições de status por perfil

Status do pedido: `PENDING` (novo) → `PREPARING` (em preparo) → `READY_FOR_PICKUP` (pronto) → `DELIVERING` (em entrega) → `DONE` (concluído), ou `CANCELED`. A API valida cada mudança: uma transição impossível responde `400`, e uma transição possível que não cabe ao perfil responde `403`.

| Ação | Administrador e Atendente | Cozinha | Entregador |
|---|:---:|:---:|:---:|
| Aceitar: `PENDING` → `PREPARING` | ✅ | ✅ | — |
| Marcar como pronto: `PREPARING` → `READY_FOR_PICKUP` | ✅ | ✅ | — |
| Despachar com entregador escolhido (`PATCH /orders/:id/assign`) | ✅ | — | — |
| Pegar para entrega: `READY_FOR_PICKUP` → `DELIVERING` | ✅ | — | ✅ (assume o pedido sem responsável) |
| Confirmar entrega: `DELIVERING` → `DONE` | ✅ | — | ✅ (só as próprias entregas) |
| Entregar no balcão (retirada): `READY_FOR_PICKUP` → `DONE` | ✅ | — | — |
| Cancelar | ✅ (até o pedido ser concluído) | — | — |

- Administrador e Atendente podem fazer qualquer transição válida. `DONE` e `CANCELED` são finais, e pedidos de retirada nunca passam por `DELIVERING`.
- O despacho (`PATCH /orders/:id/assign`) vale para pedidos de entrega em preparo, prontos ou já em entrega (para trocar o entregador) e leva o pedido para `DELIVERING`.
- O **cliente** cancela o próprio pedido enquanto ele está `PENDING`. Pedidos e pagamentos são feitos apenas por contas de cliente: a equipe não compra pelo sistema.

---

## 🏗 Arquitetura e stack

```
  Loja + back office (web)              App mobile (Expo)
  React 19 · Vite 7 · :5173             React Native 0.81 · SDK 54
              │                                   │
              └──────── REST/JSON + JWT ──────────┘
                                │
                                ▼
                 API · NestJS 11 · :3000
                 Swagger /api · /health · /uploads ──▶ Mercado Pago (cartão e PIX)
                                │                  ──▶ ViaCEP / BrasilAPI (CEP)
                                │                  ──▶ football-data.org (opcional)
                                ▼
                     PostgreSQL 14+ (TypeORM)
```

A tokenização do cartão vai do navegador ou do app direto para o Mercado Pago, usando a chave pública. A API recebe apenas o token.

| Camada | Tecnologias |
|---|---|
| **API** | NestJS 11, TypeScript, TypeORM 0.3, PostgreSQL, Passport JWT, bcrypt, class-validator, Swagger, Sharp, SDK do Mercado Pago, cache-manager |
| **Web** | React 19, Vite 7, TailwindCSS 4, React Router 7, Axios, Recharts, Lucide e Iconify, SDK JS v2 do Mercado Pago |
| **Mobile** | React Native 0.81, Expo SDK 54, NativeWind 2, React Navigation 7, Axios, AsyncStorage |
| **Testes** | Jest (unitários da API) e Playwright (ponta a ponta: API e navegador) |
| **Desenvolvimento** | Túnel Serveo (`npm run tunnel`) e modo túnel do Expo (`--tunnel`) para testar no celular fora da rede |

### Estrutura do projeto

```bash
comestra/
├── backend/                  # API REST (NestJS + TypeORM + PostgreSQL)
│   ├── src/
│   │   ├── auth/             # login, JWT, perfis (RolesGuard)
│   │   ├── users/            # clientes e equipe, regras de acesso
│   │   ├── products/         # cardápio e adicionais
│   │   ├── orders/           # pedidos, preço no servidor, transições, dashboard e logística
│   │   ├── payment/          # Mercado Pago (cartão e PIX) e modo sandbox
│   │   ├── addresses/        # endereços e busca de CEP
│   │   ├── store/            # loja aberta/fechada
│   │   ├── promotions/       # banner do dia
│   │   ├── common/           # uploads (WebP), manutenção e validações
│   │   ├── config/           # marca, variáveis de ambiente, JWT e CORS
│   │   └── database/         # usuários padrão (seed)
│   ├── test/                 # teste E2E da API com Jest
│   ├── uploads/              # imagens enviadas (servidas em /uploads)
│   └── .env.example
├── frontend-web/             # loja online + back office (React + Vite)
│   ├── public/favicon.svg    # marca
│   ├── src/                  # pages, components, contexts, layouts, routes, services, utils, config
│   └── .env.example
├── frontend-mobile/          # app do cliente e da equipe (Expo)
│   ├── src/                  # screens, components, contexts, routes, services, utils, config
│   ├── start-tunnel.js       # npm run tunnel
│   └── .env.example
├── e2e/                      # testes ponta a ponta (Playwright)
└── docs/                     # guia completo (HTML e PDF)
```

Cada parte tem o próprio README: [backend](backend/README.md) · [web](frontend-web/README.md) · [mobile](frontend-mobile/README.md) · [e2e](e2e/README.md). O guia completo está em [`docs/guia-completo-comestra.html`](docs/guia-completo-comestra.html) e em [PDF](docs/Guia_Completo_Comestra.pdf).

---

## 🚀 Como rodar

### Pré-requisitos

- **Node.js 22+** (LTS) e npm
- **PostgreSQL 14+**
- Para o app: **Expo Go** compatível com o **SDK 54** no celular, ou um emulador Android/iOS. Para o túnel, o cliente **OpenSSH** (`ssh`)
- Para os testes E2E: **Google Chrome**

```bash
git clone <URL_DO_REPOSITORIO> comestra
cd comestra
```

### 1. Banco de dados

Crie um banco vazio chamado `comestra`. As tabelas são criadas pela própria API na primeira subida.

**Windows (PowerShell)**: troque `18` pela versão instalada. Outra opção é o pgAdmin: *Databases → Create → Database…*

```powershell
& "C:\Program Files\PostgreSQL\18\bin\createdb.exe" -U postgres comestra
```

**Linux**

```bash
sudo -u postgres createdb comestra
# Se o usuário postgres ainda não tem senha (a API conecta via TCP):
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'sua_senha';"
```

> Já usa o TorresBurgers? Mantenha o banco antigo com `DB_DATABASE=torresburgers` no `backend/.env` (veja a seção [Migração](#-migração-a-partir-do-torresburgers)).

### 2. API (backend)

**Windows (PowerShell)**

```powershell
cd backend
Copy-Item .env.example .env    # depois edite o .env: NODE_ENV=development e DB_PASSWORD = senha do usuário postgres
npm install
npm run start:dev
```

**Linux**

```bash
cd backend
cp .env.example .env           # depois edite o .env: NODE_ENV=development e DB_PASSWORD = senha do usuário postgres
npm install
npm run start:dev
```

> O `.env.example` vem com `NODE_ENV=production`, que é o modo seguro. Para desenvolver, troque para `development`. Só nesse modo a API cria os usuários padrão, liga o sandbox de pagamentos e ajusta o schema sozinha.

Na primeira subida, a API cria as tabelas, a configuração da loja (aberta) e os [usuários padrão](#-usuários-padrão-um-por-perfil).

- Saúde: <http://localhost:3000/health> → `{"status":"ok","name":"Comestra","version":"0.0.1"}`
- Swagger: <http://localhost:3000/api>. Faça `POST /auth/login` e cole o `access_token` no botão **Authorize**

> Em um banco novo, o cardápio começa vazio. Entre como **Administrador** em <http://localhost:5173/login> e cadastre produtos e adicionais em **Cardápio**.

### 3. Loja e back office (web)

```bash
cd frontend-web
npm install
npm run dev
```

- Loja: <http://localhost:5173> · Login do cliente: <http://localhost:5173/signin> · Equipe: <http://localhost:5173/login>
- A web usa a API em `http://localhost:3000`. Para usar outro endereço, copie `.env.example` para `.env` (`Copy-Item` no Windows, `cp` no Linux), defina `VITE_API_URL` e reinicie o `npm run dev`.

### 4. App mobile (Expo Go)

```bash
cd frontend-mobile
npm install
npm run start:lan
```

Escaneie o QR Code com o Expo Go (Android) ou com a câmera (iOS).

| Situação | Como fazer |
|---|---|
| **Celular no mesmo Wi-Fi** (padrão) | Não precisa configurar nada: o app usa o IP da máquina que roda o Expo, na porta 3000. Libere a porta 3000 no firewall. No Windows, em um PowerShell como administrador: `New-NetFirewallRule -DisplayName "Comestra API" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow`. No Linux com ufw: `sudo ufw allow 3000/tcp` |
| **Emulador Android** | `npm run android`. O modo LAN funciona automaticamente, e com o Expo em `localhost` o app usa `10.0.2.2` (o computador visto pelo emulador). Para uma API em outra porta, use `EXPO_PUBLIC_API_PORT` no `.env.local`. Para um endereço específico, use `EXPO_PUBLIC_API_URL`. Reinicie com `npx expo start --clear` |
| **Túnel** (rede corporativa, 4G, celular fora da rede) | Terminal 1 (deixe aberto): `npm run tunnel`, que expõe a API pelo Serveo e grava `EXPO_PUBLIC_API_URL` no `.env.local`.<br>Terminal 2: `npx expo start --clear` com o celular na mesma rede do computador, ou `npx expo start --tunnel --clear` com o celular fora dela |

- Ao encerrar o túnel (Ctrl+C), o `.env.local` volta ao valor anterior. Reinicie o Expo com `--clear` sempre que mudar uma variável `EXPO_PUBLIC_*`.
- O Expo Go precisa ser compatível com o SDK 54. Se a versão da loja de aplicativos já exigir um SDK mais novo, use o emulador Android (o `npm run android` instala o Expo Go compatível) ou baixe o Expo Go do SDK 54 em <https://expo.dev/go>.

---

## 🔐 Variáveis de ambiente

Cada app tem um `.env.example` comentado. Valores vazios usam o padrão indicado.

### API: `backend/.env`

| Variável | Padrão | Para que serve |
|---|---|---|
| `NODE_ENV` | vazio = produção | `development` ou `test` liberam as facilidades de desenvolvimento. Qualquer outro valor, ou nenhum, vale como **produção**: a API não sobe sem `JWT_SECRET` forte (32+ caracteres), não cria usuários padrão, nunca liga o sandbox de pagamentos e não sincroniza o schema |
| `PORT` | `3000` | Porta HTTP da API (escuta em `0.0.0.0`, acessível pela rede local) |
| `DB_HOST` · `DB_PORT` | `localhost` · `5432` | Servidor PostgreSQL |
| `DB_USERNAME` · `DB_PASSWORD` | `postgres` · vazio | Credenciais do banco |
| `DB_DATABASE` | `comestra` | Nome do banco (padrão: o slug da marca) |
| `DB_SYNCHRONIZE` | `true` em dev/teste · `false` em produção | Cria e ajusta as tabelas a partir das entidades. **Produção: `false` + migrations** |
| `JWT_SECRET` | segredo fixo só em dev/teste | Assina os tokens. **Obrigatório em produção** (32+ caracteres; recomendado 48+ bytes aleatórios) |
| `JWT_EXPIRES_IN` | `7d` | Validade do token (`7d`, `12h`, `30m` ou segundos) |
| `APP_NAME` | `Comestra` | Nome exibido no Swagger, em `/health` e na descrição dos pagamentos |
| `UPLOADS_DIR` | `./uploads` | Pasta das imagens enviadas (servidas em `/uploads`) |
| `CORS_ORIGINS` | vazio = qualquer origem | Origens liberadas, separadas por vírgula. **Produção: os domínios reais** |
| `SEED_DEMO_USERS` | ligado em dev/teste | Cria os usuários padrão na subida. Em produção é sempre ignorado |
| `MP_ACCESS_TOKEN` | vazio | Access token do Mercado Pago (credenciais de teste começam com `TEST-`) |
| `PAYMENT_SANDBOX` | automático | `true`/`false`. Vazio liga o sandbox em dev/teste quando não há token ou quando ele é `TEST-`. Em produção o sandbox nunca é ligado, e `true` é recusado com erro no log |
| `PIX_SANDBOX_APPROVAL_SECONDS` | `5` | No sandbox, segundos até o PIX ser considerado pago |
| `PIX_EXPIRATION_MINUTES` | `30` | Validade do QR Code PIX, enviada ao Mercado Pago e exibida na tela |
| `MP_NOTIFICATION_URL` | vazio | URL pública do webhook (`https://.../payment/webhook`), enviada ao Mercado Pago para confirmar pagamentos na hora. Sem ela, a conciliação automática (60 s) cobre |
| `STORE_TIME_ZONE` | `America/Sao_Paulo` | Fuso usado nos gráficos e nos números "de hoje" |
| `DELIVERY_ZONES_JSON` | zonas padrão | Taxas e tempos de entrega por bairro, em JSON (formato abaixo) |
| `DELIVERY_ZONES_FILE` | vazio | Alternativa ao anterior: caminho de um arquivo `.json` com as zonas |
| `FOOTBALL_DATA_TOKEN` | vazio | Token gratuito de football-data.org para o banner de jogos. Vazio exibe a sugestão do dia |

**Zonas de entrega.** Ordem de prioridade: `DELIVERY_ZONES_JSON`, depois `DELIVERY_ZONES_FILE`, depois o padrão em `backend/src/orders/delivery-zones.config.ts`. A comparação usa o nome inteiro do bairro e ignora maiúsculas e acentos.

```json
{
  "fallback": { "fee": 15, "time": "50-60 min" },
  "zones": [
    { "neighborhoods": ["Centro", "Lapa"], "cities": ["Rio de Janeiro"], "fee": 5, "time": "30-40 min" }
  ]
}
```

`cities` é opcional. Uma configuração inválida gera erro no log, e a API segue com o padrão.

### Web: `frontend-web/.env`

| Variável | Padrão | Para que serve |
|---|---|---|
| `VITE_API_URL` | `http://localhost:3000` | Endereço da API, sem barra no final (IP da rede ou URL do túnel para acessar de outro aparelho) |
| `VITE_APP_NAME` | `Comestra` | Nome exibido (logo, título da aba e rodapé) |
| `VITE_MP_PUBLIC_KEY` | chave **de teste** | Chave **pública** do Mercado Pago para tokenizar o cartão |

> Tudo que começa com `VITE_*` vai para o JavaScript público do site. Nunca coloque segredos nessas variáveis.

### Mobile: `frontend-mobile/.env.local`

| Variável | Padrão | Para que serve |
|---|---|---|
| `EXPO_PUBLIC_API_URL` | automático | Força o endereço da API. Vazio usa o IP da máquina do Expo (o `npm run tunnel` preenche esta variável) |
| `EXPO_PUBLIC_API_PORT` | `3000` | Porta da API quando o endereço é descoberto automaticamente |
| `EXPO_PUBLIC_APP_NAME` | `Comestra` | Nome exibido no app |
| `EXPO_PUBLIC_MP_PUBLIC_KEY` | chave **de teste** | Chave pública do Mercado Pago (produção: `APP_USR-...`) |
| `EXPO_PUBLIC_STORE_ADDRESS_LINE` · `EXPO_PUBLIC_STORE_CITY_LINE` | endereço de demonstração | Endereço da loja exibido no rodapé |
| `EXPO_PUBLIC_INSTAGRAM_URL` · `EXPO_PUBLIC_FACEBOOK_URL` · `EXPO_PUBLIC_X_URL` | vazio | Redes sociais. O ícone só aparece quando a URL é definida |

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

**PIX:** gere o QR Code e aguarde cerca de **5 s** (`PIX_SANDBOX_APPROVAL_SECONDS`). Aprovado o pagamento, **o servidor cria o pedido**, e a tela mostra o número dele. Se o cliente sair da tela, o pedido é criado do mesmo jeito: pela próxima consulta de status, pelo webhook ou pela conciliação automática a cada 60 s. Na web, voltar ao carrinho retoma o mesmo código, sem gerar outra cobrança. Respostas simuladas trazem `simulation: true`, e o log da API as identifica como simulação.

**O que muda em produção** (`PAYMENT_SANDBOX=false`, ou `NODE_ENV=production` sem `PAYMENT_SANDBOX=true`):

- Não existe aprovação simulada. Recusas e falhas do Mercado Pago chegam ao cliente.
- O PIX só é aprovado quando o Mercado Pago confirma, e o pagamento é consultado de novo no Mercado Pago antes de o pedido ser criado.
- Sem `MP_ACCESS_TOKEN`, o pagamento online responde `503` ("Pagamento online indisponível"). O pagamento na entrega continua funcionando.
- Use credenciais de produção: `MP_ACCESS_TOKEN` na API e as chaves públicas `APP_USR-...` em `VITE_MP_PUBLIC_KEY` e `EXPO_PUBLIC_MP_PUBLIC_KEY`.

> [!NOTE]
> Os pagamentos ficam gravados no banco (tabela `payments`), com o retrato do carrinho e dos preços no momento da cobrança. Assim, reiniciar a API não perde nada. O pedido é criado a partir desse retrato, mesmo que a loja feche ou um preço mude depois do pagamento. Se o valor pago não bater, o pagamento é estornado automaticamente.

---

## 🧪 Testes

**Unitários da API** (sem banco):

```bash
cd backend
npx jest            # ou: npm test
npm run test:cov    # com cobertura
```

Cobrem as regras de pedidos (preço, frete, troco, transições, cancelamento e despacho), pagamentos (sandbox e produção), autenticação e permissões, cardápio, uploads, loja, promoções, endereços e configuração.

**Ponta a ponta** (Playwright, API + navegador):

```bash
cd e2e
npm install
npm test            # ou: npm run test:api / npm run test:web
npm run report      # relatório HTML da última execução
```

- O ambiente é isolado: a API de teste roda em **:3001** com o banco **`comestra_e2e`** (recriado do zero) e a web de teste em **:5174**. Os servidores sobem sozinhos, e o banco de desenvolvimento nunca é tocado.
- Última execução completa: **588 testes ponta a ponta** (≈450 de API e ≈136 no navegador) e **261 testes unitários** da API, todos passando.
- Requer PostgreSQL local, Google Chrome e as dependências instaladas em `backend/` e `frontend-web/`. Se o usuário `postgres` tiver senha, informe-a no ambiente: `DB_PASSWORD=... npm test` (Linux) ou `$env:DB_PASSWORD="..."; npm test` (PowerShell).
- Mais detalhes em [`e2e/README.md`](e2e/README.md).

---

## ✅ Checklist de produção

- [ ] `NODE_ENV=production` e `JWT_SECRET` forte: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. Sem ele, a API não sobe
- [ ] `SEED_DEMO_USERS=false` (padrão em produção) e **senhas de demonstração trocadas** ou contas excluídas
- [ ] `PAYMENT_SANDBOX=false` com `MP_ACCESS_TOKEN` de produção e chaves públicas reais (`VITE_MP_PUBLIC_KEY`, `EXPO_PUBLIC_MP_PUBLIC_KEY`)
- [ ] `DB_SYNCHRONIZE=false` com o schema controlado por **migrations** (o repositório ainda não traz migrations: gere-as a partir das entidades antes de desligar o synchronize)
- [ ] `CORS_ORIGINS` com os domínios reais da loja e do painel (o app mobile não envia `Origin` e não é afetado)
- [ ] **HTTPS** na frente da API e do site, com `VITE_API_URL` e `EXPO_PUBLIC_API_URL` apontando para `https://`
- [ ] `UPLOADS_DIR` em armazenamento persistente (volume), com backup do banco e da pasta de imagens
- [ ] `MP_NOTIFICATION_URL` apontando para `https://<sua-api>/payment/webhook`, para confirmar pagamentos na hora. A conciliação a cada 60 s é a rede de segurança
- [ ] Com `DB_SYNCHRONIZE=false`, aplique as migrations antes de subir a versão: tabela `payments`, colunas `orders.delivery_address`, `order_items.product_name` e `unit_price`/`addons_snapshot`, e os novos valores de `payment_status`
- [ ] Build: API com `npm run build` + `npm run start:prod`. Web com `npm run build`, servindo `frontend-web/dist` com fallback para `index.html` (rotas do React Router)
- [ ] Dados da loja revisados (veja [Personalização](#-personalização-por-instalação))

---

## 🗃 Scripts opcionais de dados

Estes scripts alteram dados do banco de desenvolvimento, então rode só os que fizerem sentido para você. Todos mostram uma prévia antes de aplicar.

- **Fotos dos produtos que sumiram:** no banco, os produtos antigos apontam para `.jpg` que foram convertidos para `.webp` em outra máquina. Para religar as fotos, rode `cd backend && node scripts/reparar-imagens-produtos.mjs`. Ele mostra a prévia, e com `--aplicar` grava.
- **Cardápio de demonstração neutro:** `psql -U postgres -d comestra -f backend/scripts/renomear-catalogo-demo.sql`. Tira o antigo "Torres" dos nomes dos produtos, por exemplo "Torres Bacon Grill" → "Bacon Grill".
- **Histórico de faturamento:** pedidos concluídos antes desta versão com pagamento na entrega ficaram com `payment_status = PENDING`, e o Dashboard soma só pedidos pagos. Para contar esse histórico como pago:

  ```sql
  UPDATE orders SET payment_status = 'PAID'
  WHERE status = 'DONE' AND payment_id IS NULL AND payment_status = 'PENDING';
  ```

---

## 🎨 Personalização por instalação

| O quê | Onde |
|---|---|
| Nome exibido | `APP_NAME` (API), `VITE_APP_NAME` (web), `EXPO_PUBLIC_APP_NAME` (app) |
| Marca (nome padrão, slug, domínio, slogan, e-mail de suporte) | `src/config/brand.ts` em cada app |
| Logo e ícones | Web: `frontend-web/public/favicon.svg` e o componente `src/components/BrandLogo` (mesma arte). App: `frontend-mobile/assets/` |
| Endereço, telefone e horários da loja (dados de demonstração) | `frontend-web/src/config/brand.ts` (`STORE_INFO`), endereço de retirada em `frontend-web/src/pages/Client/Cart/index.tsx` e rodapé do app em `frontend-mobile/src/components/Footer` |
| Taxas e tempos de entrega por bairro (hoje com bairros do Rio de Janeiro e R$ 15 para os demais) | `backend/src/orders/order-rules.ts` |
| Promoções do dia da semana | `backend/src/promotions/promotions.service.ts` |

---

## 🔄 Migração a partir do TorresBurgers

O Comestra é a evolução do antigo **TorresBurgers**. Para quem já tinha uma instalação:

- **Banco de dados:** o nome padrão agora é `comestra`. Para continuar com os dados antigos, use `DB_DATABASE=torresburgers` no `backend/.env`. Se a instalação dependia da senha padrão antiga do código, use também `DB_PASSWORD=0000`. Também é possível copiar o banco: `createdb -U postgres -T torresburgers comestra`, sem conexões abertas no banco antigo.
- **Sessões:** as chaves de armazenamento mudaram (web: `torresburgers.*` → `comestra.*`; app: `@TorresBurgers:*` → `@comestra:*`). Todos os usuários precisam **entrar de novo**. O carrinho e o tema salvos no navegador e o tema do app voltam ao padrão.
- **Contas da equipe:** o cadastro público (`POST /users`) cria apenas clientes. Contas da equipe exigem um token de Administrador. Para recuperar o acesso de administrador, use `npm run seed`.
- **`.env` antigo:** `PORT`, `JWT_EXPIRES_IN` (antes fixo em 1 dia) e `MP_ACCESS_TOKEN` (antes fixo no código) passaram a valer. Compare com o `backend/.env.example`.
- **Túnel do app:** o `npm run tunnel` não altera mais `src/services/api.ts`. A URL vai para `EXPO_PUBLIC_API_URL` no `.env.local`.

---

## 🛣 Roadmap

**Já disponível:** perfis de acesso com permissões na API · quadro de pedidos por perfil · despacho de entregas · Mercado Pago (cartão e PIX) com sandbox · preço calculado no servidor e retrato de preços · loja aberta/fechada · usuários de demonstração · testes unitários e ponta a ponta

**Próximos passos**

- [ ] Recuperação de senha por e-mail (hoje um administrador define uma nova senha)
- [ ] Status do pedido em tempo real via WebSockets (hoje as telas consultam a API periodicamente)
- [ ] Notificações push
- [ ] Cupons e promoções aplicados no checkout (hoje o banner é informativo)
- [ ] Multi-loja / multi-tenant (hoje cada instalação atende uma loja)
- [ ] Confirmação do pedido pelo webhook do Mercado Pago (hoje o pedido é criado após a consulta de status, e o webhook só confirma o recebimento)

---

## 🔖 Marca

**Comestra** · slug `comestra` · domínio `comestra.com.br` · *Cozinha, balcão e entrega no mesmo compasso.*

> [!IMPORTANT]
> Antes do lançamento comercial, faça a busca da marca no INPI (pePI) e o pedido de registro pelo **e-Marcas** nas classes **9** (software), **35** (gestão de negócios), **42** (SaaS) e **43** (serviços de alimentação). Registre também o domínio **comestra.com.br** no Registro.br.
