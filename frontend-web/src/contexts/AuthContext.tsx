import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import api from '../services/api';

export interface User {
  id: number;
  name: string;
  email: string;
  role: 'ADMIN' | 'CLIENT' | 'KITCHEN' | 'COURIER' | 'EMPLOYEE';
  phone?: string;
  avatar?: string; 
}

interface AuthContextData {
  user: User | null;
  isAuthenticated: boolean;
  signIn: (data: { email: string; password: string }) => Promise<User>; 
  signOut: () => void;
  updateUser: (user: User) => void;
}

const AuthContext = createContext<AuthContextData>({} as AuthContextData);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const storagedUser = localStorage.getItem('torresburgers.user');
    const storagedToken = localStorage.getItem('torresburgers.token');

    if (storagedToken && storagedUser) {
      try {
        api.defaults.headers.common['Authorization'] = `Bearer ${storagedToken}`;
        setUser(JSON.parse(storagedUser));
      } catch {
        localStorage.clear();
        setUser(null);
      }
    }
    setLoading(false);
  }, []);

  async function signIn({ email, password }: any) {
    const response = await api.post('/auth/login', { email, password });
    
    const { user, access_token } = response.data;

    localStorage.setItem('torresburgers.user', JSON.stringify(user));
    localStorage.setItem('torresburgers.token', access_token);

    api.defaults.headers.common['Authorization'] = `Bearer ${access_token}`;
    setUser(user);
    
    return user; 
  }

  function signOut() {
    localStorage.clear();
    setUser(null);
    delete api.defaults.headers.common['Authorization'];
  }

  function updateUser(updatedUser: User) {
    setUser(updatedUser);
    localStorage.setItem('torresburgers.user', JSON.stringify(updatedUser));
  }

  if (loading) {
    return null;
  }

  return (
    <AuthContext.Provider value={{ 
      user, 
      isAuthenticated: !!user, 
      signIn, 
      signOut,
      updateUser 
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}