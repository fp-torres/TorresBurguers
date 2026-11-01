import toast from 'react-hot-toast';
import { Link } from 'react-router-dom';

/**
 * Aviso de limite/recurso do plano (403 da API, ex.: "Limite do plano Essencial atingido: 5 usuários da
 * equipe.") com o atalho para a tela Assinatura. Só o Administrador acessa a Assinatura (showPlanLink).
 */
export function toastPlanLimit(message: string, showPlanLink = true): void {
  toast.error(
    (current) => (
      <span className="text-sm">
        {message}
        {showPlanLink && (
          <>
            {' '}
            <Link
              to="/subscription"
              onClick={() => toast.dismiss(current.id)}
              className="font-bold text-orange-600 dark:text-orange-400 underline underline-offset-2"
            >
              Ver plano e limites
            </Link>
          </>
        )}
      </span>
    ),
    { id: 'plan-limit', duration: 8000 },
  );
}
