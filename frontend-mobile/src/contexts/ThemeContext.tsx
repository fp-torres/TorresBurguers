import React, { createContext, useState, useEffect } from 'react';
import { useColorScheme } from 'nativewind';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface ThemeContextData {
  theme: 'light' | 'dark';
  toggleTheme: () => void;
}

export const ThemeContext = createContext<ThemeContextData>({} as ThemeContextData);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // O NativeWind tem um hook próprio para forçar o CSS a mudar de cor
  const { colorScheme, setColorScheme } = useColorScheme();
  
  // O estado que nosso app vai ler (começa no escuro para manter o que já fizemos)
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');

  useEffect(() => {
    async function loadTheme() {
      const savedTheme = await AsyncStorage.getItem('@TorresBurgers:theme');
      if (savedTheme) {
        setTheme(savedTheme as 'light' | 'dark');
        setColorScheme(savedTheme as 'light' | 'dark');
      } else {
        // Se é a primeira vez abrindo o app, força o dark
        setColorScheme('dark');
        setTheme('dark');
      }
    }
    loadTheme();
  }, [setColorScheme]);

  async function toggleTheme() {
    const newTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);
    setColorScheme(newTheme);
    // Salva a escolha na memória do celular
    await AsyncStorage.setItem('@TorresBurgers:theme', newTheme);
  }

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}