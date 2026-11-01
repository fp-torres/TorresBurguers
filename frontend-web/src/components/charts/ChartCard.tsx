import { useId, type ReactNode } from 'react';
import { CARD_CLASS, cx } from '../ui/styles';

export interface ChartCardProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  /** Selo/ação à direita do título (ex.: "Últimos 7 dias", botão de metodologia). */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Cartão de um gráfico ou lista (painel da loja e superpainel): título (h3), descrição e conteúdo. */
export default function ChartCard({ title, description, icon, aside, children, className }: ChartCardProps) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className={cx(CARD_CLASS, 'p-5 sm:p-6 min-w-0 flex flex-col', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="font-bold text-gray-800 dark:text-white flex items-center gap-2">
            {icon && <span aria-hidden="true" className="inline-flex shrink-0">{icon}</span>}
            {title}
          </h3>
          {description && <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{description}</div>}
        </div>
        {aside && <div className="shrink-0 flex items-center gap-2">{aside}</div>}
      </div>
      <div className="flex-1 min-w-0">{children}</div>
    </section>
  );
}
