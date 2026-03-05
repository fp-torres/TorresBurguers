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

# 📋 Sobre o Projeto

O **TorresBurgers** nasceu com o objetivo de criar uma solução que vai além do CRUD básico. Ele resolve problemas reais de aplicações de delivery: **escalabilidade de imagens**, **gestão de estados complexos (pedidos)**, **integrações financeiras seguras** e **logística de entregas**.

O sistema é um ecossistema completo composto por:

1. **Painel Administrativo (Web):** Gestão do restaurante e despacho de pedidos  
2. **App do Cliente (Mobile):** Aplicação nativa para pedidos com foco em UX e performance  
3. **API Robusta (Backend):** Servidor NestJS com arquitetura limpa e segura  

---

# ✨ Funcionalidades

## 📱 App Mobile

- **Autenticação Persistente**
  - Login seguro com JWT salvo via `AsyncStorage`
  - Usuário permanece logado mesmo após fechar o app

- **Tratamento de Erros**
  - Feedback visual com `Alert` nativo
  - Tratamento de falhas de conexão

- **Interceptors Axios**
  - Injeção automática de token nas requisições
  - Tratamento global de timeout

- **Networking Avançado**
  - Suporte para ambientes corporativos
  - Tunneling com Serveo/Cloudflare

---

## 🛒 Web & Experiência do Cliente

- **Catálogo Dinâmico**
  - Filtros por categoria
  - Busca em tempo real

- **Carrinho Inteligente**
  - Persistência de dados
  - Cálculo automático de adicionais

- **Marketing Contextual**
  - Banners ativados via API de futebol
  - Promoções em dias de jogos importantes

---

## ⚙️ Painel Administrativo (Backoffice)

- **Dashboard de Vendas**
  - Gráficos com Recharts / Chart.js

- **Kanban de Pedidos**
  - Fluxo visual:
  

Pendente → Preparo → Entrega → Concluído


- **Logística de Entregas**
  - Atribuição de motoboys
  - Visualização de rotas

---

## 🔧 Sistema & Backend

### Otimização de Mídia

Pipeline com **Sharp**

- Upload interceptado em memória
- Conversão automática para **WebP**
- Redução de até **90% do tamanho das imagens**

### Pagamentos

- Integração Sandbox
- Suporte para **PIX**

### Segurança

- JWT Authentication
- Bcrypt para hash de senhas
- Validação com `class-validator`

---

# 🏗 Arquitetura e Performance

O projeto segue princípios de:

- **Clean Architecture**
- **SOLID**
- **Separação de Domínios**

Backend desenvolvido com **NestJS**.

## Estrutura do Projeto

```bash
TorresBurgers/
├── backend/                # API (NestJS + TypeORM + PostgreSQL)
│   ├── src/auth/
│   ├── src/modules/
│   └── uploads/
│
├── frontend-web/           # React + Vite
│   ├── src/contexts/
│   └── src/components/
│
└── frontend-mobile/        # React Native + Expo
    ├── src/services/
    ├── src/screens/
    └── src/contexts/
🚀 Stack Tecnológica
Camada	Tecnologias
Backend	NestJS, PostgreSQL, TypeORM, Sharp, JWT, Class Validator
Frontend Web	React (Vite), TailwindCSS v4, Axios, Lucide, Recharts
Mobile	React Native, Expo, NativeWind, AsyncStorage
DevOps	Docker, Git, Serveo Tunneling
📦 Instalação e Execução
Pré-requisitos

Node.js 18+

PostgreSQL

1️⃣ Backend
cd TorresBurgers/backend

npm install
npm run start:dev
2️⃣ Frontend Web
cd ../frontend-web

npm install
npm run dev
3️⃣ Mobile
cd ../frontend-mobile

npx expo install
npx expo start -c
📡 Mobile & Tunneling

Para rodar o app em redes corporativas ou Linux com firewall, use túnel SSH.

Inicie o backend
npm run start:dev
Crie o túnel
ssh -R 80:127.0.0.1:3000 serveo.net
Configure a API no mobile

Edite:

src/services/api.ts

Exemplo:

baseURL: "https://torres.serveo.net"
Rode o Expo
npx expo start -c --tunnel
🔐 Variáveis de Ambiente

Crie .env dentro de /backend.

DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=admin
DB_DATABASE=torresburgers

JWT_SECRET=sua_chave_secreta_aqui
🛣 Roadmap
[x] CRUD Produtos e Usuários
[x] Autenticação JWT Web & Mobile
[x] Otimização de Imagens
[x] App Mobile com Persistência
[x] Tunneling para desenvolvimento remoto

[ ] WebSockets para status do pedido
[ ] Push Notifications (Expo)
[ ] Integração ViaCEP
🤝 Contribuição

Faça um Fork

Crie sua branch

git checkout -b feature/incrivel

Faça commit

git commit -m "feat: add incredible feature"

Push

git push origin feature/incrivel

Abra um Pull Request

<p align="center">

Desenvolvido por Felipe Torres 🚀

Foco: Clean Code • Performance • Mobile First • Arquitetura Escalável

</p> ```