# 📱 TorresBurgers | Mobile App (React Native & Expo)

Esta é a **aplicação nativa do ecossistema TorresBurgers**, focada em proporcionar a melhor experiência de compra para o cliente final.

Construída com **React Native** e **Expo**, a aplicação utiliza uma arquitetura moderna para garantir:

- alta performance
- responsividade (**100% mobile-first**)
- suporte a múltiplos temas

---

# ✨ Funcionalidades Mobile

## 🌓 Sistema de Temas Dinâmico

### Dark & Light Mode

Implementação utilizando:

- **NativeWind**
- **Context API**

### Persistência

A preferência de tema é armazenada localmente no dispositivo através do:

```
AsyncStorage
```

### UI Adaptativa

Interface que responde em **tempo real** a:

- mudança de luminosidade
- preferência de tema do sistema

---

# 🛒 Gestão de Pedidos (Carrinho)

### Estado Global

Uso do **CartContext** para gerir:

- itens
- quantidades
- adicionais

de forma consistente entre todas as telas.

---

### Cálculo em Tempo Real

Totalizador automático que considera:

- preços promocionais
- valores de extras

---

### Feedback Visual

Botão flutuante (**Pill Button**) na tela **Home** com resumo do carrinho.

---

# 🔐 Segurança e Acesso

### Autenticação JWT

Login seguro com persistência de **token JWT**.

---

### Barreira de Checkout

Validação automática que solicita login **apenas no momento da finalização do pedido**.

---

### Navegação Segura

Fluxos protegidos utilizando:

- **Reset Navigation**
- **GoBack seguro**
- proteção de rotas

---

# 📡 Networking & Dev Experience

## Automação de Túnel (`npm run tunnel`)

Script personalizado que:

1. inicia o túnel **SSH**
2. captura a **URL dinâmica gerada**
3. atualiza automaticamente a configuração da API

---

## Tratamento de Imagens

Função inteligente para processar **caminhos estáticos** vindos do backend **NestJS**.

Isso garante compatibilidade com:

```
/uploads
```

e URLs de **túnel dinâmico**.

---

# 🏗 Estrutura de Pastas

```bash
frontend-mobile/
├── assets/              # Ícones, splash screen e fontes

├── src/
│   ├── @types/          # Definições de tipos globais
│   ├── components/      # Componentes de UI reutilizáveis
│   ├── contexts/        # Provedores de Estado (Auth, Cart, Theme)
│   ├── routes/          # Configuração de Stack Navigation
│   ├── screens/         # Telas (Home, Cart, ProductDetails, etc.)
│   ├── services/        # Integração com Axios e API
│   └── utils/           # Funções auxiliares e formatadores

├── start-tunnel.js      # Script de automação do túnel SSH
├── tailwind.config.js   # Configuração do NativeWind
└── App.tsx              # Ponto de entrada da aplicação
```

---

# 🚀 Como Executar

## Pré-requisitos

- **Node.js instalado**
- **Expo Go** no telemóvel  
  ou
- **Emulador Android/iOS configurado**

---

# 📦 Passo a Passo

## 1️⃣ Instale as dependências

```bash
npm install
```

---

## 2️⃣ Inicie a conexão com a API

Se estiver trabalhando remotamente ou em rede corporativa restrita:

```bash
npm run tunnel
```

Esse comando:

- cria o túnel
- captura a URL pública
- atualiza automaticamente a **baseURL da API**

---

## 3️⃣ Inicie o Expo

```bash
npm run start
```

---

## 4️⃣ Abra no dispositivo

- Escaneie o **QR Code** com o **Expo Go**

ou utilize os atalhos no terminal:

```
a → Android
i → iOS
```

---

# 🛠 Stack Tecnológica

| Tecnologia | Finalidade |
|-------------|-------------|
| React Native | Framework base para apps nativos |
| Expo | Ecossistema de ferramentas e workflow |
| NativeWind | Estilização baseada em Tailwind CSS |
| React Navigation | Gestão de rotas e pilhas de ecrãs |
| Axios | Consumo de API REST |
| AsyncStorage | Armazenamento local de dados |

---

# 🛣 Roadmap Mobile

Funcionalidades já implementadas:

- [x] Contexto global de **Carrinho e Autenticação**
- [x] Suporte a **Dark / Light Mode**
- [x] Automação de configuração da **API via túnel**

Próximas melhorias:

- [ ] Implementação do **Fluxo de Pagamento (Checkout Completo)**
- [ ] **Push Notifications** para status do pedido
- [ ] Integração com **Mapas para rastreio de entrega**