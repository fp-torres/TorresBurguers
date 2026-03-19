<div align="center">

<img src="assets/icon.png" alt="TorresBurgers Logo" width="100" />

# 🍔 TorresBurgers — Mobile App

**A melhor experiência de pedido, direto no seu bolso.**

![React Native](https://img.shields.io/badge/React_Native-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![Expo](https://img.shields.io/badge/Expo-000020?style=for-the-badge&logo=expo&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![NativeWind](https://img.shields.io/badge/NativeWind-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white)

</div>

---

## 📖 Sobre

O **TorresBurgers Mobile** é a aplicação nativa do ecossistema TorresBurgers — construída com **React Native** e **Expo** para oferecer performance máxima, responsividade total e uma experiência de compra fluida do início ao checkout.

---

## ✨ Funcionalidades

### 🌓 Temas Dinâmicos (Dark & Light)
- Alternância em tempo real entre modo claro e escuro
- Preferência persistida localmente via **AsyncStorage**
- Responde automaticamente à preferência de tema do sistema operacional
- Estilização com **NativeWind** + **Context API**

### 🛒 Gestão de Carrinho
- Estado global via **CartContext** — consistente em todas as telas
- Cálculo automático de totais com suporte a preços promocionais e adicionais
- **Pill Button** flutuante na Home com resumo do pedido em tempo real

### 🔐 Autenticação & Segurança
- Login seguro com **JWT** e persistência de sessão
- Barreira de checkout: login solicitado apenas na finalização do pedido
- Navegação protegida com **Reset Navigation** e **GoBack seguro**

### 📡 Networking & Dev Experience
- Script `npm run tunnel` que inicia o túnel SSH, captura a URL dinâmica e atualiza a `baseURL` da API automaticamente
- Função inteligente de processamento de imagens para compatibilidade com caminhos `/uploads` do backend **NestJS** e URLs de túnel dinâmico

---

## 🏗 Estrutura de Pastas

```
frontend-mobile/
├── assets/                 # Ícones, splash screen e fontes
├── src/
│   ├── @types/             # Definições de tipos globais
│   ├── components/         # Componentes de UI reutilizáveis
│   ├── contexts/           # Provedores de estado (Auth, Cart, Theme)
│   ├── routes/             # Configuração de Stack Navigation
│   ├── screens/            # Telas (Home, Cart, ProductDetails...)
│   ├── services/           # Integração com Axios e API
│   └── utils/              # Funções auxiliares e formatadores
├── start-tunnel.js         # Script de automação do túnel SSH
├── tailwind.config.js      # Configuração do NativeWind
└── App.tsx                 # Ponto de entrada da aplicação
```

---

## 🚀 Como Executar

### Pré-requisitos

- [Node.js](https://nodejs.org/) instalado
- [Expo Go](https://expo.dev/client) no celular **ou** emulador Android/iOS configurado

---

### Passo a passo

**1. Instale as dependências**
```bash
npm install
```

**2. Conecte à API** *(somente em rede remota ou corporativa)*
```bash
npm run tunnel
```
> Esse comando cria o túnel, captura a URL pública e atualiza a `baseURL` automaticamente.

**3. Inicie o Expo**
```bash
npm run start
```

**4. Abra no dispositivo**

Escaneie o **QR Code** com o Expo Go ou use os atalhos no terminal:

| Tecla | Ação |
|-------|------|
| `a` | Abrir no Android |
| `i` | Abrir no iOS |

---

## 🛠 Stack Tecnológica

| Tecnologia | Finalidade |
|---|---|
| **React Native** | Framework base para apps nativos |
| **Expo** | Ecossistema de ferramentas e workflow |
| **TypeScript** | Tipagem estática e segurança de código |
| **NativeWind** | Estilização baseada em Tailwind CSS |
| **React Navigation** | Gestão de rotas e pilhas de telas |
| **Axios** | Consumo de API REST |
| **AsyncStorage** | Armazenamento local de dados |

---

## 🛣 Roadmap

**Já implementado**
- [x] Contexto global de Carrinho e Autenticação
- [x] Suporte a Dark / Light Mode
- [x] Automação de configuração da API via túnel

**Em desenvolvimento**
- [ ] Fluxo completo de Pagamento (Checkout)
- [ ] Push Notifications para status do pedido
- [ ] Integração com mapas para rastreio de entrega

---

<div align="center">

Feito com 🍔 pela equipe **TorresBurgers**

</div>