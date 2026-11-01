import { useState } from 'react';
import { MailPlus, Send, ShieldCheck, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { DataTable, Pagination, buttonClass, type DataTableColumn } from '../../components/ui';
import ConfirmModal from '../../components/ConfirmModal';
import { getApiErrorMessage } from '../../services/api';
import { canStoreRevokeInvitation, storeInvitationService, type StoreInvitation } from '../../services/storeInvitationService';
import type { PaginatedQuery } from '../../hooks/usePaginatedQuery';
import { formatDateTime } from '../../utils/format';
import { roleLabel } from '../../utils/roles';

interface InvitationsCardProps {
  query: PaginatedQuery<StoreInvitation, { status: 'PENDING' }>;
  readOnly: boolean;
  onInvite: () => void;
}

/** Convites pendentes da equipe (GET /store/invitations?status=PENDING) com a opção de revogar. */
export default function InvitationsCard({ query, readOnly, onInvite }: InvitationsCardProps) {
  const [toRevoke, setToRevoke] = useState<StoreInvitation | null>(null);
  const [revoking, setRevoking] = useState(false);

  async function revoke() {
    if (!toRevoke) return;
    setRevoking(true);
    try {
      await storeInvitationService.revoke(toRevoke.id);
      toast.success('Convite revogado: o link deixou de funcionar.');
      setToRevoke(null);
      await query.reload({ silent: true });
    } catch (error) {
      // 409: o convite já foi aceito (a pessoa já está na equipe); 403: convite de troca do responsável (plataforma)
      toast.error(getApiErrorMessage(error, 'Não foi possível revogar o convite.'), { duration: 6000 });
      setToRevoke(null);
      void query.reload({ silent: true });
    } finally {
      setRevoking(false);
    }
  }

  const columns: DataTableColumn<StoreInvitation>[] = [
    {
      key: 'email',
      header: 'E-mail',
      cell: (invitation) => <span className="font-semibold text-gray-800 dark:text-white break-all">{invitation.email}</span>,
    },
    {
      key: 'role',
      header: 'Perfil',
      cell: (invitation) => (
        <span className="flex flex-col gap-0.5">
          <span>{roleLabel(invitation.role)}</span>
          {invitation.make_owner && (
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-700 dark:text-indigo-300">
              <ShieldCheck size={12} aria-hidden="true" /> Novo responsável pela loja
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'created',
      header: 'Enviado em',
      className: 'hidden md:table-cell whitespace-nowrap',
      headerClassName: 'hidden md:table-cell',
      cell: (invitation) => formatDateTime(invitation.created_at),
    },
    {
      key: 'expires',
      header: 'Expira em',
      className: 'hidden sm:table-cell whitespace-nowrap',
      headerClassName: 'hidden sm:table-cell',
      cell: (invitation) => formatDateTime(invitation.expires_at),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Ações</span>,
      align: 'right',
      cell: (invitation) => (readOnly ? null : !canStoreRevokeInvitation(invitation) ? (
        // Troca do responsável criada pela administração da plataforma: só ela cancela (a API responde 403)
        <span className="text-xs text-gray-500 dark:text-gray-400" title="Convite criado pela administração da plataforma: só ela pode cancelá-lo.">
          Criado pela plataforma
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setToRevoke(invitation)}
          aria-label={`Revogar o convite de ${invitation.email}`}
          className={buttonClass('ghost', 'sm', 'text-red-600 dark:text-red-400')}
        >
          <XCircle size={14} aria-hidden="true" /> <span className="hidden sm:inline">Revogar</span>
        </button>
      )),
    },
  ];

  return (
    <section aria-labelledby="pending-invitations-title" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="pending-invitations-title" className="text-lg font-bold text-gray-800 dark:text-white flex items-center gap-2">
            <Send size={18} className="text-orange-600 dark:text-orange-400" aria-hidden="true" /> Convites pendentes
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">Links enviados que ainda não foram aceitos (valem por 7 dias).</p>
        </div>
      </div>

      <DataTable
        stackOnMobile
        caption="Convites pendentes da equipe"
        columns={columns}
        rows={query.items}
        rowKey={(invitation) => invitation.id}
        loading={query.loading}
        error={query.error}
        onRetry={() => void query.reload()}
        skeletonRows={2}
        emptyIcon={<MailPlus size={28} />}
        emptyTitle="Nenhum convite pendente"
        emptyDescription="Convide alguém por e-mail: a pessoa cria a própria senha pelo link."
        emptyAction={readOnly ? undefined : (
          <button type="button" onClick={onInvite} className={buttonClass('secondary', 'sm')}>
            <MailPlus size={14} aria-hidden="true" /> Convidar por e-mail
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

      <ConfirmModal
        isOpen={!!toRevoke}
        onClose={() => setToRevoke(null)}
        onConfirm={revoke}
        closeOnConfirm={false}
        loading={revoking}
        title="Revogar convite?"
        message={`O link enviado para ${toRevoke?.email ?? 'esta pessoa'} deixa de funcionar. Você pode convidar de novo depois.`}
        confirmLabel="Revogar convite"
        isDestructive
      />
    </section>
  );
}
