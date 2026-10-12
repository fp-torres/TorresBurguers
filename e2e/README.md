# Testes ponta a ponta (E2E)

Suíte [Playwright](https://playwright.dev) que exercita a **API** e o **front-end web** do Comestra como um usuário real faria: cadastro, login de cada perfil, catálogo, carrinho, checkout (dinheiro, PIX e cartão em sandbox), cozinha, entrega, painel administrativo e regras de segurança.

## Ambiente isolado

Os testes **nunca** tocam no banco de desenvolvimento. Eles sobem um ambiente próprio:

| Serviço | Endereço | Observação |
|---|---|---|
| API de teste | http://localhost:3001 | banco `comestra_e2e`, imagens em `e2e/.uploads`, `NODE_ENV=test`, `SEED_DEMO_USERS=true`, `PAYMENT_SANDBOX=true` |
| Web de teste | http://localhost:5174 | `npm run dev` do `frontend-web` apontando para a API de teste (`VITE_API_URL`) |

- O Playwright inicia os dois servidores automaticamente. Se eles já estiverem rodando nessas portas, são reaproveitados.
- A API de teste roda o build (`backend/dist`) a partir da pasta `backend`, então lê o `backend/.env` para o que não é definido acima (por exemplo, `DB_PASSWORD`).
- Os usuários padrão (um por perfil) são criados pela própria API na subida. O `tests/global.setup.ts` confere o login de todos e abre a loja antes dos testes.

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

`npm test`, `npm run test:api` e `npm run test:web` rodam antes o `scripts/prepare.mjs`. Quando a API de teste **não** está no ar, ele recria o banco `comestra_e2e` do zero e compila a API (`npm run build` no `backend`). Se ela já estiver rodando na porta 3001, o servidor e o banco atuais são reaproveitados, sem recompilar. Para testar uma mudança no backend, pare a API de teste antes.

Para iterar rápido com os servidores já no ar:

```bash
npx playwright test tests/api/commerce --project=api
npx playwright test tests/web/client --project=web --headed   # vendo o navegador
npx playwright test -g "Dashboard"                            # filtra pelo título do teste
```

Outros comandos: `npm run reset-db` (só recria o banco de teste) e `npm run typecheck` (verificação de tipos da suíte).

## Estrutura

```
e2e/
├── playwright.config.ts      # projetos setup/api/web e servidores de teste (1 worker, execução serial)
├── support/                  # ambiente (portas, banco, chaves de storage), usuários padrão e helpers de API e navegador
├── scripts/                  # prepare.mjs (reset + build) e reset-db.mjs
└── tests/
    ├── global.setup.ts       # login de todos os perfis e loja aberta
    ├── api/
    │   ├── identity/         # saúde, login, cadastro, acesso e lixeira de usuários, senhas fora das respostas,
    │   │                     # endereços, status da loja, uploads e banner
    │   └── commerce/         # catálogo, orçamento e retrato de preços, acesso aos pedidos,
    │                         # fluxo de status/entregas/cancelamento/dashboard e pagamentos (sandbox)
    └── web/
        ├── client/           # loja: marca, cadastro, login/logout, cardápio, modal do produto e carrinho
        └── admin/            # painel: login e sessão, marca, Dashboard, Cardápio e interruptor da loja
```

Os relatórios e evidências ficam em `playwright-report/` e `test-results/` (ignorados pelo git).

## Variáveis úteis

| Variável | Padrão | Uso |
|---|---|---|
| `E2E_API_PORT` / `E2E_WEB_PORT` | `3001` / `5174` | Portas do ambiente de teste |
| `E2E_DB_DATABASE` | `comestra_e2e` | Banco de teste (precisa terminar em `_e2e`) |
| `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD` | `localhost`, `5432`, `postgres`, vazio | Conexão usada para recriar o banco de teste. A API de teste usa as mesmas variáveis do ambiente ou, na falta delas, o `backend/.env` |

Os usuários padrão usados nos testes ficam em `support/users.ts` e precisam estar em sincronia com `backend/src/database/seeds/default-users.ts` e com a tabela do [README da raiz](../README.md#-usuários-padrão-um-por-perfil).
