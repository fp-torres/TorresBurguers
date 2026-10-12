import AsyncStorage from '@react-native-async-storage/async-storage';

import { STORAGE_KEYS } from '../config/brand';

/**
 * Chaves gravadas pelas versões anteriores à marca atual. O usuário antigo podia conter
 * o password_hash, então a sessão antiga é apagada (o cliente entra de novo).
 */
const LEGACY_KEYS = {
  token: '@TorresBurgers:token',
  user: '@TorresBurgers:user',
  themeMode: '@TorresBurgers:themeMode',
  /** Versão mais antiga do tema ('light' | 'dark'). */
  theme: '@TorresBurgers:theme',
};

const THEME_MODES = ['light', 'dark', 'system'];

let migration: Promise<void> | null = null;

/**
 * Migração única das chaves antigas: apaga token e usuário e leva a preferência de tema
 * para STORAGE_KEYS.themeMode (sem sobrescrever uma escolha já feita na versão nova).
 * Pode ser aguardada por vários providers: roda uma vez por abertura do app e nunca rejeita.
 */
export function migrateLegacyStorage(): Promise<void> {
  if (!migration) migration = runMigration();
  return migration;
}

async function runMigration(): Promise<void> {
  try {
    const legacyKeys = Object.values(LEGACY_KEYS);
    const values = Object.fromEntries(await AsyncStorage.multiGet([...legacyKeys, STORAGE_KEYS.themeMode]));
    if (!legacyKeys.some((key) => values[key] != null)) return;

    const oldTheme = values[LEGACY_KEYS.themeMode] ?? values[LEGACY_KEYS.theme];
    if (!values[STORAGE_KEYS.themeMode] && oldTheme && THEME_MODES.includes(oldTheme)) {
      await AsyncStorage.setItem(STORAGE_KEYS.themeMode, oldTheme);
    }
    await AsyncStorage.multiRemove(legacyKeys);
  } catch {
    // Sem acesso ao armazenamento: tenta de novo na próxima abertura do app.
  }
}
