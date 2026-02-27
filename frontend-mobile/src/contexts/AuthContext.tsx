import React, { createContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api from '../services/api';

interface User {
  id: number;
  name: string;
  email: string;
  role: string;
}

interface AuthContextData {
  signed: boolean;
  user: User | null;
  loading: boolean;
  signIn: (email: string, password_hash: string) => Promise<void>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextData>({} as AuthContextData);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadStorageData() {
      const storageUser = await AsyncStorage.getItem('@TorresBurgers:user');
      const storageToken = await AsyncStorage.getItem('@TorresBurgers:token');

      if (storageUser && storageToken) {
        // Se já tem token salvo, injeta na API e seta o usuário
        api.defaults.headers.Authorization = `Bearer ${storageToken}`;
        setUser(JSON.parse(storageUser));
      }
      setLoading(false);
    }

    loadStorageData();
  }, []);

  async function signIn(email: string, password_hash: string) {
    try {
      // Chama a rota de login do seu backend NestJS
      const response = await api.post('/auth/login', { email, password_hash });
      
      const { access_token, user: userData } = response.data;

      await AsyncStorage.setItem('@TorresBurgers:token', access_token);
      await AsyncStorage.setItem('@TorresBurgers:user', JSON.stringify(userData));

      api.defaults.headers.Authorization = `Bearer ${access_token}`;
      setUser(userData);
    } catch (error) {
      console.error("Erro no login:", error);
      throw error; // Repassa o erro para a tela de login mostrar um alerta
    }
  }

  async function signOut() {
    await AsyncStorage.clear();
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ signed: !!user, user, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}