# 🍔 TorresBurgers | Full Stack Delivery System

---

# 📋 Sobre o Projeto

O **TorresBurgers** nasceu com o objetivo de criar uma solução que vai além do CRUD básico.

Ele resolve problemas reais de aplicações de delivery:

- **Escalabilidade de imagens**
- **Gestão de estados complexos (pedidos)**
- **Integrações financeiras seguras**
- **Logística de entregas**

O sistema é um **ecossistema completo**, composto por:

- **Painel Administrativo (Web)**  
  Gestão do restaurante e despacho de pedidos

- **App do Cliente (Mobile)**  
  Aplicação nativa para pedidos com foco em UX e performance

- **API Robusta (Backend)**  
  Servidor **NestJS** com arquitetura limpa e segura

---

# ✨ Funcionalidades

## 📱 App Mobile

### Sistema de Temas Dinâmico

- Suporte completo a **Dark Mode** e **Light Mode**
- Persistência da preferência do usuário via `AsyncStorage`

### Autenticação Persistente

- Login seguro com **JWT salvo via AsyncStorage**
- Usuário permanece logado mesmo após fechar o app

### Tratamento de Erros

- Feedback visual com **Alert nativo**
- Tratamento de falhas de conexão

### Interceptors Axios

- Injeção automática de **token nas requisições**
- Tratamento global de **timeout**

### Networking Avançado

- Suporte para **ambientes corporativos**
- **Tunneling inteligente** com Serveo

---

# 🛒 Web & Experiência do Cliente

### Catálogo Dinâmico

- Filtros por categoria
- Busca em tempo real

### Carrinho Inteligente

- Persistência de dados
- Cálculo automático de adicionais

### Marketing Contextual

- Banners ativados via **API de futebol**
- Promoções temáticas

---

# ⚙️ Painel Administrativo (Backoffice)

### Dashboard de Vendas

- Gráficos analíticos com **Recharts / Chart.js**

### Kanban de Pedidos

Fluxo visual:

```
Pendente → Preparo → Entrega → Concluído
```

### Logística de Entregas

- Atribuição de **motoboys**
- Visualização de **rotas de entrega**

---

# 🔧 Sistema & Backend

### Otimização de Mídia (Pipeline Sharp)

Conversão automática para **WebP**, reduzindo até **90% do tamanho das imagens** sem perda perceptível de qualidade.

### Pagamentos

- Integração **Sandbox**
- Suporte para **PIX**

### Segurança

- **JWT Authentication**
- **Bcrypt** para hash de senhas
- Validação com **class-validator**

---

# 🏗 Arquitetura e Performance

O projeto segue princípios de:

- **Clean Architecture**
- **SOLID**
- **Separação de Domínios**

---

# 📂 Estrutura do Projeto

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
```

---

# 📡 Mobile & Tunneling (Automação Remota)

Para rodar o app em **redes corporativas (Linux no trabalho)** ou **em casa (Windows)**, utilizamos um script de **automação de túnel**.

---

## Script Inteligente (`npm run tunnel`)

Criamos um script **start-tunnel.js** que:

1. Inicia o túnel SSH via **Serveo**
2. Captura a **URL dinâmica gerada**
3. Atualiza automaticamente o arquivo:

```
src/services/api.ts
```

com a nova **baseURL da API**.

---

## Como usar

```bash
# Na pasta frontend-mobile

npm run tunnel
```

---

# 🚀 Stack Tecnológica

| Camada | Tecnologias |
|------|-------------|
| **Backend** | NestJS, PostgreSQL, TypeORM, Sharp, JWT, Class Validator |
| **Frontend Web** | React (Vite), TailwindCSS v4, Axios, Lucide, Recharts |
| **Mobile** | React Native, Expo, NativeWind, AsyncStorage, Context API |
| **DevOps** | Docker, Git, Serveo Tunneling |

---

# 📦 Instalação e Execução

## 1️⃣ Backend

```bash
cd TorresBurgers/backend
npm install
npm run start:dev
```

---

## 2️⃣ Frontend Web

```bash
cd ../frontend-web
npm install
npm run dev
```

---

## 3️⃣ Mobile

```bash
cd ../frontend-mobile
npm install
npm run tunnel   # Configura a API automaticamente
npx expo start --tunnel    # Inicia o Expo
```

---

# 🔐 Variáveis de Ambiente

Crie um arquivo `.env` dentro de `/backend`.

```env
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=0000
DB_DATABASE=torresburgers

JWT_SECRET=sua_chave_secreta_aqui
```

---

# 🛣 Roadmap

- [x] CRUD Produtos e Usuários
- [x] Autenticação JWT Web & Mobile
- [x] Otimização de Imagens (WebP)
- [x] Script de Automação de Túnel SSH
- [x] Sistema de Temas (Dark/Light)

Próximas features:

- [ ] WebSockets para status do pedido em tempo real
- [ ] Push Notifications (Expo)

---

# 🤝 Contribuição

1. Faça um **Fork**
2. Crie sua branch

```bash
git checkout -b feature/incrivel
```

3. Faça o commit

```bash
git commit -m "feat: add incredible feature"
```

4. Envie o push

```bash
git push origin feature/incrivel
```

5. Abra um **Pull Request**