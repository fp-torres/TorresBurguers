import { createContext, useContext } from 'react';

/**
 * Por que as configurações estão só para consulta (texto curto do rodapé de cada seção), ou null quando
 * podem ser alteradas. O motivo detalhado (access.message) aparece no aviso do topo da página.
 */
export const SettingsLockContext = createContext<string | null>(null);

export function useSettingsLock(): string | null {
  return useContext(SettingsLockContext);
}
