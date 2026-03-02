# 🍔 TorresBurgers | Full Stack Delivery System

<div align="center">
  <h1>TorresBurgers</h1>

  <br />

  [![Status](https://img.shields.io/badge/STATUS-EM_DESENVOLVIMENTO-orange?style=for-the-badge&logo=fire)](https://github.com/fp-torres)
  [![License](https://img.shields.io/badge/LICENSE-MIT-green?style=for-the-badge)](LICENSE)
  [![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
  [![NestJS](https://img.shields.io/badge/NestJS-E0234E?style=for-the-badge&logo=nestjs&logoColor=white)](https://nestjs.com/)
  [![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)](https://reactjs.org/)
  [![React Native](https://img.shields.io/badge/React_Native-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)](https://reactnative.dev/)
  [![Expo](https://img.shields.io/badge/Expo-000020?style=for-the-badge&logo=expo&logoColor=white)](https://expo.dev/)
  [![TailwindCSS](https://img.shields.io/badge/Tailwind_v4-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white)](https://tailwindcss.com/)
</div>

<p align="center">
  <strong>Uma plataforma de delivery completa (Web & Mobile), simulando um ambiente de produção real com pagamentos, otimização de performance e logística avançada.</strong>
</p>

<p align="center">
  <a href="#-sobre-o-projeto">Sobre</a> •
  <a href="#-funcionalidades">Funcionalidades</a> •
  <a href="#-arquitetura-e-performance">Arquitetura</a> •
  <a href="#-stack-tecnológica">Stack</a> •
  <a href="#-instalação-e-execução">Instalação</a> •
  <a href="#-mobile--tunneling">Mobile & Redes</a> •
  <a href="#-roadmap">Roadmap</a>
</p>

---

## 📋 Sobre o Projeto

O **TorresBurgers** nasceu com o objetivo de criar uma solução que vai além do CRUD básico. Ele resolve problemas reais de aplicações de delivery: **escalabilidade de imagens**, **gestão de estados complexos (pedidos)**, **integrações financeiras seguras** e **logística de entregas**.

O sistema é um ecossistema completo composto por:
1.  **Painel Administrativo (Web):** Para gestão do restaurante e despacho de pedidos.
2.  **App do Cliente (Mobile):** Aplicação nativa para pedidos, focada em UX e performance.
3.  **API Robusta (Backend):** Servidor NestJS com arquitetura limpa e segura.

---

## ✨ Funcionalidades

### 📱 App Mobile (Novo!)
- **Autenticação Persistente:** Login seguro com JWT salvo via `AsyncStorage`. O usuário permanece logado mesmo fechando o app.
- **Tratamento de Erros:** Feedbacks visuais nativos (Alerts) para falhas de conexão ou login inválido.
- **Interceptors Axios:** Injeção automática de tokens em todas as requisições e tratamento global de Timeouts.
- **Networking Avançado:** Configurado para rodar em ambientes corporativos e Linux via Tunneling (Serveo/Cloudflare).

### 🛒 Web & Experiência do Cliente
- **Catálogo Dinâmico:** Filtros por categoria (Combos, Smashs, Bebidas) e busca em tempo real.
- **Carrinho Inteligente:** Persistência de dados e cálculo automático de adicionais.
- **Marketing Contextual:** Banners de promoção ativados via **API de Futebol** (ex: dias de jogos importantes).

### ⚙️ Painel Administrativo (Backoffice)
- **Dashboard de Vendas:** Gráficos de receita e pedidos (Chart.js/Recharts).
- **Kanban de Pedidos:** Fluxo visual de status (Pendente ➝ Preparo ➝ Entrega ➝ Concluído).
- **Logística de Entregas:** Atribuição inteligente de motoboys e visualização de rotas.

### 🔧 Sistema & Backend
- **Otimização de Mídia (Pipeline Sharp):**
  - Uploads interceptados em memória e convertidos para **WebP**.
  - **Resultado:** Redução de até 90% no tamanho dos arquivos.
- **Pagamentos (Sandbox):** Checkout transparente e integração com PIX.
- **Segurança:** Autenticação via JWT, Hash de senhas com Bcrypt e validação rígida de DTOs (Data Transfer Objects).

---

## 🏗 Arquitetura e Performance

O projeto segue os princípios de **Clean Architecture** e **SOLID** no Backend NestJS.

### Estrutura de Pastas (Monorepo-style)
```bash
TorresBurgers/
├── backend/               # API (NestJS + TypeORM + Postgres)
│   ├── src/auth/          # Autenticação e Guards (JWT)
│   ├── src/modules/       # Domínios (Products, Orders, Users)
│   └── uploads/           # Armazenamento estático otimizado
├── frontend-web/          # React Vite (Single Page Application)
│   ├── src/contexts/      # Gerenciamento de Estado Global
│   └── src/components/    # UI Kit (Botões, Modais, Inputs)
└── frontend-mobile/       # React Native (Expo SDK 52)
    ├── src/services/      # Configuração de API e Tunneling
    ├── src/screens/       # Telas (SignIn, Home, Cart)
    └── src/contexts/      # AuthContext com AsyncStorage

    Camada,Tecnologias
Backend,"NestJS, PostgreSQL, TypeORM, Sharp (Imagem), Class-Validator, JWT"
Frontend Web,"React (Vite), TailwindCSS v4, Lucide React, Recharts, Axios"
Mobile,"React Native, Expo, NativeWind (Tailwind), AsyncStorage"
DevOps / Infra,"Docker (Banco), Serveo (Tunneling), Git"

📦 Instalação e Execução
Pré-requisitos: Node.js v18+, PostgreSQL.

1. Backend (API)
Bash
# Clone o repositório e acesse a pasta
cd TorresBurgers/backend

# Instale as dependências e rode o servidor
npm install
npm run start:dev
2. Frontend (Web)
Bash
cd ../frontend-web
npm install
npm run dev
3. Mobile (App)
Bash
cd ../frontend-mobile
npx expo install
npx expo start -c
📡 Mobile & Tunneling (Ambiente Linux/Corporativo)
Para rodar o aplicativo móvel em redes corporativas ou com firewall restrito (onde o IP local não é acessível), o projeto utiliza uma estratégia de Tunneling SSH.

Inicie o Backend normalmente na porta 3000.

Abra um túnel (em um novo terminal):

Bash
ssh -R 80:127.0.0.1:3000 serveo.net
Configure a API: Copie a URL gerada (ex: https://torres.serveo.net) para o arquivo src/services/api.ts no mobile.

Rode o Expo: npx expo start -c --tunnel

Essa configuração garante que o App consiga se comunicar com o Backend (localhost) independente de restrições de rede Wi-Fi.

🔐 Variáveis de Ambiente
Crie um arquivo .env na raiz do /backend:

Snippet de código
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=admin
DB_DATABASE=torresburgers
JWT_SECRET=sua_chave_secreta_aqui
🛣 Roadmap
[x] CRUD Produtos e Usuários

[x] Autenticação JWT Web & Mobile

[x] Otimização de Imagens (Backend)

[x] App Mobile: Login e Persistência de Sessão

[x] Configuração de Tunneling para Desenvolvimento Remoto

[ ] Websockets para status do pedido em tempo real

[ ] Push Notifications no Mobile (Expo Notifications)

[ ] Integração com ViaCEP para endereço

🤝 Contribuição
Contribuições são bem-vindas!

Faça um Fork do projeto

Crie uma Branch para sua Feature (git checkout -b feature/Incrível)

Faça o Commit (git commit -m 'Add some Incrível')

Push para a Branch (git push origin feature/Incrível)

Abra um Pull Request

<p align="center">
Desenvolvido por <strong>Felipe Torres</strong> 🚀