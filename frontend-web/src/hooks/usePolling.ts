import { useEffect, useRef } from 'react';

export interface UsePollingOptions {
  /** false pausa a atualização automática (padrão: true). */
  enabled?: boolean;
  /** Executa também ao começar, sem esperar o primeiro intervalo (padrão: false). */
  immediate?: boolean;
  /** Pausa com a aba oculta (padrão: true). */
  pauseWhenHidden?: boolean;
  /** Ao voltar para a aba, executa na hora e retoma o intervalo (padrão: true). */
  refreshOnVisible?: boolean;
}

/**
 * Executa `callback` a cada `intervalMs` (ex.: recarregar uma lista ou indicadores).
 * - Não acumula execuções: a próxima só é agendada quando a anterior termina (inclusive se ela devolver uma Promise).
 * - Com a aba oculta, pausa; ao voltar, executa na hora e retoma o intervalo.
 * - Usa sempre a versão mais recente do callback, sem reiniciar o intervalo a cada render.
 * Erros do callback são responsabilidade de quem chama (aqui só não interrompem o ciclo).
 */
export function usePolling(callback: () => unknown, intervalMs: number, options: UsePollingOptions = {}): void {
  const { enabled = true, immediate = false, pauseWhenHidden = true, refreshOnVisible = true } = options;
  const savedCallback = useRef(callback);

  useEffect(() => {
    savedCallback.current = callback;
  });

  useEffect(() => {
    if (!enabled || !(intervalMs > 0)) return;

    let timer: number | undefined;
    let running = false;
    let stopped = false;

    const isHidden = () => pauseWhenHidden && document.visibilityState === 'hidden';

    function schedule() {
      window.clearTimeout(timer);
      if (stopped || isHidden()) return;
      timer = window.setTimeout(() => void tick(), intervalMs);
    }

    async function tick() {
      // Execução em andamento (ela agenda a próxima ao terminar) ou aba oculta (retoma ao voltar)
      if (stopped || running || isHidden()) return;
      window.clearTimeout(timer);
      running = true;
      try {
        await savedCallback.current();
      } catch {
        // Quem chama trata os próprios erros; o ciclo continua
      } finally {
        running = false;
        schedule();
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        window.clearTimeout(timer);
        return;
      }
      if (refreshOnVisible) void tick();
      else if (!running) schedule();
    }

    if (immediate) void tick();
    else schedule();

    if (pauseWhenHidden) document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [enabled, intervalMs, immediate, pauseWhenHidden, refreshOnVisible]);
}
