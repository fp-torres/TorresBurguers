# 💻 Comestra | Frontend Web (diretório, vitrines, painel da loja e superpainel)

> **Cozinha, balcão e entrega no mesmo compasso.**

Este diretório contém a **interface web da plataforma Comestra SaaS**, num único aplicativo React:

- **Diretório e vitrines**: a página inicial lista as lojas, e cada loja tem a própria vitrine em `/loja/<slug>` (cardápio, carrinho, checkout), com a identidade visual que vem da API.
- **Conta do cliente**: cadastro, login, Meus Pedidos (de todas as lojas), Meus Dados (com **Segurança da conta**), recuperação de senha, aceite de convite e as páginas dos links de confirmação e troca de e-mail.
- **Painel da loja**: Dashboard, quadro de pedidos, cardápio, equipe e convites, clientes, lixeira, configurações e assinatura.
- **Superpainel** (`/platform`): lojas, usuários, planos, assinaturas e faturas, financeiro, auditoria e configurações da plataforma.

O nome da plataforma (logo, título da aba e rodapé) vem de `src/config/brand.ts` e pode ser trocado com `VITE_APP_NAME`. A identidade de cada loja (nome, logo, cor) vem da API. Contratos da API: [`docs/saas/arquitetura.md`](../docs/saas/arquitetura.md).

---

# 🚀 Tecnologias Utilizadas

- **React 19 + Vite 7**: build rápido; o build de produção injeta a Content-Security-Policy.
- **TailwindCSS v4**: estilização utilitária com tema claro/escuro.
- **React Router 7**: rotas da vitrine, do painel e do superpainel, protegidas por perfil.
- **Axios**: cliente HTTP com o token da sessão da aba, cancelamento de chamadas da sessão anterior e tratamento de sessão expirada.
- **Lucide React / Iconify**: ícones.
- **Recharts**: gráficos do Dashboard e do superpainel.
- **Context API**: sessão (Auth), vitrine (Storefront), carrinho por loja (Cart), tema (Theme) e status da loja (StoreStatus).
- **Mercado Pago (SDK JS v2)**: tokenização do cartão no navegador com a chave pública **da loja** (carregado só para clientes).

---

# ✨ Funcionalidades Principais

## 🛒 Diretório e vitrine (cliente)

- **Diretório de lojas** em `/` com busca; a vitrine de cada loja em `/loja/<slug>`.
- **Catálogo** com busca (nome e descrição, sem diferenciar acentos), categorias, combos e ofertas; preço promocional igual ao que a API cobra.
- **Personalização**: ponto da carne, retirada de ingredientes, adicionais (só os permitidos no produto) com quantidade e observação.
- **Carrinho por loja** (`comestra.cart.<storeId>`), que sobrevive ao recarregar a página; `/cart` e `/order-success` antigos levam à última loja visitada.
- **Loja aberta/fechada/indisponível**: o status é consultado a cada 30 s e ao voltar para a aba. Com a loja fechada ou indisponível, o cardápio continua visível e o checkout fica bloqueado, com a mensagem da loja.
- **Checkout**: retirada ou entrega (endereço com busca de CEP; até 20 endereços por conta; a API confere o bairro pelo CEP e o carrinho avisa "Pelo CEP, o bairro é …" quando difere), total calculado pela API, pagamento online (PIX ou cartão, com o pedido criado pelo servidor após a aprovação) ou na entrega/retirada (dinheiro com troco de até R$ 200 acima do total, ou maquininha).
- **Meus Pedidos** de todas as lojas (os 100 mais recentes), com o número do pedido **na loja** (`Pedido #N`), status, forma de pagamento e cancelamento enquanto o pedido aguarda confirmação. A confirmação do pedido também mostra o número (com pagamento online, ela busca o pedido para obtê-lo).
- **Fora da área de entrega**: numa loja que recusa endereços fora das zonas, o carrinho mostra o aviso junto do endereço ("Nada foi cobrado."), a taxa "Fora da área", bloqueia o pagamento e oferece "Retirar no balcão".
- **Meus Dados**: nome, telefone, e-mail (só leitura), foto (envio de imagem ou um dos avatares prontos), exclusão da conta, **Sessões ativas** (aparelhos conectados, "Encerrar" e "Sair de todos os aparelhos") e **Segurança da conta** (`components/Account/AccountSecurity.tsx`): e-mail com o selo Confirmado/Não confirmado e reenvio da confirmação, troca de e-mail com confirmação no endereço novo e troca de senha com a senha atual. Pedido com pagamento estornado no Mercado Pago aparece como "Estornado" em Meus Pedidos.

