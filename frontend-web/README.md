# 💻 Comestra | Frontend Web & Backoffice

> **Cozinha, balcão e entrega no mesmo compasso.**

Este diretório contém a **interface web do Comestra**: a loja online do restaurante e o painel da equipe, no mesmo aplicativo React.

Desenvolvido com foco em **alta performance** e **design responsivo**, o sistema é dividido em duas grandes frentes:

- **Experiência do Cliente (Menu Digital)**: cardápio, carrinho, checkout, Meus Pedidos e Meus Dados
- **Painel da Equipe (Gestão de Pedidos e Logística)**: Dashboard, quadro de pedidos, cardápio, equipe e lixeira

O nome exibido (logo, título da aba e rodapé) vem de `src/config/brand.ts` e pode ser trocado por instalação com `VITE_APP_NAME`.

---

# 🚀 Tecnologias Utilizadas

- **React 19 + Vite 7**: build rápido e desenvolvimento otimizado.
- **TailwindCSS v4**: estilização utilitária com tema claro/escuro.
- **React Router 7**: rotas da loja e do painel, protegidas por perfil.
- **Axios**: cliente HTTP com interceptors (token JWT e sessão expirada).
- **Lucide React / Iconify**: ícones.
- **Recharts**: gráficos de vendas no Dashboard.
- **Context API**: sessão (Auth), carrinho (Cart), tema (Theme) e status da loja (StoreStatus).
- **Mercado Pago (SDK JS v2)**: tokenização do cartão no navegador.

---

# ✨ Funcionalidades Principais

## 🛒 Menu Digital (Cliente)

- **Catálogo dinâmico** consumido da API, com busca em todo o cardápio (nome e descrição, sem diferenciar acentos) e filtros por categoria.
- **Preço promocional**: quando o produto tem promoção, o preço cheio aparece riscado e o carrinho usa o mesmo valor que a API cobra.
- **Personalização**: ponto da carne (só hambúrgueres), retirada de ingredientes, adicionais com quantidade e observação.
- **Carrinho persistente** no navegador (`STORAGE_KEYS.cart`): sobrevive ao recarregar a página e ao sair da conta.
- **Loja aberta/fechada**: a vitrine consulta `GET /store/status` a cada 30 s e ao voltar para a aba. Com a loja fechada, o selo do cabeçalho mostra "Fechado" e o banner exibe "Estamos fechados agora" com a mensagem de loja fechada definida na API (`closing_message`). Nesse estado, não é possível adicionar itens nem finalizar pedidos.
- **Banner do dia** vindo de `GET /promotions/banner`: jogo do dia (quando a API de futebol está configurada) ou a promoção do dia da semana. O banner é informativo: os descontos citados ainda não são aplicados no checkout.
- **Checkout**: retirada ou entrega (endereço com busca de CEP), com o total calculado pela API (`POST /orders/quote`). O pagamento pode ser online, por cartão ou PIX (QR Code e copia e cola) via Mercado Pago, com o pedido registrado só após a aprovação. Também pode ser feito na entrega/retirada, em dinheiro com troco ou crédito/débito na maquininha.
- **Meus Pedidos** com status (atualizado a cada 10 s), forma de pagamento e cancelamento enquanto o pedido aguarda confirmação.
- **Meus Dados**: nome, e-mail, telefone, foto (envio de imagem ou avatar pronto), troca de senha e exclusão da conta.

## ⚙️ Painel da Equipe

- **Dashboard** (Administrador): faturamento (pedidos pagos e não cancelados), ticket médio, fila de produção, gráficos dos últimos 7 dias e botão para abrir/fechar a loja.
- **Quadro de Pedidos**: colunas por etapa (atualizadas a cada 5 s), ações conforme o perfil, despacho para entregadores com sugestão de pedidos do mesmo bairro e interruptor da loja (Administrador e Atendente).
- **Cardápio** (Administrador): cadastro e edição de produtos com foto, preço promocional, ingredientes e adicionais; pausa de produtos esgotados e lixeira.
- **Equipe** (Administrador): cadastro de membros por perfil com a mesma política de senha da API.
- **Lixeira** (Administrador): restaura ou exclui definitivamente produtos e usuários (itens que aparecem em pedidos são preservados).

---

# 🏗 Estrutura de Pastas

```bash
frontend-web/
├── public/              # favicon.svg (marca do produto)
├── src/
│   ├── components/      # Componentes reutilizáveis (BrandLogo, modais, Sidebar, StoreToggle...)
│   ├── config/          # brand.ts: nome, slogan, e-mail de suporte, chaves do localStorage e dados da loja
│   ├── contexts/        # Estado global (Auth, Cart, Theme, StoreStatus)
│   ├── layouts/         # Layout da loja (ClientLayout) e do painel (DefaultLayout)
│   ├── pages/           # Telas da loja (pages/Client) e do painel
│   ├── routes/          # Rotas e guardas por perfil (inclui a página 404)
│   ├── services/        # Axios (api.ts), serviços por recurso e carregamento do Mercado Pago
│   └── utils/           # Máscaras, formatação pt-BR, perfis, pedidos e regras de catálogo
├── .env.example         # Modelo das variáveis de ambiente
└── tailwind.config.js   # Configurações do Tailwind
```

---

# 📦 Instalação e Execução

