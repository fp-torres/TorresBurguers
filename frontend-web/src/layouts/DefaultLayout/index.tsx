import { lazy, Suspense } from 'react';
import PageLoader from '../../components/PageLoader';

// O painel da loja (menu, cabeçalho, avisos, status e situação da loja, com os serviços que eles usam)
// é baixado só por quem entra nele: a vitrine e o diretório de lojas não carregam este código.
const PanelShell = lazy(() => import('./PanelShell'));

/**
 * Layout do painel da loja (equipe). A rota (StaffRoute) só o renderiza para um usuário da equipe
 * vinculado a uma loja; a loja vem SEMPRE do token (o front nunca envia store_id). Ver PanelShell.
 */
export default function DefaultLayout() {
  return (
    <Suspense
      fallback={(
        <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-900 transition-colors">
          <PageLoader />
        </div>
      )}
    >
      <PanelShell />
    </Suspense>
  );
}