## ⚙️ Painel da loja

- **Dashboard** (Administrador): faturamento, ticket médio, fila de produção, gráficos e relatórios (conforme o plano) no fuso da loja.
- **Quadro de Pedidos**: colunas por etapa (atualizadas a cada 5 s, com pausa quando a aba fica oculta e sem redesenhar quando nada mudou), ações e visão conforme o perfil (a cozinha vê só Novos e Preparando; o entregador, as entregas prontas e as dele), despacho com sugestão de pedidos do mesmo bairro e interruptor da loja. Os cartões, o modal do entregador e o Dashboard mostram `Pedido #<número da loja>` (o id interno fica no `title`). Pedido com o pagamento estornado ou contestado no Mercado Pago depois da aprovação aparece como **"Estornado no Mercado Pago"** em vermelho, com alerta no cartão e uma faixa no topo do quadro.
- **Cardápio**, **Equipe** (cadastro, convites com link de uso único, responsável protegido; convite de troca do responsável marcado "Criado pela plataforma", sem "Revogar"; erros 429/409 dentro do formulário), **Lixeira**.
- **Clientes**: quem comprou na loja e o histórico de pedidos; selo "Bloqueado", filtro Todos/Bloqueados e, para o Administrador, bloquear (motivo obrigatório + confirmação) e desbloquear, na lista e no detalhe.
- **Sessões ativas** e **Minha conta** no menu lateral (painel e superpainel; ocultos em sessão de suporte).
- **Configurações**: dados da loja, endereço, horários, fuso, entrega e retirada (zonas por bairro e/ou faixa de CEP, taxas, "Entregar com uma taxa padrão" ou "Recusar a entrega" fora das zonas), mensagens, logo e cor, credenciais Mercado Pago.
- **Assinatura**: plano, limites e uso (inclusive o medidor "Armazenamento"), faturas, pagamento (quando há provedor recorrente) e cancelamento no fim do período. Cancelamento agendado pela plataforma aponta para o suporte; o cancelamento imediato fica só com o responsável pela loja.
- **Tabelas no celular**: abaixo de 640 px, as listas do painel e do superpainel viram cartões (`DataTable stackOnMobile`).

## 🛡 Superpainel

- **Dashboard e Financeiro**: MRR, ARR, churn, GMV das lojas e receita da plataforma separados, alertas.
- **Lojas**: lista com filtros, criação (com convite do responsável), detalhe com equipe, convites, métricas, assinatura e auditoria; suspender, reativar, desativar e restaurar com motivo; **sessão de suporte** somente leitura.
- **Usuários**, **Planos** (limites de equipe, produtos, pedidos e **armazenamento**), **Assinaturas** (faturas: registrar pagamento, recusar e anular com motivo; medidor de armazenamento; quem agendou o cancelamento), **Auditoria** (filtros por ação, grupo e alvo; rótulos para as ações novas) e **Configurações** (loja padrão, tolerância, suporte, autoatendimento; **E-mail transacional**, com driver, servidor, remetente e "Enviar e-mail de teste"; **Manutenção**: otimizar imagens, limpar arquivos sem uso — "Verificar" e "Apagar sem uso" — e regravar as credenciais do Mercado Pago; linha da **limpeza automática**).

---

# 🏗 Estrutura de Pastas

