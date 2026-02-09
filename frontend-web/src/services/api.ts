import axios from 'axios';

const api = axios.create({
  baseURL: 'http://localhost:3000', // Endereço do nosso Backend NestJS
});

// Interceptor: O "Porteiro" das requisições
api.interceptors.request.use((config) => {
  // Tenta recuperar o token salvo no LocalStorage do navegador
  const token = localStorage.getItem('torresburgers.token');

  if (token) {
    // Se tiver token, anexa no cabeçalho Authorization
    config.headers.Authorization = `Bearer ${token}`;
  }

  return config;
});

export default api;