import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Link2Off, Loader2 } from 'lucide-react';
import AuthShell from './AuthShell';
import { EmptyState, ErrorState, buttonClass } from '../../../components/ui';
import type { LinkCheck } from './useLinkCheck';

/** Links "Entrar" (loja e painel) no rodapé das páginas de conta. */
export function AccountLinksFooter() {
  return (
    <p>
      <Link to="/signin" className="font-bold text-orange-600 dark:text-orange-400 hover:underline">Entrar na loja</Link>
      {' · '}
      <Link to="/login" className="font-bold text-orange-600 dark:text-orange-400 hover:underline">Entrar no painel</Link>
    </p>
  );
}

interface LinkStatusProps<T> {
  title: string;
  linkCheck: LinkCheck<T> | null;
  onRetry: () => void;
  /** Texto do link que não vale mais (ex.: "Peça a troca de novo em Minha conta."). */
  invalidDescription: string;
  /** Ação do link que não vale mais (padrão: entrar). */
  invalidAction?: ReactNode;
}

/**
 * Estados comuns das páginas dos links recebidos por e-mail: conferindo, link inválido (404) ou erro ao conferir.
 * Devolve null quando o link é válido (a página mostra a própria ação).
 */
export default function LinkStatus<T>({ title, linkCheck, onRetry, invalidDescription, invalidAction }: LinkStatusProps<T>) {
  const footer = <AccountLinksFooter />;
  if (!linkCheck) {
    return (
      <AuthShell title={title} footer={footer}>
        <div role="status" className="flex flex-col items-center gap-3 py-6 text-gray-500 dark:text-gray-400">
          <Loader2 size={28} className="animate-spin text-orange-600" aria-hidden="true" />
          <span className="text-sm">Conferindo o link...</span>
        </div>
      </AuthShell>
    );
  }
  if (linkCheck.status === 'invalid') {
    return (
      <AuthShell title="Link inválido" footer={footer}>
        <EmptyState
          compact
          icon={<Link2Off size={28} />}
          title="Este link não vale mais"
          description={invalidDescription}
          action={invalidAction ?? <Link to="/signin" className={buttonClass('primary')}>Entrar</Link>}
        />
      </AuthShell>
    );
  }
  if (linkCheck.status === 'error') {
    return (
      <AuthShell title={title} footer={footer}>
        <ErrorState compact message={linkCheck.message} onRetry={onRetry} />
      </AuthShell>
    );
  }
  return null;
}