```bash
frontend-web/
├── public/              # favicon.svg (marca da plataforma)
├── src/
│   ├── components/      # Componentes reutilizáveis (BrandLogo, modais, Sidebar, StoreToggle, Driver...)
│   │   ├── Account/     # Segurança da conta (e-mail, confirmação, troca de e-mail e de senha)
│   │   ├── charts/      # ChartCard, ChartContainer, ChartDataDetails e chartTheme (gráficos do painel e do superpainel)
│   │   └── ui/          # Kit de UI (import de "components/ui")
│   ├── config/          # brand.ts: nome, slogan, e-mail de suporte, chaves do localStorage
│   ├── contexts/        # Auth, Storefront, Cart (por loja), Theme, StoreStatus
│   ├── hooks/           # usePaginatedQuery, usePolling (pausa com a aba oculta), useDebouncedValue, useResource,
│   │                    # useNow e useMediaQuery
│   ├── layouts/         # StoreLayout/ClientLayout (vitrine), DefaultLayout (painel), PlatformLayout (superpainel)
│   ├── pages/           # Directory, Client, Auth, Login, painel (Dashboard, Orders, Products, Users, Trash,
│   │                    # Customers, Settings, Subscription), Platform/* e NotFound
│   ├── routes/          # Rotas (index.tsx) e guardas por perfil (guards.tsx)
│   ├── services/        # api.ts (Axios, transporte da sessão e renovação em cookie, paginação, toQuery,
│   │                    # safeRedirect, assetUrl), serviços por recurso (accountService, addressService,
│   │                    # cepService...), platform/* (superpainel) e mercadoPago.ts
│   ├── types/           # saas.ts: loja, assinatura, fatura, sessão de suporte
│   └── utils/           # Máscaras, formatação pt-BR, datas (dates.ts), validações compartilhadas (validation.ts),
│                        # perfis, pedidos (isPaymentReversed), catálogo, última loja, situações SaaS
├── vite.config.ts       # CSP do build, cabeçalhos do vite preview (securityHeaders) e pedaços react/charts
├── Dockerfile · nginx.conf # imagem do site para o Docker (mesma origem: /api → API; logs sem tokens)
├── .env.example         # Modelo das variáveis de ambiente
└── tailwind.config.js
```

## 🧩 Kit de UI (`src/components/ui`)

`PageHeader`, `DataTable`, `Pagination`, `SearchInput`, `FilterTabs`, `StatusBadge`, `EmptyState`, `ErrorState`, `Modal`, `FormField`, `StatCard`, `Tabs`, `CopyField` e `Switch` (estilos comuns em `styles.ts`). As listas do painel e do superpainel usam `usePaginatedQuery` com o formato `{ items, total, page, pageSize }` da API.

**Tabelas no celular**: `<DataTable stackOnMobile>` troca, abaixo de 640 px (`useMediaQuery`), cada linha por um cartão: a coluna principal no topo, os demais dados em pares "rótulo: valor" (`dl`) e as ações num rodapé. Só um dos formatos existe no DOM por vez; o desktop não muda. Por coluna: `mobile` (`'primary' | 'field' | 'actions' | 'hidden'`; padrão: a 1ª coluna é a principal e a de key `actions` vai para o rodapé) e `mobileLabel` (rótulo quando o cabeçalho não é texto). Tipo `ColumnMobileRole` exportado por `components/ui`.

## 🧭 Rotas

| Área | Rotas | Guarda |
|---|---|---|
| Plataforma (pública) | `/` (diretório de lojas), `/cadastrar-loja` (autoatendimento, quando habilitado no superpainel) | — |
| Vitrine da loja | `/loja/:slug`, `/loja/:slug/cart`, `/loja/:slug/order-success` (`/cart` e `/order-success` antigos vão para a última loja visitada) | — |
| Conta | `/signin`, `/signup`, `/my-orders`, `/profile`, `/esqueci-senha`, `/redefinir-senha/:token`, `/convite/:token`, `/verificar-email/:token`, `/confirmar-email/:token`, `/desfazer-troca-de-email/:token` | `RequireAuth` em Meus Pedidos e Meus Dados |
| Painel da loja | `/login`, `/dashboard`, `/orders`, `/products`, `/users`, `/trash`, `/customers`, `/settings`, `/subscription` (`/admin` → `/dashboard`) | `StaffRoute` (equipe com loja) + `RoleRoute` por perfil |
| Superpainel | `/platform`, `/platform/stores`, `/platform/stores/new`, `/platform/stores/:id`, `/platform/plans`, `/platform/subscriptions`, `/platform/users`, `/platform/finance`, `/platform/audit`, `/platform/settings` | `PlatformRoute` (superadministrador fora de sessão de suporte) |

