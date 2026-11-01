import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { Eye, Headset, ShieldCheck, Timer } from 'lucide-react';
import toast from 'react-hot-toast';
import ConfirmModal from '../../../components/ConfirmModal';
import { useAuth } from '../../../contexts/AuthContext';
import { getApiErrorMessage } from '../../../services/api';
import {
  SUPPORT_REASON_MAX_LENGTH, SUPPORT_REASON_MIN_LENGTH, platformSupportSessionsService, type PlatformSupportSession,
} from '../../../services/platform/supportSessionsService';
import type { PlatformStoreDetail } from '../../../services/platform/storesService';
import { homePathForUser } from '../../../utils/roles';
import { formatDateTime } from '../../../utils/format';
import ReasonField from '../Subscriptions/ReasonField';
import { reasonProblem } from '../Subscriptions/formRules';

// ---------------------------------------------------------------------------
// Iniciar sessão de suporte
// ---------------------------------------------------------------------------

interface StartSupportDialogProps {
  open: boolean;
  store: PlatformStoreDetail;
  onClose: () => void;
  /** A sessão foi aberta, mas a troca para o painel da loja falhou (a lista recarrega). */
  onFailed?: () => void;
}

/**
 * POST /platform/stores/:id/support-sessions { reason } → beginSupportSession(access_token) do AuthContext, que
 * confere o token e troca para o painel da loja (Administrador somente leitura, por tempo limitado e auditado).
 * O token nunca é exibido: ele vira a sessão do navegador e a sessão do superpainel fica guardada para a volta.
 */
export function StartSupportDialog({ open, store, onClose, onFailed }: StartSupportDialogProps) {
  if (!open) return null;
  return <StartSupportForm store={store} onClose={onClose} onFailed={onFailed} />;
}

function StartSupportForm({ store, onClose, onFailed }: Omit<StartSupportDialogProps, 'open'>) {
  const { beginSupportSession } = useAuth();
  const navigate = useNavigate();
  const [reason, setReason] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const reasonError = reasonProblem(reason, { required: true, minLength: SUPPORT_REASON_MIN_LENGTH, maxLength: SUPPORT_REASON_MAX_LENGTH });

  async function handleConfirm() {
    if (reasonError) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    let session: PlatformSupportSession | null = null;
    try {
      const started = await platformSupportSessionsService.start(store.id, reason.trim());
      session = started.session;
      const supportUser = await beginSupportSession(started.access_token);
      toast.success(`Sessão de suporte em ${store.name}: somente leitura até ${formatDateTime(started.expires_at)}.`, { duration: 6000 });
      navigate(homePathForUser(supportUser), { replace: true });
    } catch (error) {
      if (session) {
        // A sessão foi aberta, mas a troca falhou: encerra para não deixar um acesso pendurado
        await platformSupportSessionsService.end(session.id).catch(() => undefined);
        onFailed?.();
      }
      const message = error instanceof Error && !axios.isAxiosError(error)
        ? error.message
        : getApiErrorMessage(error, 'Não foi possível iniciar a sessão de suporte.');
      toast.error(message, { duration: 6000 });
      setSaving(false);
    }
  }

  return (
    <ConfirmModal
      isOpen
      onClose={onClose}
      onConfirm={handleConfirm}
      closeOnConfirm={false}
      loading={saving}
      title="Iniciar sessão de suporte?"
      message={`Você vai abrir o painel de ${store.name} como Administrador, somente leitura, por tempo limitado (duração definida nas Configurações da plataforma). O início, o fim e o motivo ficam na auditoria.`}
      confirmLabel="Iniciar e abrir o painel"
    >
      <ul className="space-y-1.5 text-sm text-gray-600 dark:text-gray-300">
        <li className="flex items-start gap-2"><Eye size={16} className="shrink-0 mt-0.5 text-blue-600 dark:text-blue-400" aria-hidden="true" /> Nada pode ser alterado durante a sessão.</li>
        <li className="flex items-start gap-2"><Timer size={16} className="shrink-0 mt-0.5 text-blue-600 dark:text-blue-400" aria-hidden="true" /> A sessão expira sozinha; encerre antes pelo aviso no topo do painel.</li>
        <li className="flex items-start gap-2"><ShieldCheck size={16} className="shrink-0 mt-0.5 text-blue-600 dark:text-blue-400" aria-hidden="true" /> Usa a sua conta (nunca a senha do lojista).</li>
      </ul>
      <ReasonField
        label="Motivo"
        required
        value={reason}
        onChange={setReason}
        minLength={SUPPORT_REASON_MIN_LENGTH}
        maxLength={SUPPORT_REASON_MAX_LENGTH}
        placeholder="Ex.: chamado 1234: conferir as zonas de entrega com o responsável."
        hint={`De ${SUPPORT_REASON_MIN_LENGTH} a ${SUPPORT_REASON_MAX_LENGTH} caracteres.`}
        showError={showErrors}
      />
    </ConfirmModal>
  );
}

// ---------------------------------------------------------------------------
// Encerrar sessão de suporte
// ---------------------------------------------------------------------------

interface EndSupportConfirmProps {
  session: PlatformSupportSession | null;
  onClose: () => void;
  onDone: (session: PlatformSupportSession) => void;
}

/** POST /platform/support-sessions/:id/end: o token da sessão deixa de valer na hora. */
export function EndSupportConfirm({ session, onClose, onDone }: EndSupportConfirmProps) {
  const [saving, setSaving] = useState(false);

  async function handleConfirm() {
    if (!session) return;
    setSaving(true);
    try {
      const ended = await platformSupportSessionsService.end(session.id);
      toast.success('Sessão de suporte encerrada.');
      onDone(ended);
      onClose();
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Não foi possível encerrar a sessão de suporte.'), { duration: 6000 });
    } finally {
      setSaving(false);
    }
  }

  return (
    <ConfirmModal
      isOpen={!!session}
      onClose={onClose}
      onConfirm={handleConfirm}
      closeOnConfirm={false}
      loading={saving}
      title="Encerrar a sessão de suporte?"
      message={`O acesso de ${session?.platform_user?.name || session?.platform_user?.email || 'quem abriu a sessão'} ao painel desta loja termina na hora: o token da sessão deixa de valer.`}
      confirmLabel="Encerrar sessão"
      isDestructive
    >
      {session && (
        <p className="flex items-start gap-2 text-xs text-gray-500 dark:text-gray-400">
          <Headset size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span>Motivo: “{session.reason}” · iniciada em {formatDateTime(session.started_at)}</span>
        </p>
      )}
    </ConfirmModal>
  );
}
