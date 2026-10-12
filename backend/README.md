# ⚙️ Comestra | API (NestJS)

> **Cozinha, balcão e entrega no mesmo compasso.**

API REST do **Comestra**. Ela concentra autenticação e perfis de acesso, cardápio, pedidos com preço calculado no servidor, pagamentos (Mercado Pago), entregas, endereços, status da loja e imagens. Atende a loja/back office web (`frontend-web`) e o app mobile (`frontend-mobile`).

Visão geral do produto, usuários padrão e checklist de produção: [README da raiz](../README.md).

---

## 🛠 Stack

| Camada | Tecnologia |
|---|---|
| Framework | NestJS 11 (TypeScript) |
| Banco de dados | PostgreSQL 14+ com TypeORM 0.3 |
| Autenticação | JWT (Passport) + bcrypt, perfis com `RolesGuard` |
| Validação | `ValidationPipe` global com class-validator / class-transformer |
| Documentação | Swagger (OpenAPI) em `/api` |
| Imagens | Multer + Sharp (conversão para WebP) |
| Pagamentos | SDK oficial do Mercado Pago (cartão e PIX) |
| Cache | cache-manager em memória (banner do dia) |
| Testes | Jest (unitários) e Jest + Supertest (E2E da API) |

---

## 🚀 Como executar

### Pré-requisitos
- **Node.js 22+** e npm
- **PostgreSQL 14+** com um banco vazio (padrão: `comestra`)

### Passo a passo

```bash
cd backend
cp .env.example .env          # Windows (PowerShell): Copy-Item .env.example .env
# edite o .env: NODE_ENV=development e DB_PASSWORD (senha do usuário postgres)
npm install
npm run start:dev
```

