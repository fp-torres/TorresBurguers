# 💻 TorresBurgers | Frontend Web & Backoffice

Este repositório contém a **interface web do ecossistema TorresBurgers**.

Desenvolvido com foco em **alta performance** e **design responsivo**, o sistema é dividido em duas grandes frentes:

- **Experiência do Cliente (Menu Digital)**
- **Painel Administrativo (Gestão de Pedidos e Logística)**

---

# 🚀 Tecnologias Utilizadas

- **React + Vite**  
  Build ultra-rápido e desenvolvimento otimizado.

- **TailwindCSS v4**  
  A nova geração do CSS utilitário para estilização performática.

- **Axios**  
  Cliente HTTP para comunicação com a API NestJS.

- **Lucide React**  
  Conjunto de ícones leves e elegantes.

- **Recharts / Chart.js**  
  Visualização de dados de vendas e métricas em tempo real.

- **Context API**  
  Gestão de estado global para o carrinho e autenticação.

---

# ✨ Funcionalidades Principais

## 🛒 Menu Digital (Client-Side)

### Catálogo Dinâmico

- Listagem de produtos consumida em **tempo real via API**

### Carrinho Persistente

- O cliente pode atualizar **itens e adicionais**
- O progresso do pedido é mantido durante a navegação

### Filtros por Categoria

Navegação rápida entre:

- Combos
- Lanches
- Bebidas
- Sobremesas

### Promoções Inteligentes

- Banners contextuais baseados em **eventos e campanhas de marketing**

---

# ⚙️ Painel do Restaurante (Admin-Side)

## Dashboard Analítico

- Gráficos de performance
- Vendas diárias
- Ticket médio

Bibliotecas utilizadas:

- **Recharts**
- **Chart.js**

---

## Kanban de Pedidos

Gerenciamento visual do fluxo da cozinha:

```
Pendente → Preparo → Entrega
```

---

## Gestão de Cardápio

- Cadastro de produtos
- Edição de produtos
- Desativação com **Soft Delete**
- Gestão de **adicionais**

---

## Logística de Entrega

- Atribuição manual de **motoboys**
- Distribuição automática de entregas
- Controle de pedidos concluídos

---

# 🏗 Estrutura de Pastas

```bash
frontend-web/
├── public/              # Ativos estáticos (ícones, logos)

├── src/
│   ├── assets/          # Estilos globais e imagens
│   ├── components/      # Componentes reutilizáveis (Botões, Cards, Modais)
│   ├── contexts/        # Gerenciamento de estado (Auth, Cart, Theme)
│   ├── hooks/           # Hooks customizados
│   ├── pages/           # Telas (Home, Login, Admin, Dashboard)
│   ├── services/        # Configuração do Axios e chamadas à API
│   └── utils/           # Funções auxiliares e formatadores de preço

├── .env.example         # Exemplo de variáveis de ambiente
└── tailwind.config.js   # Configurações do Tailwind v4
```

---

# 📦 Instalação e Execução

## 1️⃣ Acesse a pasta do projeto

```bash
cd frontend-web
```

---

## 2️⃣ Instale as dependências

```bash
npm install
```

---

## 3️⃣ Configure o ambiente

Crie um arquivo `.env` baseado no `.env.example`:

```env
VITE_API_URL=http://localhost:3000
```

---

## 4️⃣ Inicie o servidor de desenvolvimento

```bash
npm run dev
```

---

# 📡 Integração com o Backend

O **frontend web** está configurado para se comunicar com a **API NestJS**.

Em ambiente de desenvolvimento, certifique-se de que o backend esteja rodando para que as seguintes funcionalidades funcionem corretamente:

- autenticação
- listagem de produtos
- pedidos
- gestão administrativa

### 💡 Dica

Se estiver testando o **fluxo mobile simultaneamente**, utilize a **URL do túnel (Serveo)** no seu `.env`.

Exemplo:

```env
VITE_API_URL=https://seu-tunel.serveo.net
```

Isso mantém **consistência de dados entre Web e Mobile**.

---

# 🛣 Roadmap Web

- [x] Interface Responsiva (Mobile First)

- [x] Fluxo de Carrinho e Checkout

- [x] Painel Administrativo Base

Próximas melhorias:

- [ ] Integração com **WebSockets** para atualização automática do Kanban

- [ ] Relatórios avançados para exportação em **PDF / Excel**