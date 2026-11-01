import { useEffect, useState } from 'react';

/**
 * Instante atual que se atualiza sozinho (ex.: "termina em 3 dias", faturas vencidas, relógio do fuso da loja).
 * Fica fora do render (o React exige render puro): o valor muda pelo intervalo.
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
