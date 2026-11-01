import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { CARD_CLASS, cx } from './styles';

export interface PageHeaderProps {
  /** Título da página (renderizado como h1). */
  title: ReactNode;
  subtitle?: ReactNode;
  /** Ícone decorativo ao lado do título. */
  icon?: ReactNode;
  /** Botões e links de ação (à direita; abaixo do título em telas estreitas). */
  actions?: ReactNode;
  /** Link de volta (ex.: da página de detalhe para a lista). */
  back?: { to: string; label?: string };
  /** Conteúdo extra abaixo do título (ex.: abas ou filtros). */
  children?: ReactNode;
  className?: string;
}

/** Cabeçalho das páginas do painel e do superpainel: título, subtítulo e ações. */
export default function PageHeader({ title, subtitle, icon, actions, back, children, className }: PageHeaderProps) {
  return (
    <div className={cx(CARD_CLASS, 'p-5 sm:p-6', className)}>
      {back && (
        <Link
          to={back.to}
          className="inline-flex items-center gap-1.5 mb-3 text-sm font-semibold text-gray-500 dark:text-gray-400 hover:text-orange-600 dark:hover:text-orange-400 transition-colors rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
        >
          <ArrowLeft size={16} aria-hidden="true" /> {back.label ?? 'Voltar'}
        </Link>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          {icon && (
            <div className="shrink-0 p-2.5 rounded-xl bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400" aria-hidden="true">
              {icon}
            </div>
          )}
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-gray-800 dark:text-white wrap-break-word">{title}</h1>
            {subtitle && <p className="text-sm sm:text-base text-gray-500 dark:text-gray-400 mt-0.5">{subtitle}</p>}
          </div>
        </div>

        {actions && <div className="flex flex-wrap items-center gap-2 sm:justify-end shrink-0">{actions}</div>}
      </div>

      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}
