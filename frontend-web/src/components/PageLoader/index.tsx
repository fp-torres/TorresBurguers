import { Loader2 } from 'lucide-react';

/** Indicador exibido enquanto o código de uma página é baixado (rotas carregadas sob demanda). */
export default function PageLoader() {
  return (
    <div className="min-h-[40vh] flex flex-col items-center justify-center gap-3 text-gray-400 dark:text-gray-500" role="status">
      <Loader2 className="animate-spin text-orange-600" size={32} />
      <span className="text-sm">Carregando...</span>
    </div>
  );
}
