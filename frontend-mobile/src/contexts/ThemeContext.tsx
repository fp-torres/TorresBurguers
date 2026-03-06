import React, { createContext, useState, useEffect } from 'react';
import { Appearance, useColorScheme as useRNColorScheme } from 'react-native';
import { useColorScheme as useNativeWindColorScheme } from 'nativewind';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeContextData {
  themeMode: ThemeMode; // A escolha do usuário (Sistema, Claro ou Escuro)
  activeTheme: 'light' | 'dark'; // A cor real que está sendo mostrada agora
  cycleTheme: () => void; // Função para alternar entre os 3 modos
}

export const ThemeContext = createContext<ThemeContextData>({} as ThemeContextData);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Hook do NativeWind para forçar o CSS Tailwind
  const { setColorScheme } = useNativeWindColorScheme();
  // Hook nativo do React Native que avisa quando o celular muda de cor sozinho
  const systemColorScheme = useRNColorScheme(); 
  
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  const [activeTheme, setActiveTheme] = useState<'light' | 'dark'>('dark');

  // Ao abrir o app, carrega a preferência salva
  useEffect(() => {
    async function loadTheme() {
      const savedMode = await AsyncStorage.getItem('@TorresBurgers:themeMode') as ThemeMode;
      if (savedMode) {
        applyTheme(savedMode);
      } else {
        applyTheme('system'); // Padrão: Seguir o sistema
      }
    }
    loadTheme();
  }, []);

  // Fica escutando: se estiver no modo 'system' e o celular mudar de cor, o app muda junto!
  useEffect(() => {
    if (themeMode === 'system') {
      const currentSystemTheme = systemColorScheme === 'light' ? 'light' : 'dark';
      setColorScheme(currentSystemTheme);
      setActiveTheme(currentSystemTheme);
    }
  }, [systemColorScheme, themeMode]);

  async function applyTheme(mode: ThemeMode) {
    setThemeMode(mode);
    await AsyncStorage.setItem('@TorresBurgers:themeMode', mode);

    if (mode === 'system') {
      const currentSystemTheme = Appearance.getColorScheme() === 'light' ? 'light' : 'dark';
      setColorScheme(currentSystemTheme);
      setActiveTheme(currentSystemTheme);
    } else {
      setColorScheme(mode);
      setActiveTheme(mode);
    }
  }

  // Alterna entre: Sistema -> Claro -> Escuro -> Sistema...
  function cycleTheme() {
    if (themeMode === 'system') applyTheme('light');
    else if (themeMode === 'light') applyTheme('dark');
    else applyTheme('system');
  }

  return (
    <ThemeContext.Provider value={{ themeMode, activeTheme, cycleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}