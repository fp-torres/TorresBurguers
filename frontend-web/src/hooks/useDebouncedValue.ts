import { useEffect, useState } from 'react';

/**
 * Devolve `value` só depois de `delay` ms sem mudanças (ex.: busca enquanto o usuário digita).
 * A cada nova mudança dentro do prazo, a espera recomeça.
 */
export function useDebouncedValue<T>(value: T, delay = 400): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
