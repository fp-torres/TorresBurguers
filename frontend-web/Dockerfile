# Imagem do site Comestra (vitrine, painel das lojas e superpainel: o mesmo SPA React). Contexto: frontend-web/.
# Normalmente construída pelo docker-compose.yml da raiz; guia em docs/saas/docker.md.
#
# 1) build do Vite em Node 22;  2) Nginx servindo o SPA e encaminhando /api/ e /uploads/ para a API
#    (mesma origem: o navegador fala só com o Nginx).

ARG NODE_IMAGE=node:22-bookworm-slim
ARG NGINX_IMAGE=nginx:alpine

FROM ${NODE_IMAGE} AS build
# npm da mesma versão maior que gerou o package-lock.json (o npm 10 do Node 22 pode recusar o lock do npm 11)
ARG NPM_VERSION=11.11.0
RUN npm install -g "npm@${NPM_VERSION}" --no-audit --no-fund && npm cache clean --force
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Endereço da API visto pelo NAVEGADOR. Padrão: /api (relativo, mesma origem do site, atrás do Nginx desta
# imagem): funciona em http://localhost:8080, pelo IP da máquina ou atrás de um proxy HTTPS sem novo build.
# A CSP do build (vite.config.ts) libera a origem da API; com URL relativa, 'self' já cobre.
# Atenção: toda variável VITE_* vai para o JavaScript público. Nunca passe segredos aqui.
ARG VITE_API_URL=/api
# Nome exibido no site (vazio = nome padrão do produto, src/config/brand.ts)
ARG VITE_APP_NAME=
ENV VITE_API_URL=${VITE_API_URL} \
    VITE_APP_NAME=${VITE_APP_NAME}
# Mesmo build do projeto: checagem de tipos (tsc -b) + vite build, com a CSP no index.html
RUN npm run build
# Cabeçalhos de segurança do Nginx: os mesmos de securityHeaders() do vite.config.ts (os que o "vite preview"
# envia), com a CSP lida do index.html DESTE build + frame-ancestors 'none' (que só vale como cabeçalho).
# Se o build vier sem a CSP, a imagem não é gerada.
RUN node <<'EOF'
const fs = require('node:fs');
const html = fs.readFileSync('dist/index.html', 'utf8');
const match = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
if (!match) {
  console.error('dist/index.html sem a <meta http-equiv="Content-Security-Policy"> (frontend-web/vite.config.ts).');
  process.exit(1);
}
const decode = (value) => value.replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
let csp = decode(match[1]).trim().replace(/;\s*$/, '');
if (!/(^|;)\s*frame-ancestors\s/.test(csp)) csp += "; frame-ancestors 'none'";
// Valores de securityHeaders() em frontend-web/vite.config.ts (mantenha os dois iguais)
const headers = {
  'Content-Security-Policy': csp,
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=()',
};
const lines = [
  '# Gerado no build da imagem (frontend-web/Dockerfile): cabeçalhos de securityHeaders() do vite.config.ts.',
];
for (const [name, value] of Object.entries(headers)) {
  if (/["\\$\r\n]/.test(value)) {
    console.error(`Valor inesperado no cabeçalho ${name}: ${value}`);
    process.exit(1);
  }
  lines.push(`add_header ${name} "${value}" always;`);
}
fs.mkdirSync('nginx', { recursive: true });
fs.writeFileSync('nginx/security-headers.conf', `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
EOF

FROM ${NGINX_IMAGE} AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/nginx/security-headers.conf /etc/nginx/snippets/comestra-security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=6 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
