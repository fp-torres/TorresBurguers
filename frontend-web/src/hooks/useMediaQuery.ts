import { useCallback, useSyncExternalStore } from 'react';

/**
 * true enquanto a media query casa (ex.: '(min-width: 40rem)' = a partir do breakpoint sm do Tailwind).
 * Lida na primeira renderização (sem piscar o layout errado) e atualizada quando a janela muda.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof window === 'undefined' || !window.matchMedia) return () => {};
    const list = window.matchMedia(query);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  const getSnapshot = () => (typeof window !== 'undefined' && !!window.matchMedia ? window.matchMedia(query).matches : false);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
