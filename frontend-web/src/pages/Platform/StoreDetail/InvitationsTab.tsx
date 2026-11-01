import { useId, useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, Crown, Loader2, MailCheck, MailPlus, Send, UserPlus, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  CopyField, DataTable, FilterTabs, FormField, Modal, Pagination, StatusBadge, buttonClass, fieldControlClass,
  type DataTableColumn, type FilterTabOption,
} from '../../../components/ui';
import ConfirmModal from '../../../components/ConfirmModal';
import { usePaginatedQuery } from '../../../hooks/usePaginatedQuery';
import { usePolling } from '../../../hooks/usePolling';
import { getApiErrorMessage } from '../../../services/api';
import {
  INVITABLE_ROLES, platformInvitationsService, type CreatedPlatformInvitation, type InvitableRole, type PlatformInvitation,
  type PlatformInvitationStatus,
} from '../../../services/platform/invitationsService';
import type { PlatformStoreDetail } from '../../../services/platform/storesService';
import { formatDateTime } from '../../../utils/format';
import { roleLabel } from '../../../utils/roles';
import { STORE_FIELD_LIMITS, emailProblem } from '../StoreNew/storeForm';
import { invitationMeta } from './storeDisplay';

type StatusFilter = 'ALL' | PlatformInvitationStatus;
type InvitationFilters = { status: StatusFilter };

const STATUS_TABS: FilterTabOption<StatusFilter>[] = [
  { value: 'ALL', label: 'Todos' },
  { value: 'PENDING', label: 'Pendentes' },
  { value: 'ACCEPTED', label: 'Aceitos' },
  { value: 'EXPIRED', label: 'Expirados' },
  { value: 'REVOKED', label: 'Revogados' },
];

const ROLE_HINTS: Record<InvitableRole, string> = {
  ADMIN: 'Administrador: acesso total ao painel da loja.',
  EMPLOYEE: 'Atendente: pedidos, status da loja e clientes.',
  KITCHEN: 'Cozinha: pedidos em preparo.',
  COURIER: 'Entregador: entregas da loja.',
};

interface InvitationsTabProps {
  store: PlatformStoreDetail;
  /** Um convite de responsável foi criado/aceito: o resumo da loja pode mudar. */
  onChanged?: () => void;
}

/** Atualização automática da lista (pausa com a aba do navegador oculta e atualiza ao voltar). */
const INVITATIONS_REFRESH_MS = 60_000;

/**
 * Convites da equipe da loja: GET /platform/stores/:id/invitations, POST (link de uso único exibido só agora)
 * e DELETE /platform/invitations/:id (revogar).
 */
