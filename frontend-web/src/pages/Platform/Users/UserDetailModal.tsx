import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { History, KeyRound, Lock, LogOut, MailCheck, ShieldCheck, Trash2, Unlock } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  CopyField, ErrorState, FormField, Modal, StatusBadge, buttonClass, cx, fieldControlClass,
} from '../../../components/ui';
import ConfirmModal from '../../../components/ConfirmModal';
import PageLoader from '../../../components/PageLoader';
import { useResource } from '../../../hooks/useResource';
import { avatarUrl, getApiErrorMessage, getApiErrorStatus } from '../../../services/api';
import type { AuditLogEntry } from '../../../services/platform/auditService';
import { platformUsersService, type PasswordResetLink, type PlatformUserDetail } from '../../../services/platform/usersService';
import { formatDateTime } from '../../../utils/format';
import { platformRoleLabel, roleLabel } from '../../../utils/roles';
import { STORE_ACCOUNT_STATUS, statusMeta } from '../../../utils/saasStatus';
import AuditDetailModal from '../Audit/AuditDetailModal';
import AuditLink from '../Audit/AuditLink';
import AuditLogTable from '../Audit/AuditLogTable';
import { userToOption, type PickerOption } from '../Audit/pickerOptions';
import { auditUrl } from '../Audit/urlFilters';
import { AVATAR_CLASSES, PLATFORM_AVATAR_CLASS, accountStatus, initials } from './userLabels';

/** Tamanho máximo do motivo do bloqueio (BlockUserDto). */
const BLOCK_REASON_MAX = 300;

type PendingAction = 'block' | 'unblock' | 'revoke' | 'reset';

interface UserDetailModalProps {
  /** Conta aberta (null = fechado). */
  userId: number | null;
  /** Conta logada: não pode bloquear a si mesma nem encerrar a própria sessão por aqui. */
  currentUserId: number | null;
  onClose: () => void;
  /** Algo mudou (bloqueio, desbloqueio, sessões): a lista atualiza. */
  onChanged: () => void;
  /** "Ver todos os eventos" desta conta (aba Eventos filtrada). */
  onShowEvents: (account: PickerOption) => void;
}

/**
 * Detalhe de uma conta no superpainel (GET /platform/users/:id): perfil, vínculo, bloqueio, lixeira e os
 * eventos de autenticação recentes, com as ações de acesso — bloquear (motivo obrigatório), desbloquear,
 * encerrar sessões e gerar link de redefinição de senha (exibido uma única vez). Tudo com confirmação.
 * Links para a auditoria: ações sobre a conta (alvo user) e ações feitas por ela (autor).
 */
export default function UserDetailModal({ userId, currentUserId, onClose, onChanged, onShowEvents }: UserDetailModalProps) {
  const resource = useResource((signal) => platformUsersService.detail(userId ?? 0, signal), {
    key: String(userId ?? ''),
    enabled: userId !== null,
    errorMessage: 'Não foi possível carregar a conta.',
  });
  // Só os dados DESTA conta (ao trocar de conta, os da anterior não aparecem)
  const detail = resource.data && resource.data.id === userId ? resource.data : null;

  return (
    <Modal
      open={userId !== null}
      onClose={onClose}
      size="xl"
      title={detail ? detail.name || detail.email : 'Conta'}
      description={detail ? `${detail.email} · conta #${detail.id}` : undefined}
      footer={<button type="button" onClick={onClose} className={buttonClass('secondary')}>Fechar</button>}
    >
      {userId !== null && (
        detail ? (
          <UserDetailBody
            key={detail.id}
            detail={detail}
            currentUserId={currentUserId}
            refreshing={resource.loading || resource.refreshing}
            onUpdated={(next) => resource.setData(next)}
            onReload={() => void resource.reload({ silent: true })}
            onChanged={onChanged}
            onShowEvents={onShowEvents}
          />
        ) : resource.error ? (
          <ErrorState
            compact
            title={resource.errorStatus === 404 ? 'Conta não encontrada' : undefined}
            message={resource.errorStatus === 404 ? 'A conta não existe mais ou o endereço está errado.' : resource.error}
            onRetry={resource.errorStatus === 404 ? undefined : () => void resource.reload()}
            retrying={resource.loading}
          />
        ) : (
          <PageLoader />
        )
      )}
    </Modal>
  );
}

function InfoItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 p-3 rounded-xl bg-gray-50 dark:bg-slate-800 border border-gray-100 dark:border-slate-700">
      <dt className="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="mt-1 text-sm font-semibold text-gray-800 dark:text-gray-100 wrap-break-word">{children}</dd>
    </div>
  );
}

interface UserDetailBodyProps {
  detail: PlatformUserDetail;
  currentUserId: number | null;
  refreshing: boolean;
  onUpdated: (detail: PlatformUserDetail) => void;
  onReload: () => void;
  onChanged: () => void;
  onShowEvents: (account: PickerOption) => void;
}

function UserDetailBody({ detail, currentUserId, refreshing, onUpdated, onReload, onChanged, onShowEvents }: UserDetailBodyProps) {
  const actionsTitleId = useId();
  const eventsTitleId = useId();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [resetLink, setResetLink] = useState<PasswordResetLink | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<AuditLogEntry | null>(null);

  const isSelf = detail.id === currentUserId;
  const deleted = !!detail.deleted_at;
  const blocked = !!detail.blocked_at;
  const status = accountStatus(detail);
  const avatar = avatarUrl(detail.avatar);
  const displayName = detail.name || detail.email;

  const blockDisabledReason = deleted
    ? 'Conta na lixeira.'
    : isSelf ? 'Você não pode bloquear a própria conta.' : null;
  const revokeDisabledReason = deleted
    ? 'Conta na lixeira.'
    : isSelf ? 'Isso encerraria a sua própria sessão no superpainel.' : null;
  // Contas da plataforma não recebem link pelo superpainel (a API responde 403): quem assume o link
  // teria acesso de superadministrador
  const resetDisabledReason = deleted
    ? 'Conta na lixeira.'
    : detail.platform_role ? 'Contas da plataforma: Esqueci minha senha ou comando platform:superadmin.' : null;

  function closeConfirm() {
    if (busy) return;
    setPending(null);
    setReason('');
  }

  async function run(action: PendingAction) {
    setBusy(true);
    try {
      if (action === 'block') {
        const next = await platformUsersService.block(detail.id, reason);
        onUpdated(next);
        toast.success('Conta bloqueada: o login foi recusado e as sessões abertas foram encerradas.');
      } else if (action === 'unblock') {
        const next = await platformUsersService.unblock(detail.id);
        onUpdated(next);
        toast.success('Conta desbloqueada: a pessoa já pode entrar de novo.');
      } else if (action === 'revoke') {
        const result = await platformUsersService.revokeSessions(detail.id);
        if (result.user) onUpdated(result.user);
        toast.success(result.message);
      } else {
        const link = await platformUsersService.passwordResetLink(detail.id);
        setResetLink(link);
        toast.success(link.url
          ? 'Link de redefinição gerado. Copie e envie por um canal seguro.'
          : 'Link de redefinição enviado ao e-mail da conta.');
      }
      setPending(null);
      setReason('');
      if (action !== 'reset') onChanged();
    } catch (error) {
      const fallback = {
        block: 'Não foi possível bloquear a conta.',
        unblock: 'Não foi possível desbloquear a conta.',
        revoke: 'Não foi possível encerrar as sessões.',
        reset: 'Não foi possível gerar o link de redefinição.',
      }[action];
      toast.error(getApiErrorMessage(error, fallback), { duration: 6000 });
      // 404: a conta mudou (ex.: foi para a lixeira) — os dados são recarregados
      if (getApiErrorStatus(error) === 404) {
        setPending(null);
        onReload();
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  }

  const storeStatus = detail.store ? statusMeta(STORE_ACCOUNT_STATUS, detail.store.account_status) : null;

  return (
    <div className={cx('space-y-6 transition-opacity', refreshing && 'opacity-80')}>
      {/* Identificação */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        {avatar ? (
          <img src={avatar} alt="" className="w-16 h-16 shrink-0 rounded-full object-cover border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700" />
        ) : (
          <span
            aria-hidden="true"
            className={cx(
              'w-16 h-16 shrink-0 rounded-full flex items-center justify-center text-xl font-bold',
              detail.platform_role ? PLATFORM_AVATAR_CLASS : AVATAR_CLASSES[detail.role] ?? AVATAR_CLASSES.CLIENT,
            )}
          >
            {initials(detail.name, detail.email)}
          </span>
        )}
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap gap-2">
            <StatusBadge tone={status.tone} dot>{status.label}</StatusBadge>
            {detail.platform_role
              ? <StatusBadge tone="warning" icon={<ShieldCheck size={12} />}>{platformRoleLabel(detail.platform_role)}</StatusBadge>
              : <StatusBadge tone={detail.role === 'CLIENT' ? 'neutral' : 'info'}>{roleLabel(detail.role)}</StatusBadge>}
            {detail.is_owner && <StatusBadge tone="info">Responsável pela loja</StatusBadge>}
            {isSelf && <StatusBadge tone="neutral">Você</StatusBadge>}
          </div>
          {blocked && (
            <p className="text-sm text-red-700 dark:text-red-300">
              <span className="font-bold">Bloqueada em {formatDateTime(detail.blocked_at)}</span>
              {detail.blocked_reason ? `: ${detail.blocked_reason}` : ' (sem motivo registrado).'}
            </p>
          )}
          {deleted && (
            <p className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-300">
              <Trash2 size={14} aria-hidden="true" /> Na lixeira desde {formatDateTime(detail.deleted_at)}.
            </p>
          )}
        </div>
      </div>

      <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <InfoItem label="Estabelecimento">
          {detail.store ? (
            <span className="flex flex-wrap items-center gap-2">
              <Link
                to={`/platform/stores/${detail.store.id}`}
                className="text-orange-700 dark:text-orange-400 hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
              >
                {detail.store.name}
              </Link>
              {storeStatus && detail.store.account_status !== 'ACTIVE' && <StatusBadge tone={storeStatus.tone}>{storeStatus.label}</StatusBadge>}
            </span>
          ) : (
            <span className="font-normal text-gray-600 dark:text-gray-300">
              {detail.platform_role ? 'Administração da plataforma' : detail.role === 'CLIENT' ? 'Cliente (compra em qualquer loja)' : 'Sem loja'}
            </span>
          )}
        </InfoItem>
        <InfoItem label="Telefone">{detail.phone || <span className="font-normal text-gray-500 dark:text-gray-400">Não informado</span>}</InfoItem>
        <InfoItem label="Último acesso">
          {detail.last_login_at ? formatDateTime(detail.last_login_at) : <span className="font-normal text-gray-500 dark:text-gray-400">Nunca entrou</span>}
        </InfoItem>
        <InfoItem label="Conta criada em">{formatDateTime(detail.created_at)}</InfoItem>
        <InfoItem label="Última alteração">{formatDateTime(detail.updated_at)}</InfoItem>
        <InfoItem label="E-mail">{detail.email}</InfoItem>
      </dl>

      {/* Auditoria: ações sobre a conta (alvo user) e ações feitas por ela (autor) */}
      <div className="flex flex-wrap items-center gap-2">
        <AuditLink to={auditUrl({ target_type: 'user', target_id: detail.id })} label={`Ver auditoria da conta de ${displayName} (ações sobre a conta)`}>
          Ver auditoria
        </AuditLink>
        <AuditLink to={auditUrl({ actor_id: detail.id })} label={`Ações feitas por esta conta (${displayName}) na auditoria`} variant="ghost">
          Ações feitas por esta conta
        </AuditLink>
      </div>

      {/* Ações de acesso */}
      <section aria-labelledby={actionsTitleId} className="space-y-3">
        <div>
          <h3 id={actionsTitleId} className="text-base font-bold text-gray-800 dark:text-white">Acesso da conta</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">Cada ação pede confirmação e fica registrada na auditoria com o seu usuário.</p>
        </div>

        {deleted && (
          <p className="px-3 py-2 rounded-xl text-sm bg-gray-50 dark:bg-slate-800 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-slate-700">
            Conta na lixeira: bloqueio, encerramento de sessões e redefinição de senha não se aplicam enquanto ela não for restaurada.
          </p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="p-4 rounded-xl border border-gray-100 dark:border-slate-700 space-y-2">
            {blocked ? (
              <button
                type="button"
                onClick={() => setPending('unblock')}
                disabled={!!blockDisabledReason}
                className={buttonClass('secondary', 'md', 'w-full')}
              >
                <Unlock size={16} aria-hidden="true" /> Desbloquear
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setPending('block')}
                disabled={!!blockDisabledReason}
                className={buttonClass('danger', 'md', 'w-full')}
              >
                <Lock size={16} aria-hidden="true" /> Bloquear
              </button>
            )}
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {blockDisabledReason ?? (blocked
                ? 'Libera o login de novo (as sessões antigas continuam encerradas).'
                : 'Recusa o login e encerra as sessões abertas na hora. Exige um motivo.')}
            </p>
          </div>
          <div className="p-4 rounded-xl border border-gray-100 dark:border-slate-700 space-y-2">
            <button
              type="button"
              onClick={() => setPending('revoke')}
              disabled={!!revokeDisabledReason}
              className={buttonClass('secondary', 'md', 'w-full')}
            >
              <LogOut size={16} aria-hidden="true" /> Encerrar sessões
            </button>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {revokeDisabledReason ?? 'Desconecta a conta de todos os dispositivos; a senha não muda.'}
            </p>
          </div>
          <div className="p-4 rounded-xl border border-gray-100 dark:border-slate-700 space-y-2">
            <button
              type="button"
              onClick={() => setPending('reset')}
              disabled={!!resetDisabledReason}
              className={buttonClass('secondary', 'md', 'w-full')}
            >
              <KeyRound size={16} aria-hidden="true" /> Link de nova senha
            </button>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {resetDisabledReason ?? 'Gera um link de uso único para a pessoa criar uma senha nova (com o envio de e-mails configurado, ele vai direto para o e-mail da conta).'}
            </p>
          </div>
        </div>

        {resetLink && (
          <div className="p-4 rounded-xl border border-orange-200 dark:border-orange-900/60 bg-orange-50/50 dark:bg-orange-900/10 space-y-2">
            {resetLink.url ? (
              <CopyField
                label="Link de redefinição de senha"
                value={resetLink.url}
                notice={resetLink.message || undefined}
              />
            ) : (
              // Enviado só ao e-mail da conta: o operador nunca vê o link
              <p role="status" className="flex items-start gap-2 text-sm text-gray-800 dark:text-gray-100">
                <MailCheck size={18} className="shrink-0 mt-0.5 text-orange-600 dark:text-orange-400" aria-hidden="true" />
                <span>{resetLink.message || 'Link de redefinição enviado ao e-mail da conta.'}</span>
              </p>
            )}
            {resetLink.expires_at && (
              <p className="text-xs text-gray-600 dark:text-gray-300">
                Vale até <span className="font-bold">{formatDateTime(resetLink.expires_at)}</span>, uma única vez.
                {blocked && ' A conta está bloqueada: mesmo com a senha nova, ela só entra depois de desbloqueada.'}
              </p>
            )}
            <button type="button" onClick={() => setResetLink(null)} className={buttonClass('ghost', 'sm')}>
              {resetLink.url ? 'Já copiei, ocultar o link' : 'Ocultar aviso'}
            </button>
          </div>
        )}
      </section>

      {/* Eventos de autenticação recentes */}
      <section aria-labelledby={eventsTitleId} className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 id={eventsTitleId} className="text-base font-bold text-gray-800 dark:text-white flex items-center gap-2">
              <History size={18} className="text-orange-600 dark:text-orange-400" aria-hidden="true" /> Eventos de autenticação recentes
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Os 20 mais recentes em que a conta é autora, alvo ou o e-mail foi usado numa tentativa.
            </p>
          </div>
          <button type="button" onClick={() => onShowEvents(userToOption(detail))} className={buttonClass('secondary', 'sm')}>
            Ver todos os eventos
          </button>
        </div>
        <AuditLogTable
          variant="auth"
          caption={`Eventos de autenticação recentes de ${displayName}`}
          rows={detail.recent_auth_events}
          loading={false}
          error={null}
          onRetry={onReload}
          onSelect={setSelectedEvent}
          emptyTitle="Nenhum evento de autenticação"
          emptyDescription="Logins, falhas, saídas de todos os dispositivos e redefinições de senha desta conta aparecem aqui."
          scrollClassName="max-h-80"
        />
      </section>

      <AuditDetailModal entry={selectedEvent} onClose={() => setSelectedEvent(null)} />

      <ConfirmModal
        isOpen={pending === 'block'}
        onClose={closeConfirm}
        onConfirm={() => void run('block')}
        closeOnConfirm={false}
        loading={busy}
        isDestructive
        title="Bloquear a conta?"
        confirmLabel="Bloquear conta"
        confirmDisabled={reason.trim() === ''}
        message={(
          <>
            <strong>{displayName}</strong> não conseguirá entrar, e todas as sessões abertas serão encerradas na hora.
            {detail.platform_role && ' Atenção: esta conta é de superadministrador.'}
            {detail.is_owner && ' Ela é a responsável pela loja: confira se há outro administrador ativo.'}
          </>
        )}
      >
        <FormField
          label="Motivo do bloqueio"
          required
          hint={`${reason.trim().length}/${BLOCK_REASON_MAX} caracteres. Fica registrado na conta e na auditoria.`}
        >
          {(field) => (
            <textarea
              {...field}
              rows={3}
              value={reason}
              maxLength={BLOCK_REASON_MAX}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Ex.: conta comprometida (chamado 4321)."
              disabled={busy}
              className={fieldControlClass(false, 'resize-y')}
            />
          )}
        </FormField>
      </ConfirmModal>

      <ConfirmModal
        isOpen={pending === 'unblock'}
        onClose={closeConfirm}
        onConfirm={() => void run('unblock')}
        closeOnConfirm={false}
        loading={busy}
        title="Desbloquear a conta?"
        confirmLabel="Desbloquear"
        message={(
          <>
            <strong>{displayName}</strong> volta a conseguir entrar com a senha atual. As sessões antigas continuam encerradas.
          </>
        )}
      />

      <ConfirmModal
        isOpen={pending === 'revoke'}
        onClose={closeConfirm}
        onConfirm={() => void run('revoke')}
        closeOnConfirm={false}
        loading={busy}
        isDestructive
        title="Encerrar todas as sessões?"
        confirmLabel="Encerrar sessões"
        message={(
          <>
            <strong>{displayName}</strong> será desconectada de todos os dispositivos (painel, vitrine e app) e precisará entrar de novo.
            A senha não muda.
          </>
        )}
      />

      <ConfirmModal
        isOpen={pending === 'reset'}
        onClose={closeConfirm}
        onConfirm={() => void run('reset')}
        closeOnConfirm={false}
        loading={busy}
        title="Gerar link de redefinição de senha?"
        confirmLabel="Gerar link"
        message={(
          <>
            O link vale por 60 minutos e uma única vez; links gerados antes para <strong>{displayName}</strong> deixam de valer.
            Com o envio de e-mails configurado, ele vai só para o e-mail da conta; sem ele, aparece só agora para você
            enviar à pessoa por um canal seguro.
            {blocked && ' A conta está bloqueada: mesmo com a senha nova, ela só entra depois de desbloqueada.'}
          </>
        )}
      />

      {busy && <span className="sr-only" role="status">Processando...</span>}
    </div>
  );
}