Rotas desconhecidas mostram a página 404 do layout correspondente.

---

# 📦 Instalação e Execução

Pré-requisitos: **Node.js 22+** e a API rodando (pasta `backend`, `npm run start:dev`). O passo a passo completo, com banco de dados e contas de demonstração, está no [README da raiz](../README.md#-como-rodar).

```bash
cd frontend-web
npm install
cp .env.example .env     # opcional; Windows: Copy-Item .env.example .env
npm run dev              # http://localhost:5173
```

| Variável | Obrigatória | Padrão | Para que serve |
|---|---|---|---|
| `VITE_API_URL` | não | `http://localhost:3000` | Endereço da API, sem barra no final. Também é lida no **build** e no `vite preview` para montar a CSP (`connect-src`, `img-src`) e os cabeçalhos: gere o build de produção com a URL real da API. |
| `VITE_APP_NAME` | não | `Comestra` | Nome da plataforma exibido (logo, título da aba, rodapé). |
| `VITE_MP_PUBLIC_KEY` | não | chave de **teste** do Mercado Pago | Chave pública de compatibilidade. Cada loja usa a chave pública do próprio perfil (`payments.mp_public_key`); o Access Token é secreto e fica só na API. |
| `VITE_AUTH_TRANSPORT` | não | `auto` | Transporte da sessão. `auto`: sessão em cookie quando a API permite (volta sozinho ao token no `localStorage` quando não permite). `bearer`: nunca usa o cookie (kill switch; exige build novo). |

> As variáveis `VITE_*` entram no JavaScript público do site: nunca coloque segredos nelas. Depois de alterar o `.env`, reinicie o `npm run dev` ou gere o build de novo.

Endereços em desenvolvimento: `http://localhost:5173` (diretório), `http://localhost:5173/loja/demo` (vitrine da loja demo), `/signin` (cliente) e `/login` (equipe e superadministrador).

```bash
npm run build     # verificação de tipos (tsc -b) + build de produção em dist/, com a CSP na <meta>;
                  # React + roteador no pedaço "react" e o Recharts no pedaço "charts" (~364 kB, carregado sob demanda)
npm run preview   # serve o build localmente com os cabeçalhos de segurança de securityHeaders()
npm run lint      # ESLint
```

## 🔒 CSP e cabeçalhos do build

- `vite build` injeta `<meta http-equiv="Content-Security-Policy">` e `<meta name="referrer" content="strict-origin-when-cross-origin">` no `index.html`. O Vite de desenvolvimento **não** tem CSP (usa scripts inline do React Refresh).
- A política libera a origem de `VITE_API_URL`, os domínios do Mercado Pago (`*.mercadopago.com[.br]`, `*.mercadolibre.com`, `*.mercadolivre.com[.br]`, `*.mlstatic.com`), Iconify (`api.iconify.design`, `api.simplesvg.com`, `api.unisvg.com`) e os avatares (`cdn-icons-png.flaticon.com`).
- O servidor que hospeda o build deve enviar os cabeçalhos de `securityHeaders()` (`vite.config.ts`), porque `frame-ancestors` e `X-Frame-Options` não funcionam pela meta: `Content-Security-Policy` (a mesma + `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=(), usb=()` e, em HTTPS, `Strict-Transport-Security: max-age=31536000; includeSubDomains`. O `npm run preview` já envia todos.
- Configure também o **rewrite da SPA**: qualquer rota (`/loja/*`, `/platform/*`, `/convite/*`, `/redefinir-senha/*`...) deve servir o `index.html`.
- Mercado Pago com CSP: a tokenização do cartão funciona; o script inline de perfil do dispositivo (antifraude) só roda se o servidor gerar um nonce por resposta (`'nonce-…'` no `script-src` e `<meta property="csp-nonce" nonce="…">`), que o front repassa ao SDK.
- O spec `e2e/tests/web/client/security-headers.spec.ts` confere a CSP contra o build (veja o [README do e2e](../e2e/README.md)).

---

# 📡 Integração com o Backend

O frontend conversa com a **API NestJS** pelo endereço de `VITE_API_URL` (`src/services/api.ts`). Imagens de produtos, logos e fotos de perfil também vêm da API (`assetUrl()`).

- A vitrine usa as rotas **por loja** (`/stores/<slug>`, `/stores/<slug>/products`, `/stores/<slug>/orders/quote`, `/stores/<slug>/payment/pix`...); o painel usa as rotas da equipe (a loja vem do usuário autenticado); o superpainel usa `/platform/**`.
- Com a API em sandbox (padrão em desenvolvimento), o formulário de cartão aceita o cartão de teste (`5031 4332 1540 6351`, validade `11/30`, CVV `123`, CPF `123.456.789-09`) e o PIX de teste é aprovado sozinho em alguns segundos. Detalhes no [README da raiz](../README.md#-pagamentos-em-sandbox).
- Se a API ficar fora do ar, as telas avisam e oferecem **Tentar novamente**.

---

# 🔐 Acesso por Perfil e sessão

Os e-mails e senhas das contas de demonstração estão no [README da raiz](../README.md#-contas-de-demonstração).

| Perfil | Onde entrar | Para onde vai | O que acessa |
|---|---|---|---|
| Superadministrador (`platform_role = SUPER_ADMIN`) | `/login` | `/platform` | Superpainel (não opera lojas nem compra; pode abrir sessão de suporte somente leitura) |
| Administrador (`ADMIN`) | `/login` | `/dashboard` | Dashboard, Pedidos, Clientes, Cardápio, Equipe, Lixeira, Configurações e Assinatura da própria loja |
| Atendente (`EMPLOYEE`) | `/login` | `/orders` | Quadro de pedidos completo e Clientes (leitura) |
| Cozinha (`KITCHEN`) | `/login` | `/orders` | Colunas **Novos** e **Preparando** |
| Entregador (`COURIER`) | `/login` | `/orders` | Entregas prontas e as próprias entregas |
| Cliente (`CLIENT`) | `/signin` | `/` (diretório) ou a página de onde veio | Vitrines das lojas, carrinho, **Meus Pedidos** e **Meus Dados** |

- Contas da equipe (e o superadministrador) que entram por `/signin` são levadas à própria área; um cliente que tenta `/login` volta para o início. Páginas fora do perfil redirecionam para a página inicial dele.
- **Sessão em cookie** (padrão, `VITE_AUTH_TRANSPORT=auto`): o login pede a sessão em cookie (cabeçalho `X-Auth-Transport: cookie`). O token de acesso (15 min) fica **só na memória da aba** e o refresh num cookie `HttpOnly` que nenhum script lê; o `localStorage` guarda só o marcador `comestra.session` (`{ v, sid, uid }`, sem segredo) e o usuário. Cada aba renova o próprio token (`POST /auth/web/refresh`) na subida, a 80% da validade, antes de uma chamada quando faltam menos de 30 s, ao voltar para a aba ou à rede e depois de um 401 (repetindo a chamada uma vez), com uma promessa única por aba e o Web Lock `comestra:refresh` entre abas. Uma renovação recusada sem chamada recusada é silenciosa na vitrine (a aba só fica sem login); no painel e no superpainel leva a `/login` ("Sua sessão expirou"). O modo **bearer** (token de 7 dias em `comestra.token`, como antes) continua para sessões antigas até expirarem, para a sessão de suporte, quando a API responde `session_transport: 'bearer'` (site e API em sites diferentes, LAN por IP, túneis) e com `VITE_AUTH_TRANSPORT=bearer`.
- **Sessão por aba**: cada aba usa o token da sessão que exibe, em memória, e acompanha o que acontece nas outras abas (login, saída, troca de conta, início ou fim de suporte): a aba remonta as telas, avisa ("A sessão mudou em outra aba…") e cancela as chamadas da sessão anterior. O usuário fica no `localStorage` (`comestra.user`, só com os campos permitidos) e é conferido em `GET /auth/me` ao abrir o site e ao voltar para a janela.
- **Sair** apaga a sessão, os carrinhos de todas as lojas e a última loja visitada; o tema fica. Em seguida, sem travar a saída, chama `POST /auth/logout` com o token que estava em uso (melhor esforço, até 5 s) e, no modo cookie, `POST /auth/web/logout` (apaga o cookie): a sessão deixa de valer no servidor. A expiração da sessão (401) não apaga o carrinho: no painel e no superpainel abre `/login`; na loja abre `/signin?redirect=<página atual>`.
- **Sessões ativas** (`components/Sidebar/ActiveSessions.tsx`, carregado sob demanda): em Meus Dados e no modal do menu lateral; lista paginada com o selo "Este navegador", "Encerrar" nas outras sessões, "Sair de todos os aparelhos" (com confirmação) e atualizar.
- **Sessão de suporte**: o token de suporte é sempre bearer. Iniciado numa sessão do superpainel em cookie, nada do superpainel fica guardado na aba: encerrar ou expirar o suporte volta ao superpainel pelo refresh do cookie, mesmo depois de recarregar. Iniciado numa sessão bearer antiga, o token do superpainel fica só na memória da aba que iniciou o suporte. "Encerrar e voltar ao superpainel" e "Sair do Sistema" encerram a sessão de suporte com o **próprio token de suporte**, na hora, mesmo depois de recarregar a página; sem o superpainel guardado na aba, "Encerrar e voltar" leva ao `/login`.
- Contas internas (equipe da loja e superadmin) veem o carrinho em "Modo Administrativo": sem formulário de cartão, sem o SDK do
  Mercado Pago, sem cotação nem consulta de endereços, e com PIX e pagamento na entrega desabilitados (a API também recusa pedidos
  dessas contas).
- Esqueceu a senha? `/esqueci-senha` envia um link de uso único (`/redefinir-senha/:token`) por e-mail quando a API usa SMTP (`MAIL_DRIVER=smtp`). Com o driver de log (padrão), o link vai para o log da API em desenvolvimento e, em produção, o superadministrador gera o link no superpainel (com SMTP, esse link vai só para o e-mail da conta: a tela mostra "enviado para …").
- **Links de conta**: `/verificar-email/:token` (confirmação, 48 h), `/confirmar-email/:token` (troca de e-mail, 24 h; ao confirmar, todas as sessões são encerradas) e `/desfazer-troca-de-email/:token` ("Não fui eu", 7 dias, com senha nova). As páginas conferem o link antes de mostrar o formulário.

---

# 🛣 Roadmap Web

- [x] Interface responsiva, carrinho e checkout
- [x] Painel da loja com perfis de acesso
- [x] Diretório, vitrine por slug e carrinho por loja
- [x] Superpainel da plataforma
- [x] CSP no build e sessão independente por aba
- [x] Sessões ativas e logout no servidor, número do pedido por loja e bloqueio de clientes
- [x] Tabelas responsivas no celular no painel e no superpainel
- [x] Sessão em cookie HttpOnly com token curto e renovação, e Segurança da conta (confirmação e troca de e-mail)
- [x] Frete por CEP no carrinho, cota de armazenamento e pedidos estornados no quadro

Próximas melhorias:

- [ ] Selo "Entrega só nos bairros atendidos" na vitrine e aviso de confirmação de e-mail no cadastro
- [ ] Integração com **WebSockets** para atualização automática do quadro
- [ ] Exportação de relatórios em **PDF / Excel**
