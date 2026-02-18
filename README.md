# 🍔 TorresBurgers

![Project Status](https://img.shields.io/badge/STATUS-EM_DESENVOLVIMENTO-orange?style=for-the-badge&logo=fire)
![License](https://img.shields.io/badge/LICENSE-MIT-green?style=for-the-badge)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![NestJS](https://img.shields.io/badge/NestJS-E0234E?style=for-the-badge&logo=nestjs&logoColor=white)

> Um ecossistema de delivery completo (Web, API e Mobile) desenvolvido com arquitetura de software profissional, focado em escalabilidade, segurança e experiência do usuário.

---

## 📋 Sobre o Projeto

O **TorresBurgers** não é apenas um app de delivery, é uma solução Full Stack robusta que simula um ambiente real de produção. O sistema integra pagamentos reais (modo Sandbox), marketing dinâmico baseado em eventos externos e gestão completa de pedidos.

### 🌟 Destaques & Diferenciais
* **Pagamentos Inteligentes:** Integração direta com **Mercado Pago** (Checkout Transparente). Suporte a **PIX** (QR Code dinâmico) e **Cartão de Crédito** com detecção automática de bandeira e tratamento de erros de Sandbox.
* **Marketing Dinâmico (Football API):** O sistema consome a **API-Football** para exibir banners promocionais automáticos ("Hoje tem jogo do Mengão!") baseados nos jogos do dia, utilizando **Cache (TTL)** para economizar requisições.
* **Arquitetura Limpa:** Separação clara de responsabilidades no Backend (Modules, Services, Controllers, Entities).
* **Segurança:** Autenticação via **JWT**, Hash de senhas com **Bcrypt** e validação rigorosa de dados (DTOs).
* **UX/UI Moderna:** Interface responsiva construída com **TailwindCSS v4**, toasts de notificação e feedbacks visuais em tempo real.

---

## 🚀 Tecnologias e Ferramentas

### 🧠 Backend (API Restful)
* **Core:** [NestJS](https://nestjs.com/) (Node.js framework)
* **Linguagem:** TypeScript
* **Banco de Dados:** PostgreSQL (via Docker ou Local)
* **ORM:** TypeORM
* **Pagamentos:** Mercado Pago SDK v2
* **HTTP & Cache:** Axios + Cache Manager (Integração com APIs externas)
* **Validação:** Class-Validator & Class-Transformer

### 💻 Frontend Web (Cliente & Admin)
* **Core:** React (Vite)
* **Estilização:** TailwindCSS v4 + Lucide React (Ícones)
* **Gerenciamento de Estado:** Context API (Auth & Cart)
* **Pagamentos:** Integração visual de Cartão de Crédito (`react-credit-cards-2`) e QR Code (`qrcode.react`)
* **Feedback:** React Hot Toast

### 📱 Mobile (App Cliente)
* **Framework:** React Native (Expo)
* **Linguagem:** TypeScript

---

## 🔌 Integrações Externas (APIs)

O projeto consome serviços externos para enriquecer a experiência:

| Serviço | Função no Projeto |
| :--- | :--- |
| **Mercado Pago** | Processamento de Pagamentos (Pix e Cartão). Inclui lógica de "Sandbox Magic" para aprovação automática em testes. |
| **API-Football** | (RapidAPI) Consulta jogos do dia para ativar promoções temáticas (ex: Promoção em dias de jogo do Flamengo). |
| **ViaCEP** | (Opcional/Planejado) Autocomplete de endereços no checkout. |

---

## 📂 Estrutura do Monorepo

```bash
TorresBurguers/
├── backend/            # API NestJS (Regras de Negócio, Integrações, DB)
│   ├── src/
│   │   ├── payment/    # Módulo de Pagamentos (MP SDK)
│   │   ├── promotions/ # Módulo de Promoções (Football API + Cache)
│   │   ├── orders/     # Gestão de Pedidos
│   │   └── ...
├── frontend-web/       # SPA React (Loja Virtual e Dashboard Admin)
├── frontend-mobile/    # App Expo (Cliente)
└── docs/               # Documentação (DER, Requisitos, UML)
🛠️ Como Rodar o Projeto
Pré-requisitos
Node.js (v18+)

PostgreSQL (Porta 5432)

Conta no Mercado Pago (Developers) e RapidAPI (Opcional)

1️⃣ Configurando o Backend
Bash
cd backend
npm install
Crie um arquivo .env na raiz do /backend:

Snippet de código
# Banco de Dados
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=sua_senha
DB_DATABASE=torresburgers

# JWT Secret
JWT_SECRET=sua_chave_secreta_super_segura

# Mercado Pago (Credenciais de Teste)
MP_ACCESS_TOKEN=TEST-seu-access-token-aqui

# API Football (RapidAPI) - Opcional para o banner funcionar
RAPIDAPI_KEY=sua-chave-rapidapi
RAPIDAPI_HOST=api-football-v1.p.rapidapi.com
Rodar o servidor:

Bash
npm run start:dev
# O servidor iniciará em http://localhost:3000
2️⃣ Rodando o Frontend Web
Bash
cd frontend-web
npm install
npm run dev
# Acesse em http://localhost:5173
3️⃣ Rodando o Mobile
Bash
cd frontend-mobile
npm install
npx expo start
# Leia o QR Code com o app Expo Go
💳 Funcionalidades de Pagamento (Sandbox)
Para testar o fluxo de pagamento sem gastar dinheiro real:

PIX: O sistema gera um QR Code real de teste. O status atualiza via polling (verificação automática).

Cartão de Crédito:

Use o cartão de teste fornecido na interface ou documentação do MP (inicia com 5031...).

O sistema preenche automaticamente o titular como "APRO" nos bastidores para garantir a aprovação imediata (Tela Verde ✅).

📚 Documentação Adicional
A documentação completa de engenharia encontra-se na pasta /docs, incluindo:

Levantamento de Requisitos e Regras de Negócio.

Diagrama Entidade-Relacionamento (DER).

Fluxograma de Pagamento.

👤 Autor
Felipe Torres (fp-torres)

Desenvolvedor Full Stack Sênior em formação 🚀

Foco: Clean Code, Arquitetura Escalável e UX.