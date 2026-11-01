# Comestra em Docker

Sobe o sistema inteiro (banco, API e site) com um comando, a partir da raiz do repositório:

```bash
docker compose up -d --build
```

e abre em **http://localhost:8080**.

Arquivos: `docker-compose.yml`, `.env.docker.example` (modelo versionado), `.env.docker` (local, com segredos,
ignorado pelo Git), `backend/Dockerfile`, `frontend-web/Dockerfile` e `frontend-web/nginx.conf`.

Referências: variáveis da API em `backend/.env.example`; instalação e operação sem Docker em
[operacao.md](operacao.md); arquitetura em [arquitetura.md](arquitetura.md).

## 1. O que sobe

```
navegador ──► http://localhost:8080 ──► web (Nginx)
                                         ├─ /            → site (build do frontend-web, rotas do SPA → index.html)
                                         ├─ /api/...     → api:3000 sem o prefixo (/api/health → /health)
                                         └─ /uploads/... → api:3000/uploads/... (imagens enviadas)
                                       api (NestJS) ──► db (PostgreSQL 18)
```

| Serviço | Imagem | Porta no computador | Dados |
|---|---|---|---|
| `web` | `comestra-web:local` (build do Vite + `nginx:alpine`) | `127.0.0.1:8080` | — |
| `api` | `comestra-api:local` (`node:22-bookworm-slim`, usuário `node`) | nenhuma | volume `comestra_uploads` (`/app/uploads`) |
| `db` | `postgres:18` | nenhuma | volume `comestra_db-data` (`/var/lib/postgresql`) |

- **Mesma origem:** o site chama a API em `/api` (URL relativa, definida no build). Funciona em `localhost`, pelo IP
  da máquina ou atrás de um proxy HTTPS sem gerar o site de novo. As imagens são carregadas de `/api/uploads/...`.
- **Rede:** o banco fica numa rede interna, sem saída para a internet e sem porta no computador. A API está nas duas
  redes (sai para a internet: consulta de CEP, Mercado Pago, SMTP). Só o Nginx tem porta publicada.
- **Migrations:** aplicadas pela própria API na subida (`DB_MIGRATIONS_RUN=true`), antes de ela aceitar conexões;
  `DB_SYNCHRONIZE=false`. Uma subida sem migrations pendentes não faz nada no schema.
- **Saúde:** `db` (pg_isready), `api` (`GET /health`) e `web` (página inicial). O `web` só sobe com a API saudável,
  e a API só com o banco saudável: quando o `docker compose up -d` termina, o site já funciona.
- **IP real do cliente:** o Nginx acrescenta o IP de quem conectou ao `X-Forwarded-For`, e a API confia em um salto
  (`TRUST_PROXY=1`). Nunca use `TRUST_PROXY=true`: o Express usaria o IP escrito pelo próprio cliente.
