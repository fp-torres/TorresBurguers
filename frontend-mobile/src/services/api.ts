import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { STORAGE_KEYS } from '../config/brand';

/** Porta da API quando o endereço é descoberto automaticamente (EXPO_PUBLIC_API_PORT; padrão 3000). */
const PORT_FROM_ENV = process.env.EXPO_PUBLIC_API_PORT?.trim();
const API_PORT = PORT_FROM_ENV && /^\d{1,5}$/.test(PORT_FROM_ENV) ? PORT_FROM_ENV : '3000';

/** No emulador Android, "localhost" é o próprio emulador: o computador é alcançado em 10.0.2.2. */
const ANDROID_EMULATOR_HOST = '10.0.2.2';
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1'];

/**
 * Endereço do backend, em ordem de prioridade:
 * 1. EXPO_PUBLIC_API_URL (.env / .env.local — o `npm run tunnel` grava a URL pública aqui);
 * 2. o IP da máquina que roda o Expo (mesma rede Wi-Fi do celular/emulador), porta EXPO_PUBLIC_API_PORT;
 *    no Android, localhost/127.0.0.1 vira 10.0.2.2 (emulador). Celular via USB com `adb reverse`:
 *    defina EXPO_PUBLIC_API_URL=http://127.0.0.1:3000;
 * 3. localhost (navegador / iOS Simulator).
 */
function resolveApiUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv) return fromEnv.replace(/\/+$/, '');

  const host = Constants.expoConfig?.hostUri?.split(':')[0]; // ex.: "192.168.1.20:8081"
  if (host && !host.endsWith('.exp.direct')) {
    const machine = Platform.OS === 'android' && LOOPBACK_HOSTS.includes(host) ? ANDROID_EMULATOR_HOST : host;
    return `http://${machine}:${API_PORT}`;
  }

  if (host) {
    console.warn('Expo em modo túnel: defina EXPO_PUBLIC_API_URL (npm run tunnel) para o app alcançar a API.');
  }
  return `http://localhost:${API_PORT}`;
}

export const API_URL = resolveApiUrl();

/**
 * Tempo limite para pedidos e pagamentos (/orders e /payment/*): o backend pode esperar o
 * Mercado Pago (cobrança ou estorno). Passe por requisição: `{ timeout: LONG_TIMEOUT_MS }`.
 * O padrão da instância (10 s) vale para o resto e não limita esse valor.
 */
export const LONG_TIMEOUT_MS = 45_000;

const api = axios.create({
  baseURL: API_URL,
  timeout: 10000,
});

api.interceptors.request.use(async (config) => {
  const token = await AsyncStorage.getItem(STORAGE_KEYS.token);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/**
 * Monta a URL pública de uma imagem servida pelo backend.
 * Aceita URL absoluta, caminho "/uploads/arquivo.webp" ou apenas o nome do arquivo.
 */
export function assetUrl(path?: string | null): string | undefined {
  if (!path) return undefined;
  if (/^(https?:|data:|file:)/i.test(path)) return path;
  const clean = path.replace(/^\/+/, '');
  return `${API_URL}/${clean.startsWith('uploads/') ? clean : `uploads/${clean}`}`;
}

export default api;
