<div align="center">

<img src="assets/icon.png" alt="Logo Comestra" width="100" />

# Comestra — App Mobile

**Cozinha, balcão e entrega no mesmo compasso.**

![React Native](https://img.shields.io/badge/React_Native-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![Expo](https://img.shields.io/badge/Expo-000020?style=for-the-badge&logo=expo&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![NativeWind](https://img.shields.io/badge/NativeWind-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white)

</div>

---

## 📖 Sobre

App nativo (React Native + Expo SDK 54) com duas faces:

- **Loja do cliente**: cardápio, carrinho, checkout (PIX, cartão ou pagamento na entrega), **Meus Pedidos** e **Minha Conta**;
- **Painel da equipe**: o mesmo app vira o painel de pedidos de acordo com o perfil de quem entra.

O nome exibido, o slug e as chaves do armazenamento vêm de `src/config/brand.ts` (`BRAND` e `STORAGE_KEYS`). Para trocar só o nome exibido, defina `EXPO_PUBLIC_APP_NAME`.

---

## 🔐 Acesso por perfil

A API cria **um usuário padrão para cada perfil** ao subir em desenvolvimento (`npm run seed`, na pasta `backend`, recria as contas e redefine as senhas). Os e-mails e senhas estão no [README da raiz, seção "Usuários padrão"](../README.md#-usuários-padrão-um-por-perfil).

| Perfil | Onde entrar no app | Para onde vai | O que acessa |
|---|---|---|---|
| Administrador (`ADMIN`) | Entrar → **Acesso de Funcionário** | Painel | Dashboard do dia, Pedidos (com abrir/fechar loja), Cardápio e Usuários |
| Atendente (`EMPLOYEE`) | Entrar → **Acesso de Funcionário** | Painel → Pedidos | Fluxo completo dos pedidos, atribuir entregador, cancelar e abrir/fechar a loja |
| Cozinha (`KITCHEN`) | Entrar → **Acesso de Funcionário** | Monitor da Cozinha | Colunas **Novos** e **Em preparo** |
| Entregador (`COURIER`) | Entrar → **Acesso de Funcionário** | Minhas Entregas | Pedidos prontos para entrega e as próprias entregas (GPS e ligação) |
| Cliente (`CLIENT`) | Entrar → **Entrar como Cliente** (ou pelo carrinho) | Loja | Cardápio, carrinho, checkout, Meus Pedidos e Minha Conta |

- **O perfil decide o destino**, inclusive quando o app é reaberto com a sessão salva.
- **Sair** remove só a sessão (o carrinho e o tema continuam). Se a API responder **401**, a sessão é encerrada e o app abre o login certo (cliente ou equipe) avisando que a sessão expirou.
- **Esqueci minha senha**: não há recuperação automática. Um administrador redefine a senha em **Painel → Usuários → editar** (campo "Nova senha"), ou o cliente escreve para o e-mail de suporte (`BRAND.supportEmail`).

---

## ✨ Funcionalidades

### 🛒 Loja
- Status da loja (`GET /store/status`, consultado a cada 60 s e ao voltar para o app): com a loja fechada, o app mostra **"Loja fechada"** com a mensagem de loja fechada definida na API (`closing_message`) e bloqueia carrinho e checkout
- Banner do dia (`GET /promotions/banner`): jogo de futebol ou sugestão do dia, com texto neutro (sem cupons nem descontos que o checkout não aplica)
- Preço promocional com a mesma regra do backend (vale só quando `0 < promocional < preço`); adicionais com quantidade (até 50 por item)
- Carrinho salvo no aparelho (`STORAGE_KEYS.cart`): continua depois de sair da conta ou fechar o app, permite mudar a quantidade de cada item e é esvaziado ao concluir o pedido
- Checkout com entrega (endereço com busca de CEP) ou retirada. O total vem do orçamento da API (`POST /orders/quote`). Pagamento pelo app (PIX, crédito ou débito via Mercado Pago) ou na entrega/retirada (dinheiro com troco ou maquininha)
- Meus Pedidos e detalhes do pedido com o endereço e os nomes gravados no pedido, status do pagamento (A pagar na entrega, Aguardando pagamento, Pago, Estornado, Estorno pendente) e cancelamento enquanto ele aguarda confirmação (`PENDING`). Pedido pago pelo app: o app avisa antes que o valor será estornado
- Imagens servidas pela API via `assetUrl()` (`src/services/api.ts`), com ícone quando não há foto

### 🧑‍🍳 Painel da equipe
- Quadro de pedidos por perfil, seguindo a tabela de transições da API (`PATCH /orders/:id` com `{ status }`). Atualiza a cada 5 s com `GET /orders?scope=active` (ativos + encerrados nas últimas 24 h), uma consulta por vez e descartando respostas atrasadas
- Administrador e Atendente veem também a coluna **Encerrados (24 h)**, com os estornos pendentes em destaque
- Atribuição de entregador (`PATCH /orders/:id/assign`), cancelamento (com estorno do pagamento feito pelo app), troco e forma de pagamento em português (inclusive códigos antigos como `DINHEIRO` e `CARTAO_*`)
- Cardápio: cadastro e edição rápidos (nome, descrição, preço e categoria), disponibilidade, lixeira e exclusão definitiva (com aviso quando o produto já tem pedidos). Foto, preço promocional e adicionais são definidos no painel web
- Usuários: cadastro e edição de qualquer perfil (inclusive Atendente) e redefinição de senha
- Botão voltar do Android fecha menus e janelas do painel

### 🌓 Temas
- Sistema, claro ou escuro, salvo no aparelho (`STORAGE_KEYS.themeMode`)
- Atualização de versões antigas: na primeira abertura o app apaga a sessão salva com as chaves `@TorresBurgers:*` (o cliente entra de novo) e leva o tema escolhido para a chave nova

---

## 🏗 Estrutura de Pastas

```
frontend-mobile/
├── assets/                 # Ícone, splash e favicon da marca
├── src/
│   ├── components/         # Footer, BrandWordmark, RemoteImage
│   ├── config/brand.ts     # Nome, slug, domínio, e-mail de suporte, chaves do AsyncStorage e dados da loja (STORE_INFO)
│   ├── contexts/           # Auth (sessão e 401), Cart, Store (status da loja), Theme
│   ├── routes/             # Pilha única: telas mudam conforme a sessão/perfil
│   ├── screens/            # Telas da loja, da conta e do painel (AdminDashboard)
│   ├── services/           # Axios (API_URL, assetUrl) e serviços
│   └── utils/              # Formatação, perfis, pedidos (status/pagamento/transições), catálogo
├── nativewind-env.d.ts     # Tipagem do className (NativeWind 2) para o RN 0.81
├── start-tunnel.js         # npm run tunnel (Serveo → EXPO_PUBLIC_API_URL no .env.local)
└── App.tsx                 # Providers + NavigationContainer
```

---

## 🚀 Como Executar

### Pré-requisitos
- [Node.js](https://nodejs.org/) 22+
- API rodando na porta **3000** (pasta `backend`: `npm run start:dev`)
- [Expo Go](https://expo.dev/go) (SDK 54) no celular **ou** emulador Android/iOS

### 1. Instale as dependências
```bash
npm install
```

### 2. Escolha como o app encontra a API

| Situação | Comando | Endereço usado |
|---|---|---|
| Celular no **mesmo Wi-Fi** do computador | `npm run start:lan` | Automático: IP do computador que roda o Expo, porta 3000 (ou `EXPO_PUBLIC_API_PORT`) |
| **Emulador Android** | `npm run android` | Automático (modo LAN). Se o Expo estiver em `localhost`/`127.0.0.1`, o app usa `10.0.2.2` |
| Celular Android **via USB** com `adb reverse tcp:3000 tcp:3000` | `npx expo start --localhost` | Defina `EXPO_PUBLIC_API_URL=http://127.0.0.1:3000` |
| Rede corporativa / 4G / fora da rede | `npm run tunnel` e, em outro terminal, `npx expo start --tunnel --clear` | URL pública do Serveo gravada em `.env.local` |

- O `npm run tunnel` **não altera o código**: grava `EXPO_PUBLIC_API_URL` no `.env.local` e, ao encerrar (Ctrl+C, fechando o terminal ou se o túnel cair), restaura o valor anterior (ou remove a variável). Uma URL de túnel deixada por uma sessão interrompida é avisada no início e nunca é restaurada. Com o celular na mesma rede do computador, `npx expo start --clear` basta no segundo terminal. O túnel usa o comando `ssh` (OpenSSH).
- O Expo Go precisa ser compatível com o SDK 54. Se a versão da loja de aplicativos já exigir um SDK mais novo, use o emulador Android (o Expo CLI instala o Expo Go compatível) ou baixe o Expo Go do SDK 54 em <https://expo.dev/go>.
- Sempre que mudar uma variável `EXPO_PUBLIC_*`, reinicie com `npx expo start --clear`.
- No Windows, libere a porta 3000 no firewall para o celular alcançar a API pela rede local.

### 3. Variáveis de ambiente (opcionais)

Copie `.env.example` para `.env.local`:

| Variável | Para quê |
|---|---|
| `EXPO_PUBLIC_API_URL` | Força o endereço da API (vazio = automático) |
| `EXPO_PUBLIC_API_PORT` | Porta da API no endereço automático (padrão 3000) |
| `EXPO_PUBLIC_APP_NAME` | Nome exibido no app |
| `EXPO_PUBLIC_MP_PUBLIC_KEY` | Chave pública do Mercado Pago (vazio = chave de teste/sandbox) |
| `EXPO_PUBLIC_STORE_TIME_ZONE` | Fuso da loja usado no "hoje" dos indicadores do painel (vazio = `America/Sao_Paulo`, como o `STORE_TIME_ZONE` da API) |
| `EXPO_PUBLIC_STORE_ADDRESS_LINE`, `EXPO_PUBLIC_STORE_CITY_LINE` | Endereço da loja no rodapé (vazio = demonstração, `STORE_INFO` em `src/config/brand.ts`) |
| `EXPO_PUBLIC_INSTAGRAM_URL`, `EXPO_PUBLIC_FACEBOOK_URL`, `EXPO_PUBLIC_X_URL` | Redes sociais no rodapé (só aparecem as preenchidas) |

### 4. Verificações
```bash
npx tsc --noEmit                                  # tipos (deve terminar sem erros)
npx expo export --platform android --output-dir dist   # gera o bundle de produção
```

---

## 🛠 Stack Tecnológica

| Tecnologia | Finalidade |
|---|---|
| **React Native 0.81 / Expo SDK 54** | Base do app e ferramentas |
| **TypeScript** | Tipagem estática |
| **NativeWind 2** | Estilização com classes Tailwind |
| **React Navigation 7** | Pilha de telas (fluxo de autenticação por perfil) |
| **Axios** | Consumo da API REST |
| **AsyncStorage** | Sessão, carrinho e tema no aparelho |
| **Mercado Pago (API REST)** | Tokenização do cartão no aparelho com a chave pública (o número do cartão não passa pela API do Comestra) |

---

## 🛣 Roadmap

**Já implementado**
- [x] Loja, carrinho, checkout e acompanhamento de pedidos
- [x] Painel por perfil (Administrador, Atendente, Cozinha e Entregador)
- [x] Status da loja e banner do dia vindos da API
- [x] Suporte a Dark / Light Mode

**Próximos passos**
- [ ] Push Notifications para status do pedido
- [ ] Upload de foto de produto e de perfil pelo app
- [ ] Mapa com rastreio da entrega
