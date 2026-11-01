import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import PageLoader from '../components/PageLoader';
import { CARD_CLASS, ErrorState, buttonClass } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import { homePathForUser, isPlatformAdmin, isStaffRole, type UserRole } from '../utils/roles';
import { readLastStore, storePath, type StorePage } from '../utils/lastStore';
import { isMercadoPagoSdkPresent } from '../services/mercadoPago';

// Guardas das rotas. Só organizam a navegação: quem decide o acesso aos dados é sempre a API.

/**
 * O SDK do Mercado Pago (script de terceiros) injetado no checkout continua rodando depois de uma navegação
 * dentro do app. O painel e o superpainel (tokens da equipe e da plataforma) abrem num documento novo, sem ele.
 */
function useFreshDocumentForInternalArea(active: boolean): boolean {
  const stale = active && isMercadoPagoSdkPresent();
  useEffect(() => {
    if (stale) window.location.reload();
  }, [stale]);
  return stale;
}

/** Superpainel: só o superadministrador fora de sessão de suporte. Visitantes vão para /login; os demais, para a própria página inicial. */
export function PlatformRoute({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const reloading = useFreshDocumentForInternalArea(isPlatformAdmin(user));

  if (!user) return <Navigate to="/login" replace />;
  if (!isPlatformAdmin(user)) return <Navigate to={homePathForUser(user)} replace />;
  if (reloading) return <PageLoader />;

  return <>{children}</>;
}

/**
 * Painel da loja: exige um perfil da equipe vinculado a uma loja (inclui o superadmin em sessão de suporte).
 * Visitantes vão para /login, o superadministrador para /platform e clientes para o início do site.
 */
export function StaffRoute({ children }: { children: ReactNode }) {
  const { user, sessionChecked } = useAuth();
  const reloading = useFreshDocumentForInternalArea(!!user && !isPlatformAdmin(user) && isStaffRole(user.role));

  if (!user) return <Navigate to="/login" replace />;
  if (isPlatformAdmin(user)) return <Navigate to="/platform" replace />;
  if (!isStaffRole(user.role)) return <Navigate to="/" replace />;
  if (reloading) return <PageLoader />;

  if (user.store_id === null) {
    // Sessão salva por uma versão anterior: a loja chega na primeira conferência com a API
    if (!sessionChecked) return <PageLoader />;
    return (
      <AccessNotice
        title="Estabelecimento não identificado"
        message="Não encontramos o estabelecimento vinculado à sua conta da equipe. Verifique a conexão e tente de novo; se continuar, fale com o administrador da loja ou com o suporte da plataforma."
      />
    );
  }

  if (user.store?.account_status === 'INACTIVE') {
    return (
      <AccessNotice
        title="Estabelecimento desativado"
        message={`${user.store.name} foi desativado na plataforma e o painel não está disponível. Fale com o suporte da plataforma.`}
      />
    );
  }

  return <>{children}</>;
}

/** Página restrita a alguns perfis da loja; os demais são levados à página inicial do próprio perfil. */
export function RoleRoute({ roles, children }: { roles: UserRole[]; children: ReactNode }) {
  const { user } = useAuth();

  if (!user || !roles.includes(user.role)) return <Navigate to={homePathForUser(user)} replace />;

  return <>{children}</>;
}

/** Área da conta (Meus Pedidos, Meus Dados): exige login e volta para a mesma página depois de entrar. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { pathname, search } = useLocation();

  if (!user) return <Navigate to={`/signin?redirect=${encodeURIComponent(`${pathname}${search}`)}`} replace />;

  return <>{children}</>;
}

/**
 * Endereços da versão de loja única (/cart e /order-success): vão para a mesma página da última loja
 * visitada (mantendo o estado da navegação, ex.: o número do pedido) ou, sem loja, para o diretório.
 */
export function LastStoreRedirect({ page }: { page: StorePage }) {
  const location = useLocation();
  const [lastStore] = useState(readLastStore);

  return (
    <Navigate
      to={{ pathname: lastStore ? storePath(lastStore, page) : '/', search: location.search, hash: location.hash }}
      state={location.state}
      replace
    />
  );
}

/** Tela de acesso indisponível ao painel (sem redirecionar, para não entrar em ciclo). */
function AccessNotice({ title, message }: { title: string; message: string }) {
  const { signOut, refreshUser } = useAuth();
  const navigate = useNavigate();
  const [checking, setChecking] = useState(false);

  async function checkAgain() {
    setChecking(true);
    try {
      await refreshUser();
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gray-50 dark:bg-slate-900 transition-colors">
      <div className={`${CARD_CLASS} w-full max-w-lg`}>
        <ErrorState
          title={title}
          message={message}
          onRetry={checkAgain}
          retrying={checking}
          retryLabel="Verificar novamente"
          action={(
            <button
              type="button"
              onClick={() => {
                signOut();
                navigate('/login', { replace: true });
              }}
              className={buttonClass('secondary')}
            >
              <LogOut size={16} aria-hidden="true" /> Sair
            </button>
          )}
        />
      </div>
    </div>
  );
}
