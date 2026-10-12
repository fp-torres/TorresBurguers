import React, { createContext, useState, useEffect } from 'react';
import { Appearance, useColorScheme as useRNColorScheme } from 'react-native';
import { useColorScheme as useNativeWindColorScheme } from 'nativewind';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { STORAGE_KEYS } from '../config/brand';
import { migrateLegacyStorage } from '../services/legacyStorage';

export type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeContextData {
  themeMode: ThemeMode; // A escolha do usuário (Sistema, Claro ou Escuro)
  activeTheme: 'light' | 'dark'; // A cor real que está sendo mostrada agora
  cycleTheme: () => void; // Função para alternar entre os 3 modos
}

export const ThemeContext = createContext<ThemeContextData>({} as ThemeContextData);

const THEME_MODES: ThemeMode[] = ['light', 'dark', 'system'];

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
      // Traz o tema salvo pelas versões antigas do app (e apaga a sessão antiga)
      await migrateLegacyStorage();
      let savedMode: string | null = null;
      try {
        savedMode = await AsyncStorage.getItem(STORAGE_KEYS.themeMode);
      } catch {
        // Sem acesso ao armazenamento: segue o sistema.
      }
      applyTheme(THEME_MODES.includes(savedMode as ThemeMode) ? (savedMode as ThemeMode) : 'system');
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

  function applyTheme(mode: ThemeMode) {
    setThemeMode(mode);
    AsyncStorage.setItem(STORAGE_KEYS.themeMode, mode).catch(() => undefined);

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