- **Cabeçalhos do site:** os mesmos de `securityHeaders()` do `frontend-web/vite.config.ts` (CSP com
  `frame-ancestors 'none'`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`).
  A CSP do cabeçalho é lida do `index.html` do próprio build. A API envia os dela em `/api` e `/uploads`.
- **Cache:** arquivos com hash em `/assets/` por 1 ano (`immutable`); `index.html` sempre revalidado (`no-cache`).
  Compressão gzip nos arquivos do site. Em `/api/` e `/uploads/` o Nginx não comprime (`gzip off`): a própria API
  comprime as respostas (gzip/br) e o Nginx só as repassa, sem compressão dupla. `/uploads` sai da API com cache de
  30 dias (`immutable`).
- **Sessão do site em cookie:** como site e API são a mesma origem, o login pela tela recebe o refresh num cookie
  `HttpOnly` (`SameSite=Strict`, `Path=/`). No modo demonstração local (`NODE_ENV=development`, http) o cookie se chama
  `comestra_rt` e vai sem `Secure`; em produção (ou atrás de HTTPS) vira `__Host-comestra_rt`, com `Secure`,
  automaticamente. Variáveis no bloco "Sessão do site" do `.env.docker` (`AUTH_WEB_COOKIE=true`,
  `JWT_ACCESS_EXPIRES_IN=15m`, `AUTH_COOKIE_ORIGINS` vazio = `CORS_ORIGINS`/`APP_WEB_URL`); detalhes em
  [operacao.md](operacao.md), seção 7.3.
- **Logs de acesso do site:** o Nginx usa o `log_format comestra`, que não registra `Cookie`, `Set-Cookie` nem
  `Authorization` e troca por `[redacted]`, no caminho e no `Referer`, os tokens dos links de uso único
  (`/redefinir-senha`, `/convite`, `/verificar-email`, `/confirmar-email`, `/desfazer-troca-de-email`,
  `/api/auth/reset-password`, `/api/invitations` e `/api/account/email-change|email-revert|email-verification`, exceto
  o segmento `confirm`). Ao criar uma rota nova com `:token`, inclua-a nos dois `map` do `frontend-web/nginx.conf`
  (`$comestra_log_uri` e `$comestra_log_referer`).
- **Privilégios:** a API roda sem nenhuma capability (`cap_drop: ALL`); o `web` roda com `cap_drop: ALL` mais `CHOWN`,
  `DAC_OVERRIDE`, `SETGID`, `SETUID` e `NET_BIND_SERVICE` (o mínimo para o Nginx iniciar). O Git ignora `.env.docker`
  e qualquer `.env.docker.*` (cópias e backups), exceto o `.env.docker.example`. Pendência conhecida: o `db` ainda
  recebe o `.env.docker` inteiro e a API conecta como superusuário do PostgreSQL; a evolução prevista é um segredo só
  do banco (`POSTGRES_PASSWORD_FILE`) e um papel `comestra_app` sem superusuário (`arquitetura.md`, seção 12).

## 2. Requisitos

- Docker com Compose v2 (Docker Desktop no Windows e no macOS, com WSL2 no Windows; ou Docker Engine no Linux).
  Testado com Docker 29.9 / Compose 5.6.
- Cerca de 3 GB livres em disco para as imagens e o build, e a porta 8080 livre (ou outra, seção 9).
- Internet na primeira construção (imagens base e pacotes npm).

## 3. Primeira subida

1. Crie o `.env.docker` a partir do modelo:

   ```bash
   cp .env.docker.example .env.docker                 # bash / Git Bash
   Copy-Item .env.docker.example .env.docker          # PowerShell
   ```

2. Preencha os três segredos obrigatórios (`POSTGRES_PASSWORD`, `JWT_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`).
   Para gerar cada um (não precisa de Node instalado):

   ```bash
   docker run --rm node:22-bookworm-slim node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"     # POSTGRES_PASSWORD
   docker run --rm node:22-bookworm-slim node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"     # JWT_SECRET
   docker run --rm node:22-bookworm-slim node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # CREDENTIALS_ENCRYPTION_KEY
   ```

   Guarde uma cópia do `CREDENTIALS_ENCRYPTION_KEY`: sem ela, as credenciais do Mercado Pago gravadas pelas lojas
   ficam ilegíveis. O modelo já vem no **modo demonstração** (`NODE_ENV=development`); para produção, seção 7.

3. Construa e suba:

   ```bash
   docker compose up -d --build
   docker compose ps          # db, api e web devem aparecer como "healthy"
   ```

   A primeira construção leva alguns minutos; a primeira subida da API aplica todas as migrations (segundos).

4. Abra **http://localhost:8080**. A API responde em http://localhost:8080/api/health (`{"status":"ok"}`).

5. Crie o superadmin (seção 6) para entrar no superpainel.

## 4. Contas

### Modo demonstração (`NODE_ENV=development`)

Na primeira subida, num banco vazio, a API cria a **Lanchonete Demo** (`/loja/demo`, sem produtos: cadastre-os no
painel) e as contas abaixo, com senhas **públicas** (as mesmas do README):

| Perfil | E-mail | Senha | Onde entrar |
|---|---|---|---|
| Administrador da loja | `admin@comestra.com.br` | `Admin@123` | `/login` → painel da loja |
| Atendente | `atendente@comestra.com.br` | `Atendente@123` | `/login` |
| Cozinha | `cozinha@comestra.com.br` | `Cozinha@123` | `/login` |
| Entregador | `entregador@comestra.com.br` | `Entregador@123` | `/login` |
| Cliente | `cliente@comestra.com.br` | `Cliente@123` | `/signin` (vitrine) |

Pagamentos do delivery em **sandbox** (sem `MP_ACCESS_TOKEN`): o cartão de teste é aprovado e o PIX de teste é
considerado pago depois de `PIX_SANDBOX_APPROVAL_SECONDS` (5 s). Com `MAIL_DRIVER=log`, os e-mails (convites,
redefinição de senha) não saem: o texto completo, com o link, aparece em `docker compose logs api`.

O superadmin de demonstração (senha pública) fica desligado (`SEED_DEMO_SUPERADMIN=false`): crie o seu pelo comando.

### Superadmin

Criado só pelo comando (nenhuma rota HTTP concede o papel global). Entre em `/login` com ele e abra `/platform`.

## 5. Dia a dia

| Tarefa | Comando |
|---|---|
| Subir (ou aplicar mudanças do `.env.docker`) | `docker compose up -d` |
| Situação e saúde | `docker compose ps` |
| Logs (todos / só a API, acompanhando) | `docker compose logs --tail=100` · `docker compose logs -f api` |
| Reiniciar a API | `docker compose restart api` |
| Parar sem remover nada | `docker compose stop` |
| Parar e remover os containers (os **volumes ficam**) | `docker compose down` |
| Apagar TUDO, inclusive banco e imagens enviadas | `docker compose down -v` (irreversível: faça backup antes) |
| Terminal no container da API / banco | `docker compose exec api sh` · `docker compose exec db psql -U comestra comestra` |

**Atualizar para uma versão nova do código:** faça o backup (seção 8), depois

```bash
git pull
docker compose up -d --build
docker compose ps                                        # tudo "healthy"?
docker compose exec api npm run --silent migration:show:prod   # [X] = aplicada · [ ] = pendente
```

A API nova aplica as migrations pendentes na subida (cada uma na própria transação; uma falha desfaz só ela e
impede a subida: veja o log). Para reconstruir do zero: `docker compose build --no-cache`.

Os logs de cada container são rotacionados (3 arquivos de 10 MB).

## 6. Superadmin

Com os containers no ar:

```bash
# Criar (senha forte aleatória, exibida UMA vez no terminal)
docker compose exec api npm run platform:superadmin:prod -- --email=ops@seudominio.com.br --name="Seu Nome"

# Criar escolhendo a senha (12+ caracteres, com maiúscula, minúscula e número ou símbolo)
docker compose exec -e SUPERADMIN_PASSWORD='Sua-Senha-Forte-1' api npm run platform:superadmin:prod -- --email=ops@seudominio.com.br --name="Seu Nome"

# Recuperar o acesso (senha nova aleatória; encerra as sessões da conta)
docker compose exec api npm run platform:superadmin:prod -- --email=ops@seudominio.com.br --reset-password

# Remover o papel
docker compose exec api npm run platform:superadmin:prod -- --email=ops@seudominio.com.br --revoke
```

Equivalente sem o npm: `docker compose exec api node dist/platform/cli/superadmin.js --email=... --name="..."`.
Outras opções (`--promote-existing`) e regras: [operacao.md](operacao.md), seção 5.

Não grave `SUPERADMIN_PASSWORD` no `.env.docker`: o arquivo vai inteiro para o ambiente da API, e com ela definida
o `--reset-password` repetiria sempre a mesma senha. Passe-a só no comando, com `-e`.

## 7. Demonstração × produção

| | Demonstração local (padrão do modelo) | Produção |
|---|---|---|
| `NODE_ENV` | `development` | `production` |
| Loja e contas demo (senhas públicas) | criadas (`SEED_DEMO_USERS=true`) | nunca (`SEED_DEMO_USERS=false`) |
| Pagamentos do delivery | sandbox automático | credenciais de produção de cada loja; sandbox recusado |
| E-mail | `MAIL_DRIVER=log` (texto no log da API) | `MAIL_DRIVER=smtp` + `SMTP_*` + `MAIL_FROM` |
| Endereços | `http://localhost:8080` | `https://app.seudominio.com.br` (`APP_WEB_URL`, `CORS_ORIGINS`, `PUBLIC_API_URL` com `/api`) |
| `TRUST_PROXY` | `1` (só o Nginx) | `2` com um proxy HTTPS na frente do Nginx (seção 10) |
| HSTS da API, Swagger | não / desligado | sim / desligado |
| Segredos | gerados para esta máquina | novos e exclusivos do servidor, com cópia em cofre |

O modo demonstração é para **este computador**: a porta fica em `127.0.0.1` e qualquer pessoa que conheça as senhas
públicas entraria como administrador da loja demo. Não o exponha na rede nem na internet.

Trocar de modo num banco que já tem os dados de demonstração não os apaga: para produção, comece com volumes novos
(`docker compose down -v` numa instalação de teste) ou remova a loja e as contas demo pelo superpainel. O bloco
"PRODUÇÃO" no fim do `.env.docker.example` lista tudo o que muda.

## 8. Backup e restauração

Os comandos abaixo gravam e leem os arquivos **dentro do container** e os copiam com `docker compose cp`: funcionam
igual no bash e no PowerShell (no Windows PowerShell 5.1, redirecionar a saída binária do `pg_dump` com `>`
corrompe o arquivo).

### Banco (pg_dump / pg_restore)

```bash
# Backup (formato custom, comprimido)
docker compose exec db pg_dump -U comestra -d comestra -Fc -f /tmp/comestra.dump
docker compose cp db:/tmp/comestra.dump ./comestra-AAAAMMDD.dump
docker compose exec db rm /tmp/comestra.dump

# Restauração (substitui o conteúdo atual do banco)
docker compose stop api web
docker compose cp ./comestra-AAAAMMDD.dump db:/tmp/comestra.dump
docker compose exec db pg_restore -U comestra -d comestra --clean --if-exists --no-owner /tmp/comestra.dump
docker compose exec db rm /tmp/comestra.dump
docker compose up -d
```

Para levar um backup da instalação sem Docker para o Docker (ou o contrário), use o mesmo par
`pg_dump -Fc` / `pg_restore --no-owner`; num banco do Docker recém-criado, suba a API só depois da restauração (ela
aplica as migrations que faltarem).

### Imagens enviadas (volume `comestra_uploads`)

```bash
# Backup: cópia da pasta para o computador
docker compose cp api:/app/uploads ./uploads-AAAAMMDD

# Restauração: copia de volta e devolve a posse ao usuário da API ("node"). O "docker compose cp" grava os
# arquivos como root, e o container da API roda sem nenhuma capability (cap_drop: ALL), então a troca de dono
# usa um container avulso com só a capability CHOWN:
docker compose cp ./uploads-AAAAMMDD/. api:/app/uploads/
docker compose run --rm --no-deps -u root --cap-add CHOWN --entrypoint chown api -R node:node /app/uploads
```

No **Git Bash** (Windows), caminhos que começam com `/` nos argumentos (ex.: `/tmp/comestra.dump`,
`/app/uploads`) são convertidos em caminhos do Windows antes de chegar ao Docker. Rode esses comandos com
`MSYS_NO_PATHCONV=1` na frente (ex.: `MSYS_NO_PATHCONV=1 docker compose exec db pg_dump ...`) ou use o PowerShell.

Faça os dois backups juntos (o banco referencia os arquivos pelo nome) e antes de cada atualização.

### Trocar a senha do banco

O `POSTGRES_PASSWORD` só vale na criação do volume. Para trocá-la depois:

```bash
docker compose exec db psql -U comestra -d comestra -c "ALTER USER comestra PASSWORD 'NOVA_SENHA'"
# troque POSTGRES_PASSWORD no .env.docker pelo mesmo valor e recrie a API:
docker compose up -d
```

## 9. Porta, interface e outros ajustes

- **Outra porta ou acesso pela rede:** o `docker-compose.yml` lê do ambiente do terminal `COMESTRA_HTTP_PORT`
  (padrão `8080`) e `COMESTRA_HTTP_BIND` (padrão `127.0.0.1`, só esta máquina):

  ```bash
  COMESTRA_HTTP_PORT=8081 docker compose up -d                 # bash
  $env:COMESTRA_HTTP_PORT = "8081"; docker compose up -d       # PowerShell
  ```

  Ajuste também `APP_WEB_URL`, `CORS_ORIGINS` e `PUBLIC_API_URL` no `.env.docker`. `COMESTRA_HTTP_BIND=0.0.0.0`
  abre o site para a rede local: só com `NODE_ENV=production` (sem contas de demonstração).
- **Nome do site:** `VITE_APP_NAME` no ambiente do terminal durante o `docker compose build web` (vai para o
  JavaScript público). O nome da plataforma nos e-mails e logs é `APP_NAME` no `.env.docker`.
- **Banco acessível por um cliente local (depuração):** crie um `docker-compose.override.yml` (lido
  automaticamente) com `services: { db: { ports: ["127.0.0.1:55432:5432"] } }`.
- **Limpeza automática das imagens sem uso:** `UPLOADS_CLEANUP_INTERVAL_HOURS=24` no `.env.docker`.
- **Banco sob carga:** `DB_POOL_SIZE` (padrão `10`), `DB_STATEMENT_TIMEOUT_MS` (padrão `60000`: o mesmo prazo do
  `proxy_read_timeout` de 60 s do Nginx em `/api/`), `DB_POOL_ACQUIRE_TIMEOUT_MS` (padrão `30000`) e
  `PLATFORM_INSIGHTS_CACHE_MS` (padrão `30000`) podem ir no `.env.docker`; vazios usam o padrão. Se aumentar o
  `DB_STATEMENT_TIMEOUT_MS` acima de 60 s, aumente também o `proxy_read_timeout` do `frontend-web/nginx.conf`.

## 10. HTTPS (proxy reverso na frente)

Os containers falam HTTP. Num servidor, coloque um proxy HTTPS **na mesma máquina** encaminhando para
`127.0.0.1:8080` (padrão do `COMESTRA_HTTP_BIND`). Exemplo com Caddy (certificado automático):

```
app.seudominio.com.br {
    reverse_proxy 127.0.0.1:8080
    header Strict-Transport-Security "max-age=15552000; includeSubDomains"
}
```

Com Nginx no servidor:

```nginx
server {
    listen 443 ssl;
    server_name app.seudominio.com.br;
    # ssl_certificate / ssl_certificate_key ...
    client_max_body_size 12m;
    add_header Strict-Transport-Security "max-age=15552000; includeSubDomains" always;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

No `.env.docker`: `APP_WEB_URL`, `CORS_ORIGINS` e `PUBLIC_API_URL` com `https://` (o último com `/api`), e
`TRUST_PROXY=2` (o proxy HTTPS + o Nginx do container). O proxy de fora precisa ACRESCENTAR o IP de quem conectou ao
`X-Forwarded-For` (Caddy e o exemplo acima fazem isso); com `1`, todos os clientes pareceriam ter o IP do proxy e os
limites por IP (login, cadastro, pedidos) seriam compartilhados. Webhook do Mercado Pago:
`MP_NOTIFICATION_URL=https://app.seudominio.com.br/api/payment/webhook`.

Com `NODE_ENV=production`, o cookie da sessão do site passa a se chamar `__Host-comestra_rt` e a exigir HTTPS
(`Secure`), mesmo com o Nginx do container falando http com a API: abra o site sempre pelo endereço `https://`. O
proxy de fora não deve registrar os cabeçalhos `Cookie`, `Set-Cookie` e `Authorization` nos logs.

**Atualizando uma instalação que já estava em uso:** faça o backup do banco (seção 8) antes do
`docker compose up -d --build`; a API aplica sozinha as migrations novas na subida. Se a instalação anterior não
tinha as sessões registradas (`AuthSessions`), defina `JWT_LEGACY_ISSUED_BEFORE` no `.env.docker` com o instante do
deploy (já previsto no bloco "PRODUÇÃO" do modelo) ou todos entram de novo ([operacao.md](operacao.md), seção 3.1).

## 11. Solução de problemas

| Sintoma | Causa e solução |
|---|---|
| `docker: command not found` / `O termo 'docker' não é reconhecido` (Windows) | O terminal (ou o VS Code) foi aberto antes da instalação do Docker Desktop e não tem o PATH novo. Feche e abra o terminal (no VS Code, feche-o por completo). Paliativo na sessão atual: PowerShell `$env:Path += ";$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin"` (instalação por usuário) ou `;C:\Program Files\Docker\Docker\resources\bin` (instalação para todos); Git Bash `export PATH="/c/Users/$USERNAME/AppData/Local/Programs/DockerDesktop/resources/bin:$PATH"`. |
| `Cannot connect to the Docker daemon` / `open //./pipe/dockerDesktopLinuxEngine` | O Docker Desktop não está rodando: abra-o e espere "Engine running". |
| `env file ... .env.docker not found` | Falta criar o `.env.docker` (seção 3). |
| `docker compose up` termina com `dependency failed to start: container comestra-api-1 is unhealthy` | Veja `docker compose logs api`. Comuns: `JWT_SECRET` vazio ou curto em produção; senha do banco diferente da gravada no volume (`password authentication failed`: seção 8, "Trocar a senha do banco"); migration com erro. |
| `Bind for 127.0.0.1:8080 failed: port is already allocated` | A porta 8080 está em uso: `COMESTRA_HTTP_PORT=8081` (seção 9). |
| `502 Bad Gateway` em `/api/...` | A API está reiniciando ou caiu: `docker compose ps` e `docker compose logs api`. O Nginx volta a encontrá-la sozinho. |
| Login responde 429 depois de poucas tentativas para todo mundo | Os limites por IP estão num balde só: falta `TRUST_PROXY` (ou o valor não corresponde aos proxies). No Docker Desktop do Windows/macOS todas as conexões locais chegam com o mesmo IP interno, o que é esperado só na máquina local. |
| Links dos e-mails apontam para `http://localhost:5173` | `APP_WEB_URL` vazio ou inválido no `.env.docker`. |
| E-mails sem o logo da loja | `PUBLIC_API_URL` vazio ou sem `/api`. |
| Depois de recarregar a página, a sessão some (volta ao login) | Confira se o login trouxe `Set-Cookie: comestra_rt` (ou `__Host-comestra_rt` em produção) em `/api/auth/login` e se `POST /api/auth/web/refresh` responde 200 (ferramentas do navegador → Rede). Em produção, o site precisa ser aberto por `https://`. Endereço diferente do de `APP_WEB_URL`/`CORS_ORIGINS` (outra porta ou o IP da máquina) faz o site voltar ao modo bearer, que também funciona. `AUTH_WEB_COOKIE=false` desliga o modo cookie. |
| Quero conferir que os logs não guardam tokens | `docker compose logs web`: os links de redefinição, convite e confirmação aparecem com `[redacted]`, e nenhuma linha traz `Cookie` ou `Authorization`. |
| `web` não fica saudável e o log tem `[emerg] ... Operation not permitted` | Falta uma capability ao Nginx: confira o bloco `cap_add` do serviço `web` no `docker-compose.yml`. |
| Site antigo depois de atualizar | `docker compose up -d --build` (sem `--build` a imagem antiga continua) e recarregue a página. |
| `npm ci` falha no build (`Missing: ... from lock file`) | O `package-lock.json` não corresponde ao `package.json`: rode `npm install` na pasta do projeto e construa de novo. Os Dockerfiles usam o npm 11, o mesmo que gerou os locks (`ARG NPM_VERSION`). |
| Erro de compilação no build da API ou do site | O mesmo erro aparece no `npm run build` local: corrija o código e construa de novo. |
| SMTP no próprio computador não conecta | Dentro do container, `localhost` é o próprio container: use `SMTP_HOST=host.docker.internal`. |
| Começar do zero (apaga dados) | `docker compose down -v` e `docker compose up -d --build`. |
