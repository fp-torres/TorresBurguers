# ⚙️ TorresBurgers | Backend API (NestJS)

Este é o **motor do ecossistema TorresBurgers**.

Uma **API RESTful de alta performance** desenvolvida com **NestJS**, seguindo padrões de **Clean Architecture** e **SOLID** para garantir **escalabilidade, organização e fácil manutenção**.

---

# 🛠 Stack Tecnológica

| Camada | Tecnologia |
|------|-------------|
| **Framework** | NestJS |
| **Linguagem** | TypeScript |
| **Banco de Dados** | PostgreSQL |
| **ORM** | TypeORM |
| **Documentação** | Swagger (OpenAPI) |
| **Processamento de Imagens** | Sharp (Pipeline WebP) |
| **Segurança** | JWT (JSON Web Token) + Bcrypt |

---

# ✨ Funcionalidades Core

## 🍔 Gestão de Produtos e Categorias

- Sistema de **categorias via Enum**

```ts
BURGER
COMBO
DRINK
DESSERT
```

- Gerenciamento de **adicionais (Addons)** com relação **ManyToMany**
- **Soft Delete** implementado para manter integridade histórica de pedidos

---

## 📦 Fluxo de Pedidos Avançado

Status dinâmicos do pedido:

```
PENDING → PREPARING → DELIVERING → DONE → CANCELED
```

Recursos implementados:

- Diferenciação entre tipos de entrega
  - `DELIVERY`
  - `TAKEOUT`

- Vínculo direto com **motoristas / motoboys** para logística de entrega

---

## 🖼 Pipeline de Mídia (Performance)

Sistema otimizado para manipulação de imagens:

- Upload de imagens interceptado para **otimização automática**
- Conversão automática para **formato WebP** utilizando **Sharp**
- Serviço de arquivos estáticos configurado na rota:

```
/uploads
```

Benefício:

- Redução de até **90% do tamanho das imagens**
- Melhor **performance de carregamento no frontend**

---

# 🛡 Segurança e Validação

## ValidationPipe

Validação global de **DTOs** utilizando:

- `whitelist`
- `transform`

Isso garante que **apenas propriedades válidas sejam aceitas pela API**.

---

## CORS

Configurado para aceitar múltiplas origens:

- Frontend Web
- Aplicação Mobile

---

## Proteção de Rotas

Sistema de autenticação baseado em:

- **JWT (JSON Web Token)**
- **Roles Guard**

Exemplo de papéis de acesso:

```
ADMIN
USER
DELIVERY
```

---

# 🏗 Arquitetura do Sistema

A API é dividida em **módulos independentes**, seguindo os princípios de **Clean Architecture**.

### UsersModule

Responsável por:

- gestão de **clientes**
- gestão de **funcionários**
- autenticação e autorização

---

### ProductsModule

Gerencia:

- **cardápio**
- **categorias**
- **adicionais**

---

### OrdersModule

Responsável por:

- criação de **pedidos**
- gestão de **status**
- itens do pedido

---

### AddressesModule

Gerencia:

- **endereços de entrega**
- associação com usuários

---

### CommonModule

Contém funcionalidades compartilhadas:

- controladores de **upload**
- utilitários globais
- middlewares comuns

---

# 🚀 Como Executar

## Pré-requisitos

- **Node.js 18+**
- **PostgreSQL** rodando na porta `5432`

---

# 📦 Passo a Passo

## 1️⃣ Acesse a pasta do backend

```bash
cd backend
```

---

## 2️⃣ Instale as dependências

```bash
npm install
```

---

## 3️⃣ Configure as variáveis de ambiente

Crie um arquivo `.env` na raiz do projeto:

```env
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=0000
DB_DATABASE=torresburgers

JWT_SECRET=sua_chave_secreta
```

---

## 4️⃣ Inicie o servidor em modo desenvolvimento

```bash
npm run start:dev
```

---

# 📚 Documentação da API

A documentação interativa é gerada automaticamente via **Swagger**.

Após iniciar o servidor, acesse:

```
http://localhost:3000/api
```

Lá você poderá:

- testar endpoints
- visualizar schemas
- autenticar com JWT
- enviar requisições diretamente pelo navegador

---

# 🛣 Roadmap Backend

### Funcionalidades já implementadas

- [x] Integração **TypeORM + PostgreSQL**
- [x] Autenticação **JWT + Roles**
- [x] Pipeline de otimização de imagens com **Sharp (WebP)**

---

### Próximos passos

- [ ] Integração com **Gateway de Pagamento**
  - Mercado Pago
  - Stripe

- [ ] Sistema de **Logs de Auditoria**
  - Implementação com **Winston**