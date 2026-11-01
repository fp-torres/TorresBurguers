import { useEffect, useState } from 'react';
import { getApiErrorMessage, getApiErrorStatus } from '../../../services/api';

export type LinkCheck<T> =
  | { status: 'valid'; info: T }
  | { status: 'invalid' }
  | { status: 'error'; message: string };

/** Link inválido, já usado ou expirado: a API responde 404 (sempre a mesma mensagem). */
export function isInvalidLinkError(error: unknown): boolean {
  return getApiErrorStatus(error) === 404;
}

/**
 * Confere um link recebido por e-mail ao abrir a página (só o GET: verificadores de links dos provedores de
 * e-mail abrem as URLs sozinhos, então nada é usado sem o clique). null enquanto confere; "retry" confere de
 * novo; "markInvalid" registra que o link deixou de valer (ex.: 404 no POST).
 */
export function useLinkCheck<T>(token: string, inspect: (token: string) => Promise<T>) {
  const [attempt, setAttempt] = useState(0);
  const checkKey = `${token}#${attempt}`;
  const [check, setCheck] = useState<{ key: string; result: LinkCheck<T> } | null>(null);

  useEffect(() => {
    let active = true;
    inspect(token)
      .then((info) => {
        if (active) setCheck({ key: checkKey, result: { status: 'valid', info } });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setCheck({
          key: checkKey,
          result: isInvalidLinkError(error)
            ? { status: 'invalid' }
            : { status: 'error', message: getApiErrorMessage(error, 'Não foi possível conferir o link agora.') },
        });
      });
    return () => {
      active = false;
    };
  }, [token, checkKey, inspect]);

  return {
    linkCheck: check?.key === checkKey ? check.result : null,
    retry: () => setAttempt((value) => value + 1),
    markInvalid: () => setCheck({ key: checkKey, result: { status: 'invalid' } }),
  };
}
