import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { AlertTriangle, CalendarClock, Headset, Info, LogOut, ShieldAlert } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { BRAND } from '../../config/brand';
import { formatDateTime } from '../../utils/format';
import { cx } from '../../components/ui';
import { isBillingAvailability, isBlockedAvailability } from '../../services/storeAccess';
import { usePanelStore } from './panelStore';
import { daysUntil, formatDate } from '../../utils/dates';
import { useNow } from '../../hooks/useNow';

type NoticeTone = 'info' | 'warning' | 'danger';

const TONE_CLASSES: Record<NoticeTone, string> = {
  info: 'bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200 border-blue-200 dark:border-blue-800',
  warning: 'bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  danger: 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 border-red-200 dark:border-red-800',
};

const LINK_CLASSES = 'font-bold underline underline-offset-2 hover:no-underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-current whitespace-nowrap';

// Avisos de teste grátis acabando: a partir de 7 dias do fim
const TRIAL_WARNING_DAYS = 7;

function NoticeBar({ tone, icon, children, action, live = false }: { tone: NoticeTone; icon: ReactNode; children: ReactNode; action?: ReactNode; live?: boolean }) {
  return (
    <div
      role={live ? 'alert' : undefined}
      className={cx('shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 lg:px-8 py-2.5 text-sm border-b', TONE_CLASSES[tone])}
    >
      <span className="shrink-0" aria-hidden="true">{icon}</span>
      <p className="flex-1 min-w-48">{children}</p>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/**
 * Faixas de aviso do painel: sessão de suporte, loja/assinatura que impede vender ou alterar, cancelamento
 * agendado e fim do teste grátis. O Administrador recebe a situação da API (access.message); os demais
 * perfis, a situação cadastral da loja na sessão (user.store.account_status).
 */
export default function StoreNotices() {
  const { user, endSupportSession } = useAuth();
  const panel = usePanelStore();
  const navigate = useNavigate();
  const now = useNow();
  const [endingSupport, setEndingSupport] = useState(false);

  const store = user?.store ?? null;
  const supportSession = user?.support_session ?? null;
  const isAdmin = user?.role === 'ADMIN';

  async function handleEndSupport() {
    setEndingSupport(true);
    try {
      if (await endSupportSession()) {
        navigate('/platform', { replace: true });
      } else {
        // A sessão do superpainel fica só na memória da aba que abriu o suporte (não sobrevive a recarregar)
        toast('Sessão de suporte encerrada neste navegador. Entre novamente para voltar ao superpainel.', {
          icon: '🛟', id: 'support-ended', duration: 8000,
        });
        navigate('/login', { replace: true });
      }
    } finally {
      setEndingSupport(false);
    }
  }

  const notices: ReactNode[] = [];

  // Acesso assistido do suporte: somente leitura e por tempo limitado
  if (supportSession) {
    notices.push(
      <NoticeBar
        key="support"
        tone="info"
        icon={<Headset size={18} />}
        action={(
          <button
            type="button"
            onClick={handleEndSupport}
            disabled={endingSupport}
            className="inline-flex items-center gap-1.5 font-bold hover:underline disabled:opacity-60 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <LogOut size={14} aria-hidden="true" /> Encerrar e voltar ao superpainel
          </button>
        )}
      >
        <span className="font-bold">Sessão de suporte</span> em {store?.name ?? 'um estabelecimento'}: somente leitura, até {formatDateTime(supportSession.expires_at)}.
      </NoticeBar>,
    );
  }

  const access = panel.access;
  if (access?.message) {
    // Situação informada pela API (Administrador): inadimplência na tolerância (aviso) ou bloqueio de vendas
    const blocked = isBlockedAvailability(access.availability);
    const billing = isBillingAvailability(access.availability);
    notices.push(
      <NoticeBar
        key="access"
        tone={blocked ? 'danger' : 'warning'}
        icon={blocked ? <ShieldAlert size={18} /> : <AlertTriangle size={18} />}
        live={blocked}
        action={billing && isAdmin ? (
          <Link to="/subscription" className={LINK_CLASSES}>{access.availability === 'PAST_DUE' ? 'Regularizar pagamento' : 'Ver assinatura'}</Link>
        ) : !billing ? (
          <a href={`mailto:${BRAND.supportEmail}`} className={LINK_CLASSES}>Falar com o suporte</a>
        ) : undefined}
      >
        {access.message}
        {blocked && !access.canManage && ' Cardápio, equipe e configurações ficam somente para consulta.'}
      </NoticeBar>,
    );
  } else if (!access && store?.account_status === 'SUSPENDED') {
    // Sem a situação detalhada (perfis sem acesso a /store/settings): a sessão já diz que a loja está suspensa
    notices.push(
      <NoticeBar key="suspended" tone="warning" icon={<AlertTriangle size={18} />}>
        <span className="font-bold">Estabelecimento suspenso.</span> A vitrine não aceita novos pedidos; os pedidos em andamento podem ser concluídos.
      </NoticeBar>,
    );
  }

  // Avisos da assinatura (só quando a loja está em ordem, para não empilhar faixas)
  const subscription = panel.subscription?.subscription ?? null;
  if (isAdmin && !access?.message && subscription && subscription.status !== 'CANCELED') {
    if (subscription.cancel_at_period_end) {
      // Agendado pela administração da plataforma: só o suporte desfaz (a API responde 409 à loja)
      const byPlatform = subscription.cancel_scheduled_by === 'PLATFORM';
      notices.push(
        <NoticeBar
          key="cancel-scheduled"
          tone="info"
          icon={<CalendarClock size={18} />}
          action={byPlatform
            ? <a href={`mailto:${BRAND.supportEmail}`} className={LINK_CLASSES}>Falar com o suporte</a>
            : <Link to="/subscription" className={LINK_CLASSES}>Desistir do cancelamento</Link>}
        >
          <span className="font-bold">
            {byPlatform ? 'Cancelamento agendado pela administração da plataforma.' : 'Cancelamento agendado.'}
          </span>{' '}
          {subscription.current_period_end
            ? `A assinatura termina em ${formatDate(subscription.current_period_end)}; depois disso a loja deixa de vender.`
            : 'A assinatura termina no fim do período atual; depois disso a loja deixa de vender.'}
          {byPlatform && ' Para mantê-la, fale com o suporte.'}
        </NoticeBar>,
      );
    } else if (subscription.status === 'TRIALING' && subscription.trial_ends_at) {
      const days = daysUntil(subscription.trial_ends_at, now);
      if (days !== null && days <= TRIAL_WARNING_DAYS) {
        notices.push(
          <NoticeBar
            key="trial"
            tone="info"
            icon={<Info size={18} />}
            action={<Link to="/subscription" className={LINK_CLASSES}>Ver plano</Link>}
          >
            <span className="font-bold">Teste grátis</span>{' '}
            {days === 0 ? 'termina hoje' : `termina em ${days} ${days === 1 ? 'dia' : 'dias'}`} ({formatDate(subscription.trial_ends_at)}).
          </NoticeBar>,
        );
      }
    }
  }

  if (notices.length === 0) return null;
  return <div className="shrink-0" aria-label="Avisos do estabelecimento" role="region">{notices}</div>;
}
