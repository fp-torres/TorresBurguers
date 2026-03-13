import React, { createContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api from '../services/api';

// Exportando a interface User para poder usar em outras telas se precisar
export interface User {
  id: number;
  name: string;
  email: string;
  role: string;
}

interface AuthContextData {
  signed: boolean;
  user: User | null;
  loading: boolean;
  // Alterado: Agora o signIn retorna uma Promise com o User, em vez de void
  signIn: (email: string, password: string) => Promise<User>; 
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextData>({} as AuthContextData);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadStorageData() {
      try {
        const storageUser = await AsyncStorage.getItem('@TorresBurgers:user');
        const storageToken = await AsyncStorage.getItem('@TorresBurgers:token');

        if (storageUser && storageToken) {
          api.defaults.headers.Authorization = `Bearer ${storageToken}`;
          setUser(JSON.parse(storageUser));
        }
      } catch (error) {
        console.error("Erro ao carregar dados do celular:", error);
        await AsyncStorage.clear(); 
      } finally {
        setLoading(false);
      }
    }

    loadStorageData();
  }, []);

  // Alterado para retornar o userData no final
  async function signIn(email: string, password: string): Promise<User> {
    try {
      console.log("--- TENTANDO LOGAR ---");
      console.log("Enviando para API:", { email, password }); 

      const response = await api.post('/auth/login', { 
        email: email.trim(), 
        password: password 
      });
      
      console.log("Login Sucesso! Status:", response.status);

      const { access_token, user: userData } = response.data;

      await AsyncStorage.setItem('@TorresBurgers:token', access_token);
      await AsyncStorage.setItem('@TorresBurgers:user', JSON.stringify(userData));

      api.defaults.headers.Authorization = `Bearer ${access_token}`;
      setUser(userData);

      // RETORNANDO O USUÁRIO PARA A TELA DE LOGIN SABER QUEM É
      return userData; 

    } catch (error: any) {
      console.error("--- ERRO NO LOGIN ---");
      if (error.response?.data) {
        console.error("RESPOSTA DO BACKEND:", JSON.stringify(error.response.data, null, 2));
      } else {
        console.error("Erro técnico:", error.message);
      }
      throw error;
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