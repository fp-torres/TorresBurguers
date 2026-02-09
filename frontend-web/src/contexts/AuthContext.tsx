import { createContext, useContext, useState, type ReactNode } from 'react';

interface User {
  id: number;
  name: string;
  email: string;
  role: string;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  signIn: (token: string, userData: User) => void;
  signOut: () => void;
}

// Valor inicial seguro (evita undefined se o Provider falhar)
const AuthContext = createContext<AuthContextType>({
  user: null,
  isAuthenticated: false,
  signIn: () => {},
  signOut: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  // Estado do usuário (Carrega do localStorage ao iniciar)
  const [user, setUser] = useState<User | null>(() => {
    const userStored = localStorage.getItem('torresburgers.user');
    const tokenStored = localStorage.getItem('torresburgers.token');
    
    if (userStored && tokenStored) {
      try {
        const parsedUser = JSON.parse(userStored);
        console.log("AuthProvider: Usuário restaurado:", parsedUser);
        return parsedUser;
      } catch {
        return null;
      }
    }
    return null;
  });

  // Função de Login (Salva e Atualiza a Tela)
  function signIn(token: string, userData: User) {
    console.log("AuthProvider: signIn chamado com:", userData);
    localStorage.setItem('torresburgers.token', token);
    localStorage.setItem('torresburgers.user', JSON.stringify(userData));
    setUser(userData); // <--- Força a atualização do estado global
  }

  // Função de Logout (Limpa e Atualiza a Tela)
  function signOut() {
    console.log("AuthProvider: signOut chamado");
    localStorage.removeItem('torresburgers.token');
    localStorage.removeItem('torresburgers.user');
    setUser(null);
    window.location.href = '/';
  }

  const isAuthenticated = !!user;

  return (
    <AuthContext.Provider value={{ user, isAuthenticated, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}