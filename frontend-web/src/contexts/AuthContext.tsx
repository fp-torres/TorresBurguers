import { createContext, useContext, useState, type ReactNode } from 'react';

interface User { id: number; name: string; email: string; role: string; }
interface AuthContextType { user: User | null; isAuthenticated: boolean; signIn: (token: string, userData: User) => void; signOut: () => void; }

const AuthContext = createContext<AuthContextType>({ user: null, isAuthenticated: false, signIn: () => {}, signOut: () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    const userStored = localStorage.getItem('torresburgers.user');
    const tokenStored = localStorage.getItem('torresburgers.token');
    if (userStored && tokenStored) {
      try {
        const parsedUser = JSON.parse(userStored);
        console.log("Auth: Restaurado", parsedUser);
        return parsedUser;
      } catch { return null; }
    }
    return null;
  });

  function signIn(token: string, userData: User) {
    localStorage.setItem('torresburgers.token', token);
    localStorage.setItem('torresburgers.user', JSON.stringify(userData));
    setUser(userData);
  }

  function signOut() {
    localStorage.removeItem('torresburgers.token');
    localStorage.removeItem('torresburgers.user');
    setUser(null);
    window.location.href = '/'; // Força refresh para limpar estados
  }

  return <AuthContext.Provider value={{ user, isAuthenticated: !!user, signIn, signOut }}>{children}</AuthContext.Provider>;
}

export function useAuth() { return useContext(AuthContext); }