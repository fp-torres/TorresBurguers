# 🍔 TorresBurgers

> Um sistema de e-commerce completo (Web e Mobile) para hamburgueria, desenvolvido com foco em escalabilidade, código limpo e arquitetura de software profissional.

## 📋 Sobre o Projeto
O **TorresBurgers** é uma solução Full Stack que integra:
1.  **API Centralizada:** Um único backend servindo dados para Web e App.
2.  **Painel Administrativo:** Para gestão de produtos, pedidos e entregadores.
3.  **App do Cliente:** Para realização de pedidos, pagamentos e rastreamento em tempo real.

O projeto segue padrões de mercado (Sênior), utilizando TypeScript em todo o ecossistema para garantir tipagem forte e segurança.

---

## 🚀 Tecnologias Utilizadas

### 🧠 Backend (API)
* **Framework:** [NestJS](https://nestjs.com/) (Node.js)
* **Linguagem:** TypeScript
* **Banco de Dados:** PostgreSQL
* **ORM:** TypeORM
* **Autenticação:** JWT & Bcrypt
* **Validação:** Class-Validator

### 💻 Frontend Web (Admin & Cliente)
* **Framework:** React
* **Build Tool:** Vite
* **Estilização:** TailwindCSS (v4)
* **Linguagem:** TypeScript
* **Http Client:** Axios

### 📱 Mobile (App Cliente)
* **Framework:** React Native
* **Plataforma:** Expo
* **Linguagem:** TypeScript

---

## 📂 Estrutura de Pastas

O projeto está organizado como um **Monorepo** lógico:

```bash
TorresBurguers/
├── backend/          # API RESTful (NestJS)
├── frontend-web/     # Aplicação Web (React + Vite)
├── frontend-mobile/  # Aplicação Mobile (Expo)
└── docs/             # Documentação de Engenharia (Requisitos, UML, DER)

🛠️ Como Rodar o Projeto Localmente
Pré-requisitos
Node.js (v18 ou superior)

PostgreSQL rodando localmente (Porta 5432)

1️⃣ Configurando o Backend

cd backend
npm install

# Crie um arquivo .env na raiz de /backend com as configs do banco
# Exemplo: DATABASE_URL=postgres://postgres:senha@localhost:5432/torresburgers

# Rodar o servidor em modo de desenvolvimento
npm run start:dev

O servidor iniciará em http://localhost:3000

2️⃣ Rodando o Frontend Web

cd frontend-web
npm install
npm run dev

Acesse em http://localhost:5173

3️⃣ Rodando o Mobile

cd frontend-mobile
npm install
npx expo start

Leia o QR Code com o app Expo Go (iOS/Android)

📚 Documentação
A documentação completa de engenharia encontra-se na pasta /docs, incluindo:

Levantamento de Requisitos

Casos de Uso

Diagrama Entidade-Relacionamento (DER)

Arquitetura do Sistema

👤 Autor
Desenvolvido por fp-torres
