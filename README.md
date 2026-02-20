# 🍔 TorresBurgers | Full Stack Delivery System

<div align="center">
  <img src="https://via.placeholder.com/1200x300.png?text=TorresBurgers+Banner" alt="TorresBurgers Banner" />

  <br />

  [![Status](https://img.shields.io/badge/STATUS-EM_DESENVOLVIMENTO-orange?style=for-the-badge&logo=fire)](https://github.com/fp-torres)
  [![License](https://img.shields.io/badge/LICENSE-MIT-green?style=for-the-badge)](LICENSE)
  [![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
  [![NestJS](https://img.shields.io/badge/NestJS-E0234E?style=for-the-badge&logo=nestjs&logoColor=white)](https://nestjs.com/)
  [![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)](https://reactjs.org/)
  [![TailwindCSS](https://img.shields.io/badge/Tailwind_v4-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white)](https://tailwindcss.com/)
</div>

<p align="center">
  <strong>Uma plataforma de delivery completa, simulando um ambiente de produção real com pagamentos, otimização de performance e marketing dinâmico.</strong>
</p>

<p align="center">
  <a href="#-sobre-o-projeto">Sobre</a> •
  <a href="#-funcionalidades">Funcionalidades</a> •
  <a href="#-arquitetura-e-performance">Arquitetura</a> •
  <a href="#-stack-tecnológica">Stack</a> •
  <a href="#-instalação-e-execução">Instalação</a> •
  <a href="#-variáveis-de-ambiente">Env Vars</a> •
  <a href="#-roadmap">Roadmap</a>
</p>

---

## 📋 Sobre o Projeto

O **TorresBurgers** nasceu com o objetivo de criar uma solução que vai além do CRUD básico. Ele resolve problemas reais de aplicações de delivery: **escalabilidade de imagens**, **gestão de estados complexos (pedidos)** e **integrações financeiras seguras**.

O sistema conta com um **Painel Administrativo** para gestão do restaurante, uma **Loja Web** para os clientes e um **App Mobile** para pedidos on-the-go.

---

## 📸 Screenshots

| **Área do Cliente (Dark Mode)** | **Painel Administrativo** |
|:---:|:---:|
| <img src="https://via.placeholder.com/400x250?text=Home+Dark+Mode" width="400" /> | <img src="https://via.placeholder.com/400x250?text=Dashboard+Admin" width="400" /> |
| *Layout responsivo e imersivo* | *KPIs e Gestão de Pedidos* |

| **Checkout & Pagamento** | **Mobile App** |
|:---:|:---:|
| <img src="https://via.placeholder.com/400x250?text=Checkout+Pix" width="400" /> | <img src="https://via.placeholder.com/400x250?text=Mobile+App" width="400" /> |
| *Integração real com Mercado Pago* | *Experiência nativa com Expo* |

---

## ✨ Funcionalidades

### 🛒 Experiência do Cliente (Web & Mobile)
- **Catálogo Dinâmico:** Filtros por categoria (Combos, Smashs, Bebidas) e busca em tempo real.
- **Carrinho Inteligente:** Persistência de dados e cálculo automático de adicionais.
- **Dark Mode Automático:** Detecção de preferência do sistema ou troca manual.
- **Marketing Contextual:** Banners de promoção ativados via **API de Futebol** (ex: dias de jogos importantes).

### ⚙️ Painel Administrativo (Backoffice)
- **Dashboard de Vendas:** Gráficos de receita e pedidos (Chart.js/Recharts).
- **Gestão de Cardápio:** Criação de produtos com uploads otimizados e controle de estoque.
- **Kanban de Pedidos:** Fluxo visual de status (Pendente ➝ Preparo ➝ Entrega ➝ Concluído).
- **Gestão de Time:** Controle de permissões (Admin, Cozinha, Motoboy).

### 🔧 Sistema & Backend
- **Otimização de Mídia (Pipeline Sharp):**
  - Uploads são interceptados em memória.
  - Redimensionamento automático (Max-width: 800px).
  - Conversão para **WebP** e compressão (80% quality).
  - **Resultado:** Imagens de 5MB tornam-se arquivos de ~50KB.
- **Pagamentos (Sandbox):**
  - Checkout transparente (Cartão de Crédito).
  - PIX com geração de QR Code e Copy&Paste.
  - Webhooks para atualização de status (simulado).

---

## 🏗 Arquitetura e Performance

O projeto segue os princípios de **Clean Architecture** e **SOLID** no Backend NestJS.

### Estrutura de Pastas (Monorepo-style)
```bash
TorresBurgers/
├── backend/               # API (NestJS + TypeORM + Postgres)
│   ├── src/common/        # Pipes, Guards e Interceptors globais
│   ├── src/modules/       # Módulos de Domínio (Products, Orders, Users)
│   └── uploads/           # Armazenamento estático otimizado
├── frontend-web/          # React Vite (Single Page Application)
│   ├── src/contexts/      # Gerenciamento de Estado Global
│   └── src/components/    # UI Kit (Botões, Modais, Inputs)
└── frontend-mobile/       # React Native (Expo)
Fluxo de Otimização de ImagemCliente envia imagem (JPG/PNG).OptimizeImagePipe intercepta o buffer.Sharp processa e converte para WebP.Arquivo otimizado é salvo no disco.Caminho relativo é salvo no Banco de Dados.🚀 Stack TecnológicaBackendFramework: NestJSDatabase: PostgreSQL & TypeORMMedia Processing: SharpValidation: Class-ValidatorAuth: JWT & PassportPayments: Mercado Pago SDKFrontendFramework: React (Vite)Styling: TailwindCSS v4Icons: Lucide ReactHTTP: AxiosCharts: Recharts📦 Instalação e ExecuçãoPré-requisitosNode.js v18 ou superiorPostgreSQL rodando (local ou Docker)1. Backend (API)Bash# Clone o repositório
git clone [https://github.com/seu-usuario/TorresBurgers.git](https://github.com/seu-usuario/TorresBurgers.git)

# Acesse a pasta
cd TorresBurgers/backend

# Instale as dependências
npm install

# Configure o arquivo .env (veja seção abaixo)

# Rode as migrations (se houver) ou deixe o synchronize: true (dev)

# Inicie o servidor
npm run start:dev
2. Frontend (Web)Bashcd ../frontend-web

# Instale as dependências
npm install

# Inicie a aplicação
npm run dev
3. Migração de Imagens (Opcional)Caso já existam imagens pesadas no banco, execute a rota de manutenção para otimizar tudo:BashPOST http://localhost:3000/maintenance/optimize-images
Auth: Bearer {TOKEN_ADMIN}
🔐 Variáveis de AmbienteCrie um arquivo .env na raiz do /backend com as seguintes chaves:VariávelDescriçãoExemploDB_HOSTHost do Banco de DadoslocalhostDB_PORTPorta do Banco5432DB_USERNAMEUsuário do BancopostgresDB_PASSWORDSenha do BancoadminDB_DATABASENome do BancotorresburgersJWT_SECRETChave para assinar Tokensminha_chave_secretaMP_ACCESS_TOKENToken de Teste do Mercado PagoTEST-0000...FOOTBALL_API_KEY(Opcional) API de Futebolapi_key_rapidapi🛣 Roadmap[x] CRUD Produtos e Usuários[x] Autenticação JWT e RBAC (Roles)[x] Checkout Mercado Pago (Sandbox)[x] Dark Mode Completo[x] Otimização de Imagens (Backend)[ ] Websockets para status do pedido em tempo real[ ] Testes Unitários (Jest)[ ] Integração com ViaCEP para endereço[ ] Dashboard Financeiro Avançado🤝 ContribuiçãoContribuições são bem-vindas! Se você tiver uma ideia para melhorar o app:Faça um Fork do projetoCrie uma Branch para sua Feature (git checkout -b feature/Incrível)Faça o Commit (git commit -m 'Add some Incrível')Push para a Branch (git push origin feature/Incrível)Abra um Pull Request

👤 Autor
Felipe Torres (fp-torres)

Desenvolvedor Full Stack 🚀

Foco: Clean Code, Performance Web, Arquitetura Escalável e UX.