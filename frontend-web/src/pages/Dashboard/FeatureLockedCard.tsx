import { Link } from 'react-router-dom';
import { BarChart3, Lock } from 'lucide-react';
import { CARD_CLASS, buttonClass, cx } from '../../components/ui';

interface FeatureLockedCardProps {
  /** Mensagem do 403 da API (ex.: "O plano Essencial não inclui relatórios e gráficos."). */
  message?: string | null;
  className?: string;
}

/** Gráficos e relatórios fora do plano: explica o recurso e leva à Assinatura. */
export default function FeatureLockedCard({ message, className }: FeatureLockedCardProps) {
  return (
    <section aria-labelledby="reports-locked-title" className={cx(CARD_CLASS, 'p-5 sm:p-6 flex flex-col md:flex-row md:items-center gap-5', className)}>
      <div className="relative shrink-0 w-fit p-4 rounded-2xl bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400" aria-hidden="true">
        <BarChart3 size={32} />
        <span className="absolute -bottom-1 -right-1 p-1 rounded-full bg-white dark:bg-slate-800 border border-orange-200 dark:border-orange-800">
          <Lock size={12} />
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <h2 id="reports-locked-title" className="text-lg font-bold text-gray-800 dark:text-white">Relatórios e gráficos</h2>
        <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
          {message || 'O plano atual não inclui relatórios e gráficos.'}{' '}
          Com o recurso, o Dashboard mostra o faturamento por dia, os produtos campeões e as vendas por forma de pagamento e por
          situação, em qualquer período de até um ano.
        </p>
      </div>
      <Link to="/subscription" className={buttonClass('primary', 'md', 'shrink-0')}>Ver plano e assinatura</Link>
    </section>
  );
}
