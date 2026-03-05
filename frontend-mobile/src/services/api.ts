import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';

// 👇 ATUALIZADO COM A URL QUE O SEU TERMINAL GEROU AGORA
const API_URL = 'https://4f76130b51e29443-189-113-142-250.serveousercontent.com'; 

const api = axios.create({
  baseURL: API_URL,
  timeout: 10000,
});

api.interceptors.request.use(async (config) => {
  const token = await AsyncStorage.getItem('@TorresBurgers:token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export default api;