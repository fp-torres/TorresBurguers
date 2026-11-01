import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import BrandLogo from '../../../components/BrandLogo';

interface AuthShellProps {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  /** Links abaixo do cartão (ex.: "Voltar ao login"). */
  footer?: ReactNode;
  /** Link de volta acima do logo. */
  back?: { to: string; label: string };
}

/** Moldura das telas de conta (recuperação de senha, convite, cadastro de loja): marca, título e cartão central. */
export default function AuthShell({ title, subtitle, children, footer, back }: AuthShellProps) {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950 flex flex-col items-center justify-center p-4 sm:p-6 transition-colors duration-300">
      <main className="w-full max-w-md space-y-6 my-8 animate-in fade-in slide-in-from-bottom-4">
        {back && (
          <Link to={back.to} className="text-gray-500 dark:text-gray-400 flex items-center gap-2 w-fit hover:text-orange-600 dark:hover:text-orange-400 transition-colors">
            <ArrowLeft size={20} aria-hidden="true" /> {back.label}
          </Link>
        )}

        <div className="text-center">
          <Link to="/" className="inline-flex mb-5 hover:opacity-90 transition-opacity" aria-label="Página inicial">
            <BrandLogo size={44} />
          </Link>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white">{title}</h1>
          {subtitle && <div className="text-gray-500 dark:text-gray-400 mt-2">{subtitle}</div>}
        </div>

        <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 p-6 sm:p-8 text-gray-700 dark:text-gray-200">
          {children}
        </div>

        {footer && <div className="text-center text-sm text-gray-600 dark:text-gray-400 space-y-2">{footer}</div>}
      </main>
    </div>
  );
}