Pré-requisitos: **Node.js 22+** e a API rodando (pasta `backend`, `npm run start:dev`). O passo a passo completo, com banco de dados e app, está no [README da raiz](../README.md#-como-rodar).

## 1️⃣ Acesse a pasta do projeto

```bash
cd frontend-web
```

## 2️⃣ Instale as dependências

```bash
npm install
```

## 3️⃣ Configure o ambiente

Copie o modelo e ajuste o que precisar:

```bash
cp .env.example .env
```

| Variável | Obrigatória | Padrão | Para que serve |
|---|---|---|---|
| `VITE_API_URL` | não | `http://localhost:3000` | Endereço da API (backend NestJS), sem barra no final. Use o IP da máquina do backend para acessar de outro aparelho da rede, ou a URL do túnel. |
| `VITE_APP_NAME` | não | `Comestra` | Nome exibido no site (logo, título da aba, rodapé). |
| `VITE_MP_PUBLIC_KEY` | não | chave de **teste** do Mercado Pago | Chave **pública** usada para tokenizar o cartão. O Access Token é secreto e fica só no backend (`MP_ACCESS_TOKEN`). |

> As variáveis `VITE_*` entram no JavaScript público do site: nunca coloque segredos nelas. Depois de alterar o `.env`, reinicie o `npm run dev`.

## 4️⃣ Inicie o servidor de desenvolvimento

```bash
npm run dev
```

O site abre em `http://localhost:5173` (loja), `http://localhost:5173/signin` (login do cliente) e `http://localhost:5173/login` (equipe).

## 5️⃣ Outros comandos

```bash
npm run build     # verificação de tipos + build de produção em dist/
npm run preview   # serve o build de produção localmente
npm run lint      # ESLint
```

---

# 📡 Integração com o Backend

O frontend web conversa com a **API NestJS** pelo endereço de `VITE_API_URL` (`src/services/api.ts`). Imagens de produtos e fotos de perfil também vêm da API (`assetUrl()`), então nada fica preso a `localhost`.

Com o backend rodando funcionam: autenticação, cardápio, pedidos, pagamentos (Mercado Pago em modo sandbox por padrão) e a gestão do painel. Se a API ficar fora do ar, as telas avisam, e o cardápio oferece o botão **Tentar novamente**.

Com a chave pública de teste (o padrão), o formulário de cartão mostra o cartão de teste (`5031 4332 1540 6351`, validade `11/30`, CVV `123`, CPF `123.456.789-09`). Com a API em sandbox, o PIX de teste é aprovado sozinho em alguns segundos. Detalhes no [README da raiz](../README.md#-pagamentos-em-sandbox).

### 💡 Dica

Para testar junto com o **app mobile** em outro aparelho, use no `.env` o mesmo endereço que o app usa para a API (IP da rede ou túnel):

```env
VITE_API_URL=https://seu-tunel.serveo.net
```

Isso mantém **consistência de dados entre Web e Mobile**.

---

# 🔐 Acesso por Perfil

O backend cria **um usuário padrão para cada perfil** ao subir em desenvolvimento (`npm run seed`, na pasta `backend`, recria as contas e redefine as senhas). Os e-mails e senhas estão no [README da raiz, seção "Usuários padrão"](../README.md#-usuários-padrão-um-por-perfil).

| Perfil | Onde entrar | Para onde vai | O que acessa |
|---|---|---|---|
| Administrador (`ADMIN`) | `/login` | `/dashboard` | Dashboard, Pedidos, Cardápio, Equipe e Lixeira |
| Atendente (`EMPLOYEE`) | `/login` | `/orders` | Quadro de pedidos completo: aceitar, preparar, despachar, finalizar e cancelar |
| Cozinha (`KITCHEN`) | `/login` | `/orders` | Colunas **Novos** e **Preparando** |
| Entregador (`COURIER`) | `/login` | `/orders` | Pedidos prontos para entrega e as próprias entregas |
| Cliente (`CLIENT`) | `/signin` | `/` (cardápio) | Loja, carrinho, **Meus Pedidos** e **Meus Dados** |

- Contas da equipe que entram por `/signin` são levadas ao próprio painel; um cliente que tenta `/login` volta para a loja.
- Páginas fora do perfil redirecionam para a página inicial dele (ex.: Cozinha em `/dashboard` → `/orders`).
- A sessão fica no `localStorage` (chaves `STORAGE_KEYS.token` e `STORAGE_KEYS.user`, definidas em `src/config/brand.ts`). Sair remove só a sessão (carrinho e tema continuam salvos) e, se a API responder 401, a sessão é encerrada e o login é aberto de novo.
- Para trocar de perfil, use **Sair do Sistema** (painel) ou **Sair da Conta** (loja) e entre com outro usuário.
- Abrir/fechar a loja: **Administrador** (Dashboard ou Pedidos) e **Atendente** (Pedidos).
- Esqueceu a senha? Não há recuperação automática: um Administrador define uma nova senha na tela **Equipe**.

---

# 🛣 Roadmap Web

- [x] Interface Responsiva (Mobile First)

- [x] Fluxo de Carrinho e Checkout

- [x] Painel Administrativo Base

- [x] Perfis de acesso (Administrador, Atendente, Cozinha, Entregador e Cliente)

Próximas melhorias:

- [ ] Integração com **WebSockets** para atualização automática do Kanban

- [ ] Relatórios avançados para exportação em **PDF / Excel**
