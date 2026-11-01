import { useEffect, useRef, useState } from 'react';
import type { PickerOption } from './pickerOptions';

/**
 * Opção de um filtro que pode chegar só com o id (ex.: ?loja=7 no endereço da página): começa com um
 * rótulo provisório ("Loja #7") e busca o nome na API uma única vez — ou usa `known`, se quem abriu a tela
 * já tinha a opção com o mesmo id. Devolve [opção, setOpção].
 */
export function useLabeledOption(
  initialId: number | null,
  resolve: (id: number, signal: AbortSignal) => Promise<PickerOption | null>,
  placeholder: (id: number) => string,
  known?: PickerOption | null,
) {
  const knownMatches = !!initialId && known?.id === initialId;
  const [option, setOption] = useState<PickerOption | null>(() => {
    if (!initialId) return null;
    return knownMatches && known ? known : { id: initialId, label: placeholder(initialId) };
  });
  const [pendingId] = useState(knownMatches ? null : initialId);
  const resolveRef = useRef(resolve);
  useEffect(() => {
    resolveRef.current = resolve;
  });

  useEffect(() => {
    if (!pendingId) return;
    const controller = new AbortController();
    resolveRef.current(pendingId, controller.signal)
      .then((resolved) => {
        // Só substitui se a escolha ainda for a mesma (a pessoa pode ter trocado o filtro nesse meio-tempo)
        if (resolved && !controller.signal.aborted) setOption((current) => (current?.id === resolved.id ? resolved : current));
      })
      .catch(() => {
        // Sem o nome (ex.: id inexistente): fica o rótulo provisório; a lista mostra o que a API devolver
      });
    return () => controller.abort();
  }, [pendingId]);

  return [option, setOption] as const;
}