Com `NODE_ENV=development`, a primeira subida cria as tabelas (`DB_SYNCHRONIZE` ligado por padrão), a configuração da loja (aberta) e os [usuários padrão](#-usuários-padrão). O `.env.example` vem com `NODE_ENV=production`: sem trocar o valor, a API segue as regras de produção e não sobe sem um `JWT_SECRET` forte (veja [Ambiente e segurança](#-ambiente-e-segurança)).

| Endereço | O que é |
|---|---|
| <http://localhost:3000/health> | Saúde: `{ "status": "ok", "name": "Comestra", "version": "<versão do package.json>" }` |
| <http://localhost:3000/api> | Swagger. Faça `POST /auth/login` e use o `access_token` no botão **Authorize** |
| `http://localhost:3000/uploads/<arquivo>` | Imagens enviadas (pasta `UPLOADS_DIR`) |

A API escuta em `0.0.0.0`, então o app mobile alcança a API pelo IP da máquina na rede local.

### Scripts

| Comando | O que faz |
|---|---|
| `npm run start:dev` | Desenvolvimento com recarga automática |
| `npm run start:debug` | Desenvolvimento com o inspetor do Node |
| `npm run build` | Compila para `dist/` |
| `npm run start:prod` | Executa o build (`node dist/main`) sempre com `NODE_ENV=production` |
| `npm run seed` | Cria/restaura os usuários padrão e redefine as senhas. Em produção, só com `npm run seed -- --force` |
| `npx jest` (ou `npm test`) | Testes unitários |
| `npm run test:cov` | Testes unitários com cobertura (`coverage/`) |
| `npm run test:e2e` | Teste E2E da API (Jest + Supertest, precisa de PostgreSQL) |
| `npm run lint` · `npm run format` | ESLint (com correção) e Prettier |

---

## 🔐 Variáveis de ambiente

Modelo comentado em [`.env.example`](.env.example). Variáveis definidas no próprio ambiente (servidor, Docker, CI) têm prioridade sobre o `.env`.

| Variável | Padrão | Descrição |
|---|---|---|
| `NODE_ENV` | vazio = produção | `development` (máquina local) ou `test` (testes) liberam as facilidades de desenvolvimento. Vazio ou qualquer outro valor conta como `production` |
| `PORT` | `3000` | Porta HTTP |
| `DB_HOST` · `DB_PORT` | `localhost` · `5432` | PostgreSQL |
| `DB_USERNAME` · `DB_PASSWORD` | `postgres` · vazio | Credenciais do banco |
| `DB_DATABASE` | `comestra` | Nome do banco (vazio = slug da marca em `src/config/brand.ts`) |
| `DB_SYNCHRONIZE` | ligado em development/test, desligado em produção | Sincroniza o schema com as entidades. **Produção: `false` + migrations** |
| `JWT_SECRET` | segredo fixo só em development/test | **Obrigatório em produção, com 32+ caracteres**: sem ele, a API não sobe |
| `JWT_EXPIRES_IN` | `7d` | `7d`, `12h`, `30m` ou segundos. Valor inválido cai no padrão, com aviso |
| `APP_NAME` | `Comestra` | Nome no Swagger, em `/health` e na descrição dos pagamentos |
| `UPLOADS_DIR` | `./uploads` | Pasta das imagens (use um volume persistente em produção) |
| `CORS_ORIGINS` | vazio = qualquer origem | Lista separada por vírgula com os domínios do site e do painel (em produção, vazio gera aviso na subida) |
| `SEED_DEMO_USERS` | ligado em development/test | Cria os usuários padrão na subida. **Nunca em produção** (`true` é ignorado, com erro no log) |
| `MP_ACCESS_TOKEN` | vazio | Access token do Mercado Pago (`TEST-...` = credencial de teste) |
| `PAYMENT_SANDBOX` | automático só em development/test | Vazio = sandbox quando não há token ou ele é `TEST-`. Em produção o sandbox nunca é ligado |
| `PIX_SANDBOX_APPROVAL_SECONDS` | `5` | No sandbox, segundos até o PIX ser aprovado |
| `PIX_EXPIRATION_MINUTES` | `30` | Validade do QR Code PIX |
| `STORE_TIME_ZONE` | `America/Sao_Paulo` | Fuso do "hoje" e dos gráficos do painel |
| `DELIVERY_ZONES_JSON` | vazio | Faixas de entrega em JSON (substitui o arquivo de configuração) |
| `FOOTBALL_DATA_TOKEN` | vazio | Token de football-data.org para o banner de jogos (opcional) |

Valores booleanos aceitam `true/false`, `1/0`, `yes/no`, `sim/não` e `on/off`. Um valor diferente (ex.: `fasle`) usa o padrão e gera um aviso no log.

### 🛡 Ambiente e segurança

A API **falha fechada**: só `NODE_ENV=development` ou `NODE_ENV=test` liberam as facilidades de desenvolvimento. Sem `NODE_ENV`, ou com um valor desconhecido (`prod`, `staging`...), ela segue as regras de produção e avisa no log.

| | development / test | produção |
|---|---|---|
| `JWT_SECRET` vazio | segredo fixo de desenvolvimento (aviso no log) | a API **não sobe** (também com menos de 32 caracteres) |
| Usuários padrão (senhas públicas) | criados na subida (`SEED_DEMO_USERS=false` desliga) | **nunca** criados; `SEED_DEMO_USERS=true` gera erro no log |
| `npm run seed` | roda | recusado, a menos que use `npm run seed -- --force` |
| `DB_SYNCHRONIZE` vazio | ligado | desligado |
| Sandbox de pagamentos | automático sem token ou com token `TEST-` | nunca é ligado |

`npm run start:prod` define `NODE_ENV=production` (com `cross-env`, funciona no Windows e no Linux). Para testar o build localmente com as facilidades de desenvolvimento, rode `node dist/main` com `NODE_ENV=development` no `.env`.

---

## 👥 Usuários padrão

Criados na subida da API com `NODE_ENV=development` ou `test` (desligue com `SEED_DEMO_USERS=false`). Nessa etapa, só os que faltam são criados, e contas existentes nunca são alteradas. A lista fica em [`src/database/seeds/default-users.ts`](src/database/seeds/default-users.ts).

| Perfil | E-mail | Senha |
|---|---|---|
| `ADMIN` (Administrador) | `admin@comestra.com.br` | `Admin@123` |
| `EMPLOYEE` (Atendente) | `atendente@comestra.com.br` | `Atendente@123` |
| `KITCHEN` (Cozinha) | `cozinha@comestra.com.br` | `Cozinha@123` |
| `COURIER` (Entregador) | `entregador@comestra.com.br` | `Entregador@123` |
| `CLIENT` (Cliente) | `cliente@comestra.com.br` | `Cliente@123` |

`npm run seed` recria os que faltam, restaura os que estão na lixeira e redefine nome, perfil e senha. Onde cada perfil entra e o que pode fazer: [README da raiz](../README.md#-usuários-padrão-um-por-perfil).

> ⚠️ **Produção:** essas senhas são públicas. A API nunca cria esses usuários em produção, e `npm run seed` só roda lá com `--force` (para recuperar o acesso; troque as senhas em seguida). Se as contas já existirem no banco de produção, exclua-as ou troque as senhas antes de abrir a loja. O mesmo vale para uma API de desenvolvimento exposta na internet (ex.: o `npm run tunnel` do app mobile).

---

## 🧱 Módulos

| Módulo | Pasta | Responsabilidade |
|---|---|---|
| Auth | `src/auth` | `POST /auth/login`, estratégia JWT, `RolesGuard`, `@Roles()`, autenticação opcional |
| Users | `src/users` | Cadastro de clientes e equipe, perfil, avatar, lixeira e regras de acesso (`users.policy.ts`) |
| Products | `src/products` | Produtos, categorias, adicionais e lixeira |
| Orders | `src/orders` | Orçamento e criação de pedidos (`order-pricing.service.ts`), regras puras (`order-rules.ts`), transições por perfil, dashboard e logística |
| Payment | `src/payment` | Cartão e PIX pelo Mercado Pago, modo sandbox e verificação do pagamento na criação do pedido |
| Addresses | `src/addresses` | Endereços do cliente e busca de CEP (ViaCEP → BrasilAPI) |
| Store | `src/store` | Loja aberta/fechada e mensagens da vitrine |
| Promotions | `src/promotions` | Banner do dia: jogo de futebol ou sugestão do dia da semana (texto neutro, sem cupom nem desconto) |
| Common | `src/common` | Upload e otimização de imagens, manutenção e validadores/transformações comuns |
| Database | `src/database` | Seed dos usuários padrão (na subida e via `npm run seed`) |
| Config | `src/config` | Marca (`brand.ts`), leitura de variáveis, JWT, CORS/validação (`app-setup.ts`) e versão |

---

## 🔑 Autenticação e perfis

- `POST /auth/login` com `{ email, password }` devolve `{ access_token, user }`. As rotas protegidas usam `Authorization: Bearer <token>`.
- A cada requisição, a `JwtStrategy` recarrega o usuário do banco. Uma conta excluída (lixeira) recebe `401` mesmo com o token válido, e uma mudança de perfil vale na hora.
- O e-mail é gravado em minúsculas e o login não diferencia maiúsculas. A senha é guardada com bcrypt e nunca sai nas respostas.
- **Política de senha:** de 9 caracteres a 72 bytes (o limite do bcrypt; letras acentuadas ocupam 2 bytes), com uma letra maiúscula e um número ou símbolo. Vale no cadastro e na troca de senha.
- **Cadastro (`POST /users`):** sem token, cria um `CLIENT`. Outros perfis só podem ser criados com token de `ADMIN`. Só o `ADMIN` altera o perfil de alguém, e nunca o próprio (`400`).
- **Sempre há um administrador:** rebaixar, mandar para a lixeira ou excluir definitivamente o último `ADMIN` ativo responde `400`.
- **Sessão:** todo `401` tem o formato `{ "statusCode": 401, "message": "Sessão inválida ou expirada. Faça login novamente.", "error": "Unauthorized" }` (sem token, token inválido/expirado ou conta excluída). Só a senha errada no login mantém a mensagem própria (`Email ou senha inválidos`).

| Perfil | Papel |
|---|---|
| `ADMIN` | Acesso total: dashboard, pedidos, cardápio, equipe, lixeira, loja e manutenção |
| `EMPLOYEE` | Atendente: conduz todo o fluxo dos pedidos, despacha entregas, cancela e abre/fecha a loja |
| `KITCHEN` | Cozinha: inicia o preparo e marca o pedido como pronto |
| `COURIER` | Entregador: pega pedidos prontos para entrega e conclui as próprias entregas |
| `CLIENT` | Cliente: faz pedidos e pagamentos e gerencia os próprios endereços e dados |

Pedidos e pagamentos online são exclusivos de `CLIENT` (`ClientOnlyGuard`). A equipe recebe `403`.

---

## 📡 Endpoints

Use o Swagger (`/api`) para ver os schemas e testar as rotas. "Equipe" = `ADMIN`, `EMPLOYEE`, `KITCHEN` e `COURIER`. "Gestão" = `ADMIN` e `EMPLOYEE`.

**Saúde e autenticação**

| Método | Rota | Acesso | Descrição |
|---|---|---|---|
| GET | `/health` | Público | Status, nome e versão da API |
| POST | `/auth/login` | Público | Login por e-mail e senha |

**Usuários**

| Método | Rota | Acesso | Descrição |
|---|---|---|---|
| POST | `/users` | Público (`CLIENT`) · `ADMIN` (outros perfis) | Cadastro (JSON ou multipart com o avatar em `file`) |
| GET | `/users` | `ADMIN` | Lista os usuários ativos |
| GET | `/users/trash` | `ADMIN` | Usuários na lixeira |
| GET | `/users/:id` | Próprio usuário ou `ADMIN` | Detalhe |
| PATCH | `/users/:id` | Próprio usuário ou `ADMIN` | Edição (só o `ADMIN` muda `role` de outra conta), com avatar opcional. `phone` vazio ou `null` remove o telefone |
| PATCH | `/users/:id/restore` | `ADMIN` | Restaura da lixeira |
| DELETE | `/users/:id` | Própria conta ou `ADMIN` | Exclusão lógica (o `ADMIN` não exclui a si mesmo, nem o último `ADMIN` ativo) |
| DELETE | `/users/:id/permanent` | `ADMIN` | Exclusão definitiva (`409` se houver pedidos; `400` para o último `ADMIN` ativo) |

Ids fora de `1..2147483647` (ou não numéricos) respondem `400 "Id inválido."`.

**Cardápio**

| Método | Rota | Acesso | Descrição |
|---|---|---|---|
| GET | `/products` | Público | Produtos fora da lixeira (inclusive indisponíveis), com adicionais permitidos |
| GET | `/products/:id` | Público | Detalhe |
| GET | `/products/trash` | `ADMIN` | Produtos na lixeira |
| POST | `/products` | `ADMIN` | Cadastro (multipart com a foto em `file`, ou JSON) |
| PATCH | `/products/:id` | `ADMIN` | Edição (foto opcional) |
| PATCH | `/products/:id/restore` | `ADMIN` | Restaura da lixeira |
| DELETE | `/products/:id` | `ADMIN` | Move para a lixeira |
| DELETE | `/products/:id/permanent` | `ADMIN` | Exclusão definitiva (`409` se o produto aparece em pedidos) |
| GET | `/addons` | Público | Adicionais fora da lixeira |
| POST · PATCH · DELETE | `/addons`, `/addons/:id` | `ADMIN` | Cadastro, edição e exclusão lógica de adicionais |

Categorias aceitas: `hamburgueres`, `combos`, `entradas`, `acompanhamentos`, `bebidas`, `sobremesas`, `molhos`, `adicionais`. Preços vão até R$ 999.999,99. `promotion_price` vazio, `null`, `0` ou negativo significa "sem promoção" e é gravado como `null`; quando existe, precisa ser menor que o preço.

**Pedidos** (todas exigem login)

| Método | Rota | Acesso | Descrição |
|---|---|---|---|
| POST | `/orders/quote` | `CLIENT` | Orçamento calculado no servidor (itens, subtotal, taxa, total, tempo estimado e `store_open`) |
| POST | `/orders` | `CLIENT` | Cria o pedido (com `paymentId` quando pago online) |
| GET | `/orders/my-orders` | Logado | Pedidos do próprio usuário |
| GET | `/orders/:id` | Dono ou equipe | Detalhe |
| PATCH | `/orders/:id/cancel` | Dono (enquanto `PENDING`) ou gestão | Cancela |
| GET | `/orders` | Equipe | Todos os pedidos |
| PATCH | `/orders/:id` | Equipe | Muda o status (`{ status }`), conforme o perfil |
| PATCH | `/orders/:id/assign` | Gestão | Atribui um entregador (`{ driverId }`) e leva o pedido para `DELIVERING` |
| GET | `/orders/:id/nearby` | Gestão | Pedidos prontos, sem entregador, do mesmo bairro |
| GET | `/orders/drivers/list` | Gestão | Entregadores ativos |
| GET | `/orders/summary` | `ADMIN` | Resumo do dashboard |
| GET | `/orders/charts` | `ADMIN` | Faturamento dos últimos 7 dias e os 5 produtos mais vendidos |

**Pagamentos**

| Método | Rota | Acesso | Descrição |
|---|---|---|---|
| POST | `/payment/card` | `CLIENT` | Cobra o cartão (token do Mercado Pago). O valor vem do `order` enviado |
| POST | `/payment/pix` | `CLIENT` | Gera o PIX (QR Code e copia e cola) |
| GET | `/payment/status/:id` | Pagador ou equipe | Status do pagamento (consultado pelas telas de PIX e cartão) |
| POST | `/payment/webhook` | Público | Só confirma o recebimento (`{ "status": "ok" }`) |

**Endereços, loja, banner e imagens**

| Método | Rota | Acesso | Descrição |
|---|---|---|---|
| GET | `/addresses/cep/:cep` | Público | Busca de CEP (ViaCEP, com BrasilAPI como reserva) |
| POST · GET | `/addresses` | Logado | Cria / lista os endereços do próprio usuário |
| GET · PATCH · DELETE | `/addresses/:id` | Logado (dono) | Detalhe, edição e exclusão lógica (pedidos antigos mantêm o endereço) |
| GET | `/store/status` | Público | `{ is_open, opening_message, closing_message }` |
| PATCH | `/store/status` | `ADMIN`, `EMPLOYEE` | Abre/fecha a loja e edita as mensagens |
| GET | `/promotions/banner` | Público | Banner do dia: jogo de futebol ou sugestão do dia, sem cupom (`/promotions/football` é um alias antigo) |
| POST | `/uploads` | `ADMIN` | Envia uma imagem avulsa (campo `file`) e devolve `{ filename }` |
| POST | `/maintenance/optimize-images` | `ADMIN` | Converte para WebP as imagens antigas de produtos e avatares |

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
- Se o produto define adicionais permitidos, só eles são aceitos. Produtos e adicionais indisponíveis ou na lixeira são recusados.
- Limites por pedido: 50 linhas, até 50 unidades por item, até 50 adicionais por item e observação de até 300 caracteres.
- **Retrato do preço:** cada item grava `unit_price` e `addons_snapshot` (nome, preço e quantidade cobrados), então o histórico não muda quando o cardápio muda.
- **Loja fechada:** o orçamento devolve `store_open: false`, e a criação do pedido e os pagamentos respondem `400`.

**Entrega por bairro.** O nome inteiro do bairro é comparado, sem diferenciar maiúsculas nem acentos, e a cidade também quando a zona a informa. Padrão de fábrica:

| Bairro | Taxa | Tempo |
|---|---|---|
| Centro, Lapa, Santa Teresa | R$ 5 | 30-40 min |
| Flamengo, Botafogo, Laranjeiras | R$ 7 | 40-50 min |
| Copacabana, Ipanema, Leblon | R$ 10 | 50-60 min |
| Barra da Tijuca, Barra, Recreio dos Bandeirantes, Recreio | R$ 20 | 60-80 min |
| Tijuca, Maracanã | R$ 12 | 50-60 min |
| demais bairros | R$ 15 | 50-60 min |
| retirada (`TAKEOUT`) | grátis | 15-20 min |

Os bairros vêm de uma instalação no Rio de Janeiro. Em cada instalação, configure as zonas sem mexer no código: use `DELIVERY_ZONES_JSON` ou `DELIVERY_ZONES_FILE` (o formato está no `.env.example`), ou edite o padrão em [`src/orders/delivery-zones.config.ts`](src/orders/delivery-zones.config.ts).

**Pagamento:** `PIX`, `CREDIT_CARD`, `DEBIT_CARD` ou `MONEY`. Com `paymentId`, o pedido foi pago online. Sem ele, o pagamento é feito na entrega ou na retirada.
- O troco só vale para `MONEY`. É gravado como `"R$ 50,00"` e precisa ser maior ou igual ao total.
- Pagamentos online normalmente **já viram pedido no servidor** quando são aprovados (veja Pagamentos). `POST /orders` com `paymentId` continua aceito e é idempotente. Para o mesmo cliente, devolve o pedido já criado com aquele pagamento. Se o pedido ainda não existe, a API confere o pagamento: precisa ser do mesmo cliente, ter forma compatível, estar aprovado e bater com o total (±R$ 0,01). `payment_id` é único.
- Um pedido pago na entrega ou na retirada vira `PAID` quando é concluído (`DONE`).

**Status e transições** (`PATCH /orders/:id`):

| Perfil | Pode fazer |
|---|---|
| `ADMIN`, `EMPLOYEE` | Qualquer transição válida, inclusive cancelar |
| `KITCHEN` | `PENDING → PREPARING` e `PREPARING → READY_FOR_PICKUP` |
| `COURIER` | `READY_FOR_PICKUP → DELIVERING` (assume o pedido se ainda não tiver entregador) e `DELIVERING → DONE` só nas próprias entregas |

- `DONE` e `CANCELED` são finais. Mudar para o mesmo status é inválido. `TAKEOUT` nunca entra em `DELIVERING`.
- Transição impossível → `400 "Transição inválida: X → Y"`. Transição possível, mas não permitida ao perfil → `403`.
- **Concorrência:** a gravação só acontece se o pedido ainda estiver no status lido. Se outra pessoa mexeu nele antes, a resposta é `409`.
- **Cancelamento** (`PATCH /orders/:id/cancel`): o dono pode cancelar enquanto o pedido está `PENDING`. A gestão pode cancelar enquanto ele não for final.
- **Despacho** (`PATCH /orders/:id/assign`): só para `DELIVERY` em `PREPARING`, `READY_FOR_PICKUP` ou `DELIVERING`, com um usuário `COURIER` ativo.

**Dashboard:** o faturamento conta apenas pedidos `PAID` e não cancelados.

---

## 💳 Pagamentos (Mercado Pago)

O modo é decidido por `resolvePaymentMode` ([`src/payment/payment-rules.ts`](src/payment/payment-rules.ts)):

- **Sandbox** (somente com `NODE_ENV=development` ou `test`: `PAYMENT_SANDBOX=true`, ou vazio sem token / com token `TEST-`):
  - **Cartão:** sem token, a aprovação é simulada. Com token de teste, o cartão vai para o Mercado Pago, e uma recusa ou falha vira aprovação simulada.
  - **PIX:** usa o QR do Mercado Pago (ou um QR de teste, que não pode ser pago) e é aprovado sozinho após `PIX_SANDBOX_APPROVAL_SECONDS` (padrão 5 s).
  - As respostas simuladas trazem `simulation: true`, e o log as marca como simulação.
- **Produção** (`PAYMENT_SANDBOX=false`, ou qualquer ambiente de produção, inclusive com `NODE_ENV` vazio; lá o sandbox nunca é ligado): não há simulação. O pagamento é consultado de novo no Mercado Pago antes de o pedido ser criado. Sem `MP_ACCESS_TOKEN`, a cobrança por cartão e por PIX responde `503` (o pagamento na entrega continua funcionando).

Cartão de teste: `5031 4332 1540 6351`, validade `11/30`, CVV `123`, titular `APRO`, CPF `123.456.789-09`.

**Fluxo:**
1. O front envia `order` (o mesmo corpo do orçamento) e uma `idempotencyKey` para `/payment/card` (com o token do cartão) ou para `/payment/pix`. A chave evita cobrança dupla: repetir a mesma chave devolve o mesmo pagamento, e ela também é repassada ao Mercado Pago.
2. A API calcula o valor e grava o pagamento na tabela `payments`, com o retrato do carrinho e dos preços. Em seguida, cobra.
3. **Quando o pagamento é aprovado, a própria API cria o pedido**, de forma idempotente (`orders.payment_id` é único) e a partir do retrato, mesmo que a loja tenha fechado ou um preço tenha mudado. A aprovação pode chegar por:
   - resposta imediata do cartão (`orderId` na resposta);
   - `GET /payment/status/:id` (devolve `orderId` quando o pedido existe);
   - webhook (`MP_NOTIFICATION_URL`);
   - job de conciliação a cada 60 s.
4. O PIX vence em `PIX_EXPIRATION_MINUTES` (`expires_at` na resposta) e pode ser cancelado em `POST /payment/:id/cancel`. Um pagamento cancelado nunca vira pedido.
5. Cancelar um pedido pago online gera **estorno** (`REFUNDED`). Se o estorno falhar, o pedido fica como `REFUND_PENDING`, visível no painel. Pagamentos que não batem com o retrato também são estornados, e o motivo fica em `finalize_error`.

---

## 🖼 Imagens

- Produtos (`POST/PATCH /products`), avatares (`POST/PATCH /users`) e `POST /uploads` aceitam **JPG, PNG ou WebP de até 5 MB**, no campo `file`.
- O tipo é conferido pelo conteúdo do arquivo. A imagem é rotacionada conforme o EXIF, limitada a 800 px de largura e convertida para **WebP** (qualidade 80) com Sharp.
- Os arquivos ficam em `UPLOADS_DIR` e são servidos em `/uploads/<arquivo>`. Produtos guardam só o nome do arquivo, e avatares guardam `/uploads/<arquivo>`.
- A imagem só é gravada depois que o corpo da requisição foi validado (e, no cadastro, o perfil autorizado). Se a operação falhar depois disso, a imagem recém-gravada é apagada: requisições recusadas não deixam arquivos órfãos.
- A pasta padrão `uploads/` está no `.gitignore`: só as imagens de demonstração já versionadas continuam no Git.

---

## 🗄 Banco de dados

Tabelas: `users`, `products`, `addons`, `product_allowed_addons`, `orders`, `order_items`, `order_item_addons`, `addresses` e `store_config`.

- `users`, `products` e `addons` usam exclusão lógica (`deleted_at`). Endereços também, mas pedidos antigos continuam exibindo o endereço de entrega.
- `store_config` tem uma linha só, criada na subida com a loja **aberta**.
- Com `DB_SYNCHRONIZE=true`, o TypeORM ajusta o schema a partir das entidades. Em produção, desligue o synchronize e versione o schema com migrations. O repositório ainda não traz migrations nem um data source para o CLI do TypeORM, então crie-os antes da primeira subida em produção.

---

## 🧪 Testes

```bash
npx jest              # unitários (sem banco): regras de pedidos, pagamentos, permissões, cardápio, uploads...
npm run test:cov      # com cobertura
```

O teste E2E da API (`test/app.e2e-spec.ts`) sobe o `AppModule` completo e precisa de PostgreSQL. Use um banco de teste já criado para não mexer no de desenvolvimento:

```bash
DB_DATABASE=comestra_test npm run test:e2e                  # Linux
$env:DB_DATABASE="comestra_test"; npm run test:e2e          # Windows (PowerShell)
```

A suíte ponta a ponta completa (API + navegador, com Playwright) fica em [`../e2e`](../e2e/README.md).

---

## ✅ Produção (resumo)

- [ ] `npm run build && npm run start:prod` (o `start:prod` já define `NODE_ENV=production`). Rodando de outro jeito (`node dist/main`, PM2, Docker), defina `NODE_ENV=production` no ambiente.
- [ ] `JWT_SECRET` aleatório com 32+ caracteres (sem ele, a API não sobe).
- [ ] Usuários padrão: a API não os cria em produção. Se eles já existirem no banco, exclua as contas ou troque as senhas.
- [ ] `MP_ACCESS_TOKEN` de produção, sem `PAYMENT_SANDBOX=true`.
- [ ] `DB_SYNCHRONIZE=false` (padrão em produção) com o schema controlado por migrations. Na primeira instalação, gere as migrations ou suba uma única vez com `DB_SYNCHRONIZE=true` (com backup) e volte para `false`.
- [ ] `CORS_ORIGINS` com os domínios reais, HTTPS e `UPLOADS_DIR` em um volume persistente.
- [ ] Confira o log da subida: `Ambiente: production` e nenhum aviso de configuração.

Checklist completo: [README da raiz](../README.md#-checklist-de-produção).

---

## 🛣 Roadmap da API

- [ ] Recuperação de senha por e-mail
- [ ] Eventos em tempo real (WebSockets) para o quadro de pedidos e o status do cliente
- [ ] Confirmação de pedidos pelo webhook do Mercado Pago, com registro de pagamentos persistente
- [ ] Cupons e promoções aplicados no orçamento e no checkout
- [ ] Multi-loja / multi-tenant
- [ ] Migrations versionadas do TypeORM
