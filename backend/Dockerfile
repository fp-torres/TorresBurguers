# Imagem da API Comestra (NestJS + TypeORM). Contexto de build: backend/.
# Normalmente construída pelo docker-compose.yml da raiz (docker compose up -d --build); guia em docs/saas/docker.md.
#
# Debian slim (glibc) e não Alpine: bcrypt e sharp usam binários nativos prontos para glibc.
# A imagem final tem só dist/, as dependências de produção e o package.json (lido para a versão da API).

ARG NODE_IMAGE=node:22-bookworm-slim

# 0) npm da mesma versão maior que gerou o package-lock.json (o npm 10 do Node 22 recusa o lock do npm 11:
#    "Missing: webpack@... from lock file"). Usado só nos estágios de instalação.
FROM ${NODE_IMAGE} AS npm
ARG NPM_VERSION=11.11.0
RUN npm install -g "npm@${NPM_VERSION}" --no-audit --no-fund && npm cache clean --force

# 1) Build: todas as dependências (inclusive as de desenvolvimento) e "nest build"
FROM npm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx nest build

# 2) Dependências de produção (npm ci --omit=dev), sem o cache do npm
FROM npm AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# 3) Imagem final
FROM ${NODE_IMAGE} AS runtime
# Fail closed: sem NODE_ENV no ambiente, a API segue as regras de produção (o .env.docker define o modo).
# UPLOADS_DIR aponta para o volume das imagens enviadas; HOST/PORT: a API escuta só na rede do Docker.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    UPLOADS_DIR=/app/uploads \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false
WORKDIR /app
# Código e dependências pertencem ao root (somente leitura para o processo); só uploads/ e .temp/ aceitam
# gravação do usuário "node". Um volume novo montado em /app/uploads herda esse dono.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/uploads /app/.temp \
    && chown node:node /app/uploads /app/.temp
USER node
EXPOSE 3000
# /health é público e responde só {"status":"ok"} (sem consultar o banco)
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# As migrations pendentes rodam na subida (DB_MIGRATIONS_RUN, ligado por padrão), antes de a API aceitar conexões.
CMD ["node", "dist/main.js"]