export default function InvitationsTab({ store, onChanged }: InvitationsTabProps) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const [toRevoke, setToRevoke] = useState<PlatformInvitation | null>(null);
  const [revoking, setRevoking] = useState(false);
  const inactive = store.account_status === 'INACTIVE';

  const query = usePaginatedQuery<PlatformInvitation, InvitationFilters>({
    fetcher: ({ page, pageSize, filters, signal }) => platformInvitationsService.list(store.id, {
      page, pageSize, status: filters.status === 'ALL' ? undefined : filters.status,
    }, signal),
    initialFilters: { status: 'ALL' },
    initialPageSize: 10,
    errorMessage: 'Não foi possível carregar os convites.',
  });
  // Convites aceitos ou vencidos em outro lugar: a lista se atualiza ao voltar para a aba e a cada minuto
  usePolling(() => query.reload({ silent: true }), INVITATIONS_REFRESH_MS);

  async function revoke() {
    if (!toRevoke) return;
    setRevoking(true);
    try {
      await platformInvitationsService.revoke(toRevoke.id);
      toast.success('Convite revogado: o link deixou de funcionar.');
      setToRevoke(null);
      void query.reload({ silent: true });
    } catch (error) {
      // 409: já foi aceito (a pessoa já está na equipe)
      toast.error(getApiErrorMessage(error, 'Não foi possível revogar o convite.'), { duration: 6000 });
      setToRevoke(null);
      void query.reload({ silent: true });
    } finally {
      setRevoking(false);
    }
  }

  const columns: DataTableColumn<PlatformInvitation>[] = [
    {
      key: 'email',
      header: 'E-mail',
      cell: (invitation) => (
        <div className="min-w-0">
          <p className="font-semibold text-gray-800 dark:text-white break-all">{invitation.email}</p>
          {invitation.make_owner && <StatusBadge tone="info" icon={<Crown size={12} />} className="mt-1">Vira responsável ao aceitar</StatusBadge>}
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Perfil',
      className: 'whitespace-nowrap',
      cell: (invitation) => roleLabel(invitation.role) || invitation.role,
    },
    {
      key: 'status',
      header: 'Situação',
      cell: (invitation) => {
        const meta = invitationMeta(invitation.status);
        return <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>;
      },
    },
    {
      key: 'created',
      header: 'Enviado em',
      className: 'hidden md:table-cell whitespace-nowrap',
      headerClassName: 'hidden md:table-cell',
      cell: (invitation) => formatDateTime(invitation.created_at),
    },
    {
      key: 'when',
      header: 'Validade / desfecho',
      className: 'hidden sm:table-cell whitespace-nowrap text-xs',
      headerClassName: 'hidden sm:table-cell',
      cell: (invitation) => {
        if (invitation.accepted_at) return <>Aceito em {formatDateTime(invitation.accepted_at)}</>;
        if (invitation.revoked_at) return <>Revogado em {formatDateTime(invitation.revoked_at)}</>;
        return <>{invitation.status === 'EXPIRED' ? 'Expirou em' : 'Expira em'} {formatDateTime(invitation.expires_at)}</>;
      },
    },
    {
      key: 'actions',
      header: <span className="sr-only">Ações</span>,
      align: 'right',
      cell: (invitation) => (invitation.status === 'PENDING' ? (
        <button
          type="button"
          onClick={() => setToRevoke(invitation)}
          aria-label={`Revogar o convite de ${invitation.email}`}
          className={buttonClass('ghost', 'sm', 'text-red-600 dark:text-red-400')}
        >
          <XCircle size={14} aria-hidden="true" /> <span className="hidden sm:inline">Revogar</span>
        </button>
      ) : null),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-gray-800 dark:text-white flex items-center gap-2">
            <Send size={18} className="text-orange-600 dark:text-orange-400" aria-hidden="true" /> Convites da equipe
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">Links de uso único, válidos por 7 dias. Um novo convite para o mesmo e-mail substitui o anterior.</p>
        </div>
        <button
          type="button"
          onClick={() => setInviteOpen(true)}
          disabled={inactive}
          title={inactive ? 'Restaure o estabelecimento antes de convidar a equipe.' : undefined}
          className={buttonClass('primary')}
        >
          <MailPlus size={16} aria-hidden="true" /> Convidar
        </button>
      </div>
      {inactive && (
        <p role="status" className="flex items-start gap-2 px-3 py-2 rounded-xl text-sm bg-gray-50 dark:bg-slate-900/40 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-slate-700">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span>Estabelecimento desativado: restaure-o antes de convidar a equipe.</span>
        </p>
      )}

      <FilterTabs label="Filtrar convites por situação" options={STATUS_TABS} value={query.filters.status} onChange={(value) => query.setFilter('status', value)} className="-mx-2" />

      <DataTable
        stackOnMobile
        caption={`Convites de ${store.name}`}
        columns={columns}
        rows={query.items}
        rowKey={(invitation) => invitation.id}
        loading={query.loading}
        error={query.error}
        onRetry={() => void query.reload()}
        skeletonRows={3}
        emptyIcon={<MailPlus size={28} />}
        emptyTitle={query.filters.status === 'ALL' ? 'Nenhum convite ainda' : 'Nenhum convite nesta situação'}
        emptyDescription="Convide o responsável ou a equipe por e-mail: a pessoa cria a própria senha pelo link."
        emptyAction={inactive ? undefined : (
          <button type="button" onClick={() => setInviteOpen(true)} className={buttonClass('secondary', 'sm')}>
            <MailPlus size={14} aria-hidden="true" /> Convidar
          </button>
        )}
        footer={query.total > query.pageSize ? (
          <Pagination
            page={query.page}
            pageSize={query.pageSize}
            total={query.total}
            onPageChange={query.setPage}
            disabled={query.loading}
            itemLabel="convites"
          />
        ) : undefined}
      />

      <InviteDialog
        open={inviteOpen}
        store={store}
        onClose={() => setInviteOpen(false)}
        onCreated={(created) => {
          void query.reload({ silent: true });
          if (created.invitation.make_owner) onChanged?.();
        }}
      />

      <ConfirmModal
        isOpen={!!toRevoke}
        onClose={() => setToRevoke(null)}
        onConfirm={revoke}
        closeOnConfirm={false}
        loading={revoking}
        title="Revogar convite?"
        message={`O link enviado para ${toRevoke?.email ?? 'esta pessoa'} deixa de funcionar. Dá para convidar de novo depois.`}
        confirmLabel="Revogar convite"
        isDestructive
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

interface InviteDialogProps {
  open: boolean;
  store: PlatformStoreDetail;
  onClose: () => void;
  onCreated: (created: CreatedPlatformInvitation) => void;
}

function InviteDialog({ open, store, onClose, onCreated }: InviteDialogProps) {
  if (!open) return null;
  return <InviteForm store={store} onClose={onClose} onCreated={onCreated} />;
}

function InviteForm({ store, onClose, onCreated }: Omit<InviteDialogProps, 'open'>) {
  const formId = useId();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InvitableRole>(store.owner ? 'EMPLOYEE' : 'ADMIN');
  const [makeOwner, setMakeOwner] = useState(!store.owner);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<CreatedPlatformInvitation | null>(null);
  const emailError = emailProblem(email, { required: true, max: STORE_FIELD_LIMITS.owner_email });

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (emailError) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    try {
      const result = await platformInvitationsService.create(store.id, {
        email: email.trim().toLowerCase(),
        role,
        make_owner: role === 'ADMIN' && makeOwner ? true : undefined,
      });
      setCreated(result);
      onCreated(result);
      toast.success(result.delivered ? 'Convite enviado por e-mail.' : 'Convite criado.');
    } catch (error) {
      // 409: o e-mail já tem conta; 400: loja desativada ou responsável sem perfil ADMIN
      toast.error(getApiErrorMessage(error, 'Não foi possível criar o convite.'), { duration: 6000 });
    } finally {
      setSaving(false);
    }
  }

  function inviteAnother() {
    setCreated(null);
    setEmail('');
    setShowErrors(false);
  }

  if (created) {
    return (
      <Modal
        open
        onClose={onClose}
        title={created.delivered ? 'Convite enviado' : 'Convite criado'}
        description={`${created.invitation.email} · ${roleLabel(created.invitation.role) || created.invitation.role}${created.invitation.make_owner ? ' · vira responsável ao aceitar' : ''}`}
        closeOnOverlayClick={false}
        footer={(
          <>
            <button type="button" onClick={inviteAnother} className={buttonClass('secondary')}>
              <UserPlus size={16} aria-hidden="true" /> Convidar outra pessoa
            </button>
            <button type="button" onClick={onClose} className={buttonClass('primary')}>Concluir</button>
          </>
        )}
      >
        <div className="space-y-4">
          <p className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-300">
            <CheckCircle2 size={18} className="shrink-0 mt-0.5 text-green-600 dark:text-green-400" aria-hidden="true" />
            <span>
              {created.delivered
                ? <>Convite enviado por e-mail: a pessoa abre o link, cria a senha e entra no painel de {store.name}.</>
                : <>Envie o link para a pessoa: ela cria a senha e entra no painel de {store.name}.</>}
              {created.invitation.expires_at && <> Vale até <span className="font-bold">{formatDateTime(created.invitation.expires_at)}</span>.</>}
            </span>
          </p>
          {created.warnings.map((warning) => (
            <p key={warning} role="alert" className="flex items-start gap-2 px-3 py-2 rounded-xl text-sm bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden="true" /> <span>{warning}</span>
            </p>
          ))}
          {created.url ? (
            <CopyField label="Link de convite" value={created.url} notice={created.message || undefined} />
          ) : created.delivered ? (
            // O link foi só para o convidado: o operador não o vê
            <p role="status" className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
              <MailCheck size={18} className="shrink-0 mt-0.5 text-orange-600 dark:text-orange-400" aria-hidden="true" />
              <span>{created.message || `Convite enviado por e-mail para ${created.invitation.email}. O link não aparece aqui.`}</span>
            </p>
          ) : (
            <p className="text-sm text-amber-700 dark:text-amber-300">A API não devolveu o link. Revogue e crie outro convite.</p>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Convidar para a equipe"
      description={`${store.name}: a pessoa recebe um link de uso único para criar a própria senha.`}
      dismissible={!saving}
      footer={(
        <>
          <button type="button" onClick={onClose} disabled={saving} className={buttonClass('secondary')}>Cancelar</button>
          <button type="submit" form={formId} disabled={saving} className={buttonClass('primary')}>
            {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <MailPlus size={16} aria-hidden="true" />}
            Criar convite
          </button>
        </>
      )}
    >
      <form id={formId} onSubmit={handleSubmit} noValidate className="space-y-4">
        <FormField label="E-mail" required error={showErrors ? emailError ?? undefined : undefined} hint="Precisa ser um e-mail sem conta na plataforma.">
          {(field) => (
            <input
              {...field}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              maxLength={STORE_FIELD_LIMITS.owner_email}
              placeholder="pessoa@email.com"
              autoComplete="off"
              className={fieldControlClass(showErrors && !!emailError)}
            />
          )}
        </FormField>
        <FormField label="Perfil" hint={ROLE_HINTS[role]}>
          {(field) => (
            <select
              {...field}
              value={role}
              onChange={(event) => setRole(INVITABLE_ROLES.find((item) => item === event.target.value) ?? 'EMPLOYEE')}
              className={fieldControlClass()}
            >
              {INVITABLE_ROLES.map((item) => <option key={item} value={item}>{roleLabel(item)}</option>)}
            </select>
          )}
        </FormField>
        <label className={`flex items-start gap-2 text-sm ${role === 'ADMIN' ? 'text-gray-700 dark:text-gray-200' : 'text-gray-400 dark:text-gray-500'}`}>
          <input
            type="checkbox"
            checked={role === 'ADMIN' && makeOwner}
            disabled={role !== 'ADMIN'}
            onChange={(event) => setMakeOwner(event.target.checked)}
            className="mt-0.5 w-4 h-4 accent-orange-600 shrink-0"
          />
          <span>
            Tornar responsável pela loja ao aceitar
            <span className="block text-xs text-gray-500 dark:text-gray-400">
              {role !== 'ADMIN'
                ? 'Só para o perfil Administrador.'
                : store.owner
                  ? `Substitui o responsável atual (${store.owner.name || store.owner.email}) quando o convite for aceito.`
                  : 'A loja ainda não tem responsável.'}
            </span>
          </span>
        </label>
      </form>
    </Modal>
  );
}
