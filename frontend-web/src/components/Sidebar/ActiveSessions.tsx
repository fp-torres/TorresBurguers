import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Headset, Loader2, LogOut, MonitorSmartphone, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import ConfirmModal from '../ConfirmModal';
import { EmptyState, ErrorState, Pagination, StatusBadge, buttonClass, cx } from '../ui';
import { useAuth } from '../../contexts/AuthContext';
import { usePaginatedQuery } from '../../hooks/usePaginatedQuery';
import { getApiErrorMessage, getApiErrorStatus } from '../../services/api';
import { authService, type AuthSessionInfo } from '../../services/authService';
import { formatDateTime } from '../../utils/format';

const PAGE_SIZE = 10;

interface ActiveSessionsProps {
  /** Login para onde voltar depois de "Sair de todos os aparelhos" (o da loja ou o da equipe). */
  loginPath: string;
  className?: string;
}

/**
 * "Sessões ativas" da própria conta (GET /auth/sessions): cada aparelho ou navegador conectado, o deste navegador
 * primeiro, com "Encerrar" nos outros e "Sair de todos os aparelhos". Usado em "Meus Dados" do cliente e no menu do
 * painel e do superpainel. Numa sessão de suporte (somente leitura) não aparece.
 */
export default function ActiveSessions({ loginPath, className }: ActiveSessionsProps) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [ending, setEnding] = useState<number | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [endingAll, setEndingAll] = useState(false);
  const inSupport = !!user?.support_session;

  const query = usePaginatedQuery<AuthSessionInfo>({
    // Carga em segundo plano (como a conferência do perfil): um 401 aqui não encerra a sessão; a próxima ação
    // do usuário com o token inválido encerra
    fetcher: ({ page, pageSize, signal }) => authService.listSessions(page, pageSize, { signal, keepSessionOn401: true }),
    initialPageSize: PAGE_SIZE,
    errorMessage: 'Não foi possível carregar as sessões.',
    enabled: !!user && !inSupport,
  });

  if (!user || inSupport) return null;

  async function handleEnd(session: AuthSessionInfo) {
    setEnding(session.id);
    try {
      await authService.revokeSession(session.id);
      toast.success('Sessão encerrada. Aquele aparelho precisará entrar de novo.');
    } catch (error) {
      // Já encerrada (em outro lugar) ou vencida: a lista atualizada mostra a situação real
      if (getApiErrorStatus(error) !== 404) {
        toast.error(getApiErrorMessage(error, 'Não foi possível encerrar a sessão.'));
      }
    } finally {
      setEnding(null);
      void query.reload({ silent: true });
    }
  }

  async function handleEndAll() {
    setEndingAll(true);
    try {
      await authService.logoutAll();
      setConfirmAll(false);
      signOut({ keepLocalData: true });
      toast.success('Você saiu de todos os aparelhos. Entre novamente para continuar.');
      navigate(loginPath, { replace: true });
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Não foi possível encerrar as sessões.'));
    } finally {
      setEndingAll(false);
    }
  }

  return (
    <section aria-labelledby="active-sessions-title" className={cx('space-y-4', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="active-sessions-title" className="text-lg font-bold text-gray-800 dark:text-white flex items-center gap-2">
            <MonitorSmartphone size={20} aria-hidden="true" className="text-orange-600 dark:text-orange-400" /> Sessões ativas
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Aparelhos e navegadores conectados à sua conta. Encerre os que você não reconhece.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void query.reload()}
          disabled={query.loading || query.refreshing}
          className={buttonClass('ghost', 'icon')}
          aria-label="Atualizar a lista de sessões"
          title="Atualizar"
        >
          <RefreshCw size={16} aria-hidden="true" className={query.refreshing ? 'animate-spin' : undefined} />
        </button>
      </div>

      {query.error && query.items.length === 0 ? (
        <ErrorState compact message={query.error} onRetry={() => void query.reload()} retrying={query.loading} />
      ) : query.loading && query.items.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400" role="status">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Carregando sessões...
        </p>
      ) : query.items.length === 0 ? (
        <EmptyState compact title="Nenhuma sessão ativa" description="Entre de novo para ver este navegador aqui." />
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-slate-700 rounded-2xl border border-gray-100 dark:border-slate-700">
          {query.items.map((session) => (
            <li key={session.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0 space-y-1">
                <p className="font-semibold text-gray-800 dark:text-white flex flex-wrap items-center gap-2">
                  {session.kind === 'SUPPORT' && <Headset size={16} aria-hidden="true" className="text-blue-600 dark:text-blue-400" />}
                  <span className="wrap-break-word">{session.kind === 'SUPPORT' ? `Sessão de suporte · ${session.browser}` : session.browser}</span>
                  {session.current && <StatusBadge tone="success">Este navegador</StatusBadge>}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Desde {formatDateTime(session.created_at)}
                  {session.ip ? ` · IP ${session.ip}` : ''}
                  {` · expira em ${formatDateTime(session.expires_at)}`}
                </p>
              </div>
              {!session.current && (
                <button
                  type="button"
                  onClick={() => void handleEnd(session)}
                  disabled={ending !== null || endingAll}
                  className={buttonClass('secondary', 'sm')}
                  aria-label={`Encerrar a sessão ${session.browser} iniciada em ${formatDateTime(session.created_at)}`}
                >
                  {ending === session.id ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <LogOut size={14} aria-hidden="true" />}
                  Encerrar
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {query.total > query.pageSize && (
        <Pagination
          page={query.page}
          pageSize={query.pageSize}
          total={query.total}
          onPageChange={query.setPage}
          disabled={query.loading}
          itemLabel="sessões"
        />
      )}

      <button
        type="button"
        onClick={() => setConfirmAll(true)}
        disabled={endingAll}
        className={buttonClass('ghost', 'sm', 'text-red-600 dark:text-red-400')}
      >
        <LogOut size={14} aria-hidden="true" /> Sair de todos os aparelhos
      </button>

      <ConfirmModal
        isOpen={confirmAll}
        onClose={() => setConfirmAll(false)}
        onConfirm={() => void handleEndAll()}
        title="Sair de todos os aparelhos?"
        message="Todas as sessões da sua conta serão encerradas, inclusive a deste navegador. Você precisará entrar de novo em cada aparelho."
        confirmLabel="Sair de todos"
        isDestructive
        loading={endingAll}
        closeOnConfirm={false}
      />
    </section>
  );
}
