# Testes ponta a ponta (E2E)

Suíte [Playwright](https://playwright.dev) que exercita a **API** e o **front-end web** da plataforma Comestra SaaS como um usuário real faria: cadastro, login de cada perfil, catálogo, carrinho, checkout (dinheiro, PIX e cartão em sandbox), cozinha, entrega, painel da loja, superpainel, assinaturas e regras de segurança — inclusive o **isolamento entre lojas**.

## Ambiente isolado

Os testes **nunca** tocam no banco de desenvolvimento. Eles sobem um ambiente próprio:

| Serviço | Endereço | Observação |
|---|---|---|
| API de teste | http://localhost:3001 | banco `comestra_e2e`, imagens em `e2e/.uploads`, `NODE_ENV=test`, schema só pelas migrations (`DB_SYNCHRONIZE=false`, `DB_MIGRATIONS_RUN=true`) |
| Web de teste | http://localhost:5174 | `npm run dev` do `frontend-web` apontando para a API de teste (`VITE_API_URL`) |

- O Playwright inicia os dois servidores automaticamente. Se eles já estiverem rodando nessas portas, são reaproveitados.
- A API de teste roda o build próprio (`backend/dist-e2e`) a partir da pasta `backend`, então lê o `backend/.env` para o que não é definido em `playwright.config.ts` (por exemplo, `DB_PASSWORD`).
- Variáveis que o `playwright.config.ts` define para a API de teste:

| Variável | Valor | Por quê |
|---|---|---|
| `SEED_DEMO_USERS` / `DEFAULT_STORE_SLUG` | `true` / `demo` | Loja demo e contas de demonstração; a loja demo é a loja padrão das rotas antigas |
| `SEED_DEMO_SUPERADMIN` | (padrão de `test`: ligado) | O superadmin de demonstração entra nos testes do superpainel |
| `PAYMENT_SANDBOX` | `true` | Cartão e PIX simulados |
| `RATE_LIMIT_SIGNUP`, `_LOGIN_FAILURES_IP`, `_FORGOT_PASSWORD`, `_TOKEN_REDEEM`, `_STORE_SIGNUP` | `100000/<janela>` | A suíte cadastra centenas de clientes e erra senhas de propósito do mesmo IP. `LOGIN_FAILURES` (IP + e-mail) continua no padrão de produção |
| `RATE_LIMIT_ORDER_CREATE`, `_ORDER_CREATE_IP`, `_PAYMENT_CREATE`, `_PAYMENT_CREATE_IP`, `_PAYMENT_WEBHOOK`, `_UPLOAD`, `_ADDRESS_WRITE`, `_TEAM_WRITE`, `_CREDENTIALS_CHANGE` | `100000/<janela>` | Limites de abuso afrouxados: a suíte repete essas ações centenas de vezes com os mesmos clientes (as regras têm testes unitários e specs próprios) |
| `RATE_LIMIT_TEST_EMAIL` | `100000/600` | E-mail de teste do superpainel (5 a cada 10 min por operador): execuções seguidas com a API reaproveitada usam o mesmo superadmin (o limite tem testes unitários) |
| `RATE_LIMIT_LOGIN_SUCCESS`, `_LOGIN_FAILURES_ACCOUNT` | `100000/600`, `100000/3600` | A suíte faz centenas de logins certos e errados com as mesmas contas (os tetos têm specs próprios) |
| `RATE_LIMIT_ACCOUNT_EMAIL`, `_ACCOUNT_EMAIL_TARGET` | `100000/3600` | Pedidos de confirmação e troca de e-mail repetidos pelos specs de conta |
| `ACCOUNT_SECURITY_MODE` | `compat` (ou `E2E_ACCOUNT_SECURITY_MODE`) | Modo da verificação de e-mail; a variável `E2E_ACCOUNT_SECURITY_MODE` fica para a futura execução em `strict` |
| `AUTH_REFRESH_GRACE_SECONDS` / `RATE_LIMIT_REFRESH` | `3` / `100000/300` | Sessão do site em cookie: tolerância curta para os testes de reuso do refresh e renovações sem limite. A web e a API de teste em `localhost` são o mesmo site: o cookie funciona sem HTTPS |
| `RATE_LIMIT_SUBSCRIPTION_CHECKOUT` | `100000/600` | Links de pagamento da assinatura repetidos pelos specs de cobrança |
| `PLATFORM_INSIGHTS_CACHE_MS` | `0` | Dashboard e financeiro do superpainel sem cache: os specs conferem os números logo depois de criar lojas e pedidos |
| `GEOCODING_FAKE` | mapa de `support/geocoding-fake.ts` | Entrega por distância sem nenhuma chamada a Google, Nominatim ou AwesomeAPI: a loja fica em `GEO_ORIGIN` e cada CEP `28970-xxx` fica N km ao norte (com o fator de rota 1,3, a distância cobrada é N × 1,3); há CEPs para "só o centro do CEP", "serviços fora do ar" e "não encontrado". Nenhum outro spec usa a faixa `28970-xxx`. Quem sobe a API de teste à mão precisa passar o mesmo mapa: sem ele, em `NODE_ENV=test`, nada é localizado, os testes de `api/commerce/delivery-distance.spec.ts` que dependem do mapa são pulados (com a instrução) e os de `web/multistore/delivery-distance.spec.ts` falham |

Variáveis que a configuração **não** define (alguns testes são pulados sem elas, com a instrução no próprio teste):

- `CEP_LOOKUP_FAKE`: sem ela, os 4 testes de `commerce/delivery-zones.spec.ts` que dependem do bairro do CEP são pulados (os outros 10 rodam). Para rodá-los, suba a API de teste com o mapa (o mesmo valor usado na validação está no comentário do spec), por exemplo `{"22071900":{"logradouro":"Rua do Frete E2E","bairro":"Copacabana","localidade":"Rio de Janeiro","uf":"RJ"},"23585000":{...},"28999000":{...},"28999999":"unavailable","01001000":{...}}`. Nunca inclua os CEPs `20040-002`, `20040-003` e `22041-001`, que outros arquivos usam com bairros variados. Sem a variável, em `NODE_ENV=test`, a conferência do bairro não acessa a internet.
- `UPLOADS_CLEANUP_INTERVAL_HOURS`: o teste da limpeza agendada de `billing/storage.spec.ts` só roda com a API subida com `UPLOADS_CLEANUP_INTERVAL_HOURS=0.005` (18 s). Não rode a suíte inteira assim: os casos de limpeza de `identity/maintenance.spec.ts` e da matriz de acesso supõem que a última execução é a manual deles.
| `MAIL_DRIVER` | `log` | A suíte nunca envia e-mails de verdade, mesmo com `MAIL_DRIVER=smtp` no `backend/.env` (convites, redefinições e o e-mail de teste ficam no log da API). `platform/mail.spec.ts` é pulado se a API de teste não estiver com o driver de log |
| `APP_WEB_URL` | web de teste | Links de convite e de redefinição apontam para a web de teste |
| `SAAS_BILLING_PROVIDER` / `MP_SAAS_WEBHOOK_SECRET` | `MANUAL` / `E2E_SAAS_WEBHOOK_SECRET` | Cobrança SaaS com registro manual; o webhook valida a assinatura com o segredo de teste |
| `SAAS_BILLING_INTERVAL_MS` | `10000` (mínimo aceito) | `tests/api/billing` simula a passagem do tempo mudando datas no banco de teste e espera a rotina das assinaturas (a assinatura da loja demo, de plano interno gratuito, não é afetada) |

- O seed de `NODE_ENV=test` cria a **loja demo** (slug `demo`, "Lanchonete Demo"), a equipe padrão dessa loja, o cliente e o superadmin (contas globais, sem loja). O `tests/global.setup.ts` confere o login de todos, a loja de cada conta e abre a loja demo antes dos testes.

### Plataforma multi-loja

- A vitrine de cada loja fica em `/loja/<slug>` (cardápio), `/loja/<slug>/cart` e `/loja/<slug>/order-success`; `/` é o diretório de lojas. Os helpers da vitrine (`openHome`, `openCart`) usam a loja demo.
- A vitrine chama as rotas da API **por loja** (`/stores/<slug>/products`, `/stores/<slug>/status`, `/stores/<slug>/orders/quote`, `/stores/<slug>/payment/pix`...). Para interceptar ou esperar essas chamadas use os matchers de `support/routes.ts` (`storeApi('/orders/quote')`, `isStoreApiResponse(res, 'POST', '/orders')`), que aceitam a rota da loja e a antiga.
- O carrinho é guardado por loja (`comestra.cart.<storeId>`, ver `cartKey`) e a última loja visitada em `comestra.lastStore`.
- O painel da equipe continua em `/login`, `/dashboard`, `/orders`, `/products`, `/users`, `/trash`, `/customers`, `/settings` e `/subscription`; o ADMIN gerencia só a equipe da própria loja (clientes são contas globais, geridas pelo superpainel).
- Os specs de `tenancy`, `platform` e `billing` criam pelo superpainel (`POST /platform/stores`) e pela API as lojas, planos e assinaturas de que precisam (por exemplo, as lojas B e C de `tenancy`, comparadas com a loja demo).
- Os mocks com CORS usam `E2E.webURL` (nunca uma porta fixa), para funcionar em execuções paralelas.
- As telas mostram o número do pedido **na loja** (`Pedido #<number>`), não o `id`. No quadro, localize o cartão pelo id (`orderCard(page, id)`, que usa `data-order-id`) e confira o título pelo número (`orderCardHeading(card, number)`), em `tests/web/admin/helpers.ts`.

## Pré-requisitos

- Node.js 22+ e PostgreSQL rodando em `localhost:5432` (usuário `postgres`)
- Google Chrome instalado (o Playwright usa o Chrome do sistema, sem baixar navegador)
- Dependências instaladas em `backend/` e `frontend-web/` (`npm install` em cada pasta)

## Como rodar

```bash
cd e2e
npm install

npm test            # recria o banco de teste, compila a API e roda tudo
npm run test:api    # só a API
npm run test:web    # só o navegador
npm run report      # abre o relatório HTML da última execução
```

Se o usuário `postgres` tiver senha, informe-a no ambiente. O script que recria o banco não lê o `backend/.env`:

```bash
DB_PASSWORD=sua_senha npm test                 # Linux
$env:DB_PASSWORD="sua_senha"; npm test         # Windows (PowerShell)
```

`npm test`, `npm run test:api` e `npm run test:web` rodam antes o `scripts/prepare.mjs`. Quando a API de teste **não** está no ar, ele recria o banco `comestra_e2e` do zero e compila a API (`npm run build:e2e` no `backend`). Se ela já estiver rodando na porta 3001, o servidor e o banco atuais são reaproveitados, sem recompilar. Para testar uma mudança no backend, pare a API de teste antes.

Para iterar rápido com os servidores já no ar:

```bash
npx playwright test tests/api/tenancy --project=api
npx playwright test tests/web/client --project=web --headed   # vendo o navegador
npx playwright test -g "Dashboard"                            # filtra pelo título do teste
```

Outros comandos: `npm run reset-db` (só recria o banco de teste) e `npm run typecheck` (verificação de tipos da suíte).

### Execuções paralelas isoladas

Para rodar duas execuções ao mesmo tempo (por exemplo, suítes diferentes em terminais diferentes), dê a cada uma banco, portas e pastas próprios e compile a API **uma vez antes** (`npm run build:e2e` no `backend`). O `nest build` apaga o `dist-e2e` antes de compilar, então nenhuma execução pode recompilar enquanto outra estiver no ar:

| Variável | Padrão | Para quê |
|---|---|---|
| `E2E_DB_DATABASE` | `comestra_e2e` | Banco de teste (precisa terminar em `_e2e`) |
| `E2E_API_PORT` / `E2E_WEB_PORT` | `3001` / `5174` | Portas da API e da web de teste |
| `E2E_UPLOADS_DIR` | `e2e/.uploads` | Imagens enviadas pela API de teste |
| `E2E_OUTPUT_DIR` / `E2E_REPORT_DIR` | `test-results` / `playwright-report` | Resultados e relatório HTML (o Playwright limpa a pasta de resultados ao iniciar) |
| `E2E_SKIP_BUILD=1` | — | `npm test` reaproveita o `backend/dist-e2e` já compilado |

```bash
E2E_DB_DATABASE=comestra_a_e2e E2E_API_PORT=3011 E2E_WEB_PORT=5181 E2E_UPLOADS_DIR=.uploads-a E2E_OUTPUT_DIR=test-results-a E2E_REPORT_DIR=playwright-report-a E2E_SKIP_BUILD=1 npm run test:api
```

- Exporte **todas** essas variáveis no mesmo comando (ou na mesma sessão do terminal). Sem elas, o `webServer` do
  Playwright sobe servidores nas portas padrão (:3001 e :5174) com o banco `comestra_e2e` e escreve nas pastas padrão,
  atropelando a execução principal.
- Para compilar a API numa pasta própria (sem tocar no `backend/dist-e2e` de outra execução): `cd backend && npx tsc -p
  tsconfig.e2e.json --outDir dist-e2e-<sigla> --tsBuildInfoFile dist-e2e-<sigla>/.tsbuildinfo`. Apague a pasta antes de
  recompilar: compilar de novo na mesma pasta falha com TS5055 (a pasta vira entrada).
- A configuração usa 1 worker. Com `--workers=2`, `platform/settings.spec.ts` e `platform/self-promotion.spec.ts` podem
  se atrapalhar (um liga e desliga o autoatendimento de lojas enquanto o outro o usa); cada um passa sozinho.

### Spec de CSP contra o build

`tests/web/client/security-headers.spec.ts` confere a Content-Security-Policy e os cabeçalhos do SPA. A CSP só existe no **build de produção** (`vite build`, e o `vite preview` também envia os cabeçalhos): contra o Vite de desenvolvimento, que o Playwright sobe por padrão, os testes do spec são **pulados**. Para rodá-lo, sirva o build na porta da web de teste antes de chamar o Playwright (ele reaproveita o servidor que já está no ar):

```bash
# terminal 1 — API de teste no ar (por exemplo, a de uma execução anterior) em :3001
cd frontend-web
VITE_API_URL=http://localhost:3001 npx vite build --outDir build
VITE_API_URL=http://localhost:3001 npx vite preview --outDir build --port 5174 --strictPort

# terminal 2
cd e2e
npx playwright test tests/web/client/security-headers.spec.ts --project=web
```

No PowerShell, defina a variável antes: `$env:VITE_API_URL="http://localhost:3001"; npx vite build --outDir build`. A pasta `frontend-web/build` é ignorada pelo git e não sobrescreve o build normal (`dist`). Em execuções paralelas, use a porta de `E2E_WEB_PORT` e a API de `E2E_API_PORT`.

## Estrutura

```
e2e/
├── playwright.config.ts      # projetos setup/api/web, servidores de teste e variáveis da API de teste (1 worker, serial)
├── support/                  # ambiente (portas, banco, chaves de storage), usuários padrão, loja demo,
│                             # helpers de API e navegador, matchers das rotas por loja (routes.ts) e o mapa
│                             # de localização falsa da entrega por distância (geocoding-fake.ts)
├── scripts/                  # prepare.mjs (reset + build) e reset-db.mjs
└── tests/
    ├── global.setup.ts       # login de todos os perfis, loja de cada conta e loja demo aberta
    ├── api/
    │   ├── identity/         # saúde ({ status: 'ok' }), login (sessão, limite de tentativas, conta bloqueada), recuperação
    │   │                     # de senha, cadastro e convite da equipe, responsável da loja (team-hardening), equipe e
    │   │                     # lixeira, senhas fora das respostas, endereços, status/perfil da loja, uploads, banner,
    │   │                     # sessions.spec.ts (jti, POST /auth/logout, lista e encerramento de sessões, logout-all,
    │   │                     # suporte encerrado pelo próprio token), maintenance.spec.ts (limpeza de /uploads com
    │   │                     # arquivos plantados, 409 de outra instância, regravação das credenciais MP v1 → v2),
    │   │                     # review2-hardening.spec.ts (senha em tempo linear, links expirados por troca de credenciais,
    │   │                     # link do superpainel, teto de 100 sessões), web-session.spec.ts (sessão do site em cookie:
    │   │                     # Set-Cookie, refresh, rotação, tolerância, reuso, 403 de origem, 409 do suporte, logout) e
    │   │                     # account-email / account-password / account-team.spec.ts (Minha conta: confirmação, troca
    │   │                     # e "Não fui eu", senha atual, e-mail reservado, avisos, limite da equipe; os códigos dos
    │   │                     # links são plantados direto no banco *_e2e por account-helpers.ts)
    │   ├── commerce/         # catálogo, orçamento e retrato de preços, acesso aos pedidos (404 uniforme), fluxo,
    │   │                     # dashboard e relatórios, pagamentos (sandbox, idempotência), limite de endereços,
    │   │                     # order-numbers.spec.ts (número por loja, pedidos simultâneos sem buraco, imutabilidade),
    │   │                     # delivery-zones.spec.ts (bairro do CEP, faixas de CEP, recusa fora da área, PIX e cartão
    │   │                     # sem cobrança), order-rules.spec.ts (pedido mínimo e frete grátis: loja sem regras igual
    │   │                     # a antes, validação, orçamento abaixo do mínimo sem falhar, 400 ORDER_BELOW_MINIMUM no
    │   │                     # pedido, PIX e cartão, limite exato, frete grátis zerando a taxa no pedido e no PIX, zona
    │   │                     # × loja, retirada), delivery-distance.spec.ts (localizar a loja, modo distância exige o
    │   │                     # local, faixas, km adicional e raio, mínimo e frete grátis da faixa, endereço não
    │   │                     # localizado com nova tentativa depois de 1 h, simulador do painel, modo por zonas igual),
    │   │                     # orders-payments-review.spec.ts (reservas do limite mensal por PIX
    │   │                     # pendente, 404 do histórico de loja desativada) e performance.spec.ts (compressão, 413, cache
    │   │                     # de /uploads, quadro igual ao de antes)
    │   ├── tenancy/          # isolamento entre lojas: cardápio, pedidos, pagamentos e estornos, relatórios, configurações
    │   │                     # e credenciais, equipe e convites, identificadores adulterados, rotas antigas, loja suspensa,
    │   │                     # defesa em profundidade no banco (triggers e constraints) e customer-blocks.spec.ts
    │   │                     # (bloqueio de cliente nas 4 compras, outras lojas livres, lista/filtro/detalhe, auditoria)
    │   ├── platform/         # superpainel: matriz de acesso de /platform/** (inclui manutenção e e-mail de teste), lojas,
    │   │                     # usuários, configurações, mail.spec.ts (campo mail sem segredos, e-mail de teste e e-mails
    │   │                     # com a marca da loja, com o driver de log), dashboard, auditoria, sessão de suporte (somente
    │   │                     # leitura), contas da plataforma sem compras, cadastro público sem autopromoção,
    │   │                     # review2-stores.spec.ts (make_owner da plataforma, limites de convites por loja e teto sem
    │   │                     # e-mail, origem do cancelamento, cancelamento imediato só do responsável, limite de produtos
    │   │                     # rígido, slugs reservados, leituras auditadas) e review-9a-fixes.spec.ts (make_owner protegido contra a equipe)
    │   ├── billing/          # planos, assinaturas, faturas, ciclo de vida (rotina), efeitos na loja, limites do plano,
    │   │                     # webhook SaaS, separação delivery × SaaS, integrity.spec.ts (garantias do banco via SQL
    │   │                     # direto no banco *_e2e) e storage.spec.ts (cota de armazenamento e limpeza agendada)
    │   └── security/         # request-parsing.spec.ts (multipart com nomes aninhados e índices enormes, corpos
    │                         # comprimidos, limite UPLOAD em parse com falha)
    └── web/
        ├── client/           # diretório e vitrine: marca, cadastro, login/logout, recuperação de senha, cardápio,
        │                     # modal do produto, carrinho, checkout, celular, status da loja, security-headers (CSP),
        │                     # session-security.spec.ts (Sessões ativas em Meus Dados e no menu, logout no servidor,
        │                     # "Sair de todos os aparelhos" e suporte encerrado pelo próprio token), cookie-session.spec.ts
        │                     # (login em cookie, recarregar mantém a sessão, abas, expiração silenciosa na vitrine) e
        │                     # account-security.spec.ts (Segurança da conta em Meus Dados)
        ├── admin/            # painel: login e sessão, marca, Dashboard e relatórios, Cardápio, Equipe e convites,
        │                     # quadro de pedidos por perfil (inclusive pagamento estornado), assinatura, interruptor da
        │                     # loja, session-security (sessão entre abas e sessão de suporte), cookie-session.spec.ts
        │                     # (painel e suporte a partir de uma sessão em cookie), account-security.spec.ts (Minha
        │                     # conta no menu) e platform-users.spec.ts (link de redefinição com e sem SMTP)
        ├── platform/         # superpainel no navegador: stores (dashboard, lista e filtros, criação com convite de uso
        │                     # único, abas do detalhe, suspender/reativar), plans-subscriptions, users-audit, settings
        │                     # (serial: altera e restaura as configurações globais, também no afterAll), access
        │                     # (equipe, clientes e visitantes fora de /platform) e mobile (cartões em 375 px, sem
        │                     # rolagem horizontal); helpers.ts cria as lojas extras pela API
        └── multistore/       # storefront.spec.ts: diretório só com lojas que vendem, cardápios e carrinhos separados,
                              # pedido #1 da loja B, loja suspensa, recusa fora da área e "Retirar no balcão";
                              # order-rules.spec.ts (carrinho: falta para o mínimo bloqueia, falta para o frete
                              # grátis e taxa riscada; painel: valores da loja e por zona salvos) e
                              # delivery-distance.spec.ts (painel: modo distância, local da loja no mapa, faixas,
                              # "Teste um endereço"; vitrine "Entrega até 8 km" e distância no carrinho)
```

Os relatórios e evidências ficam em `playwright-report/` e `test-results/` (ignorados pelo git).

**Helpers e convenções novas**

- Sessão do site em cookie (`support/web.ts`): `useCookieSession`, `expectCookieSession`, `refreshCookie`,
  `sessionIdOf` e `REFRESH_COOKIE`; o marcador fica em `STORAGE_KEYS.session` (`support/env.ts`). `useSession` e
  `signInAs` continuam no caminho bearer (token no `localStorage`).
- Conta (`tests/api/identity/account-helpers.ts`): os specs de conta plantam o código do link direto no banco `*_e2e`
  (usando o `sql()` de `tests/api/billing/helpers.ts`), em vez de ler o e-mail.
- Superpainel e multi-loja no navegador: as lojas extras são criadas pela API com os helpers da suíte de tenancy, no
  plano interno `demo`, e desativadas no fim de cada arquivo. Lojas de plano pago têm as faturas abertas anuladas, a
  assinatura cancelada na hora e a loja desativada; os planos dos testes são privados e saem de venda no fim. A loja
  demo só ganha um produto na suíte `multistore`, que vai para a lixeira no fim. As contas do seed nunca são
  bloqueadas: cada teste cria o próprio cliente.
- `web/platform/settings.spec.ts` altera configurações globais da plataforma: roda em modo serial num único arquivo e
  restaura os valores pela tela e de novo no `afterAll`.
- Abrir o detalhe de uma conta no superpainel é auditado (`platform.users.view`), então aparece na auditoria filtrada
  por essa conta.

## Variáveis úteis

| Variável | Padrão | Uso |
|---|---|---|
| `E2E_API_PORT` / `E2E_WEB_PORT` | `3001` / `5174` | Portas do ambiente de teste |
| `E2E_DB_DATABASE` | `comestra_e2e` | Banco de teste (precisa terminar em `_e2e`) |
| `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD` | `localhost`, `5432`, `postgres`, vazio | Conexão usada para recriar o banco de teste (e pelos specs que consultam o banco por SQL). A API de teste usa as mesmas variáveis do ambiente ou, na falta delas, o `backend/.env` |
| `E2E_DEMO_STORE_SLUG` | `demo` | Loja demo do seed (equipe padrão) e loja padrão das rotas antigas (`DEFAULT_STORE_SLUG` da API de teste) |
| `E2E_SAAS_WEBHOOK_SECRET` | `e2e-saas-webhook-secret` | Segredo do webhook da cobrança SaaS na API de teste (`MP_SAAS_WEBHOOK_SECRET`) |
| `E2E_ACCOUNT_SECURITY_MODE` | `compat` | `ACCOUNT_SECURITY_MODE` da API de teste (reservado para a futura execução em `strict`) |
| `E2E_CREDENTIALS_ENCRYPTION_KEY` | `CREDENTIALS_ENCRYPTION_KEY` do ambiente ou a chave fixa de desenvolvimento | Chave com que `identity/maintenance.spec.ts` monta credenciais no formato antigo (v1) para testar a regravação. Precisa ser a mesma da API de teste; se não for, o teste é pulado com aviso |

Os usuários padrão usados nos testes ficam em `support/users.ts` e precisam estar em sincronia com `backend/src/database/seeds/default-users.ts` e com a tabela do [README da raiz](../README.md#-contas-de-demonstração).
