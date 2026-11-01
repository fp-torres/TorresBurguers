import { Lock } from 'lucide-react';
import { cx } from '../../components/ui';
import { usePanelStore } from './panelStore';

interface LockedNoticeProps {
  /** O que fica só para consulta (ex.: "Cardápio", "Equipe"). */
  subject: string;
  className?: string;
}

/**
 * Aviso de tela só para consulta: sessão de suporte ou loja que a API diz não poder ser alterada
 * (os botões de alteração ficam escondidos ou desabilitados). Nada aparece quando está tudo liberado.
 */
export default function LockedNotice({ subject, className }: LockedNoticeProps) {
  const { lockReason } = usePanelStore();
  if (!lockReason) return null;

  return (
    <p
      role="status"
      className={cx(
        'flex items-start gap-2 px-4 py-3 rounded-2xl text-sm border',
        'bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800',
        className,
      )}
    >
      <Lock size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
      <span>
        <span className="font-bold">{subject}: somente consulta. </span>
        {lockReason}
      </span>
    </p>
  );
}
