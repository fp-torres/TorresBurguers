import { useState } from 'react';
import { Crown, Loader2, UserX } from 'lucide-react';
import toast from 'react-hot-toast';
import { EmptyState, ErrorState, Modal, StatusBadge, buttonClass, cx } from '../../../components/ui';
import ConfirmModal from '../../../components/ConfirmModal';
import { getApiErrorMessage } from '../../../services/api';
import {
  platformStoresService, type PlatformStoreDetail, type PlatformStoreMember, type StoreMutationResult,
} from '../../../services/platform/storesService';
import { formatDateTime } from '../../../utils/format';
import { useResource } from '../../../hooks/useResource';
import { isOwnerCandidate } from './storeDisplay';

async function setOwner(store: PlatformStoreDetail, ownerId: number | null): Promise<StoreMutationResult> {
  return platformStoresService.update(store.id, { owner_user_id: ownerId });
}

// ---------------------------------------------------------------------------
// Escolher o responsável entre os administradores ativos
// ---------------------------------------------------------------------------

interface OwnerPickerDialogProps {
  open: boolean;
  store: PlatformStoreDetail;
  onClose: () => void;
  onDone: (result: StoreMutationResult) => void;
}

/** Definir o responsável principal (PATCH { owner_user_id }): um ADMIN ativo desta loja. */
export function OwnerPickerDialog({ open, store, onClose, onDone }: OwnerPickerDialogProps) {
  if (!open) return null;
  return <OwnerPicker store={store} onClose={onClose} onDone={onDone} />;
}

function OwnerPicker({ store, onClose, onDone }: Omit<OwnerPickerDialogProps, 'open'>) {
  const team = useResource(
    (signal) => platformStoresService.team(store.id, { page: 1, pageSize: 100, include_deleted: false }, signal),
    { errorMessage: 'Não foi possível carregar os administradores da loja.' },
  );
  const candidates = (team.data?.items ?? []).filter(isOwnerCandidate);
  const currentOwnerId = store.owner?.id ?? null;
  const [selected, setSelected] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const chosen = candidates.find((member) => member.id === selected) ?? null;

  async function handleSave() {
    if (!chosen || saving) return;
    setSaving(true);
    try {
      const result = await setOwner(store, chosen.id);
      toast.success(`${chosen.name || chosen.email} agora é o responsável pela loja.`);
      onDone(result);
      onClose();
    } catch (error) {
      // 400: deixou de ser ADMIN ativo da loja
      toast.error(getApiErrorMessage(error, 'Não foi possível definir o responsável.'), { duration: 6000 });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Definir responsável"
      description={`Responsável principal de ${store.name}: precisa ser um Administrador ativo da loja.`}
      dismissible={!saving}
      footer={(
        <>
          <button type="button" onClick={onClose} disabled={saving} className={buttonClass('secondary')}>Cancelar</button>
          <button type="button" onClick={() => void handleSave()} disabled={saving || !chosen} className={buttonClass('primary')}>
            {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Crown size={16} aria-hidden="true" />}
            {chosen ? `Tornar ${chosen.name || chosen.email} responsável` : 'Escolha um administrador'}
          </button>
        </>
      )}
    >
      {team.error && !team.data ? (
        <ErrorState message={team.error} onRetry={() => void team.reload()} retrying={team.loading} compact />
      ) : !team.data ? (
        <p role="status" className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Carregando administradores...
        </p>
      ) : candidates.length === 0 ? (
        <EmptyState
          compact
          icon={<UserX size={28} />}
          title="Nenhum administrador ativo"
          description="Convide um Administrador na aba Convites marcando “tornar responsável”: ao aceitar, ele assume a loja."
        />
      ) : (
        <fieldset className="space-y-2">
          <legend className="sr-only">Administradores ativos</legend>
          {candidates.map((member) => {
            const isCurrent = member.id === currentOwnerId;
            return (
              <label
                key={member.id}
                className={cx(
                  'flex items-start gap-3 p-3 rounded-xl border text-sm cursor-pointer transition-colors',
                  selected === member.id
                    ? 'border-orange-400 dark:border-orange-600 bg-orange-50 dark:bg-orange-900/20'
                    : 'border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-800',
                  isCurrent && 'opacity-70 cursor-not-allowed',
                )}
              >
                <input
                  type="radio"
                  name="owner"
                  checked={selected === member.id}
                  disabled={isCurrent}
                  onChange={() => setSelected(member.id)}
                  className="mt-1 accent-orange-600"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-bold text-gray-800 dark:text-white">{member.name || 'Sem nome'}</span>
                    {isCurrent && <StatusBadge tone="info" icon={<Crown size={12} />}>Responsável atual</StatusBadge>}
                  </span>
                  <span className="block text-gray-500 dark:text-gray-400 break-all">{member.email}</span>
                  <span className="block text-xs text-gray-500 dark:text-gray-400">Último acesso: {member.last_login_at ? formatDateTime(member.last_login_at) : 'nunca entrou'}</span>
                </span>
              </label>
            );
          })}
          {(team.data?.total ?? 0) > 100 && (
            <p className="text-xs text-gray-500 dark:text-gray-400">Mostrando os administradores dos primeiros 100 membros da equipe (em ordem alfabética).</p>
          )}
        </fieldset>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Confirmações rápidas (a partir da equipe ou do resumo)
// ---------------------------------------------------------------------------

interface OwnerConfirmProps {
  store: PlatformStoreDetail;
  /** Novo responsável (null = fechado). */
  member: PlatformStoreMember | null;
  onClose: () => void;
  onDone: (result: StoreMutationResult) => void;
}

/** Confirma tornar um administrador o responsável principal (PATCH { owner_user_id }). */
export function SetOwnerConfirm({ store, member, onClose, onDone }: OwnerConfirmProps) {
  const [saving, setSaving] = useState(false);

  async function handleConfirm() {
    if (!member) return;
    setSaving(true);
    try {
      const result = await setOwner(store, member.id);
      toast.success(`${member.name || member.email} agora é o responsável pela loja.`);
      onDone(result);
      onClose();
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Não foi possível definir o responsável.'), { duration: 6000 });
    } finally {
      setSaving(false);
    }
  }

  return (
    <ConfirmModal
      isOpen={!!member}
      onClose={onClose}
      onConfirm={handleConfirm}
      closeOnConfirm={false}
      loading={saving}
      title="Trocar o responsável?"
      message={`${member?.name || member?.email || 'Este administrador'} passa a ser o responsável principal de ${store.name}${store.owner ? ` (no lugar de ${store.owner.name || store.owner.email})` : ''}. A troca fica na auditoria.`}
      confirmLabel="Tornar responsável"
    />
  );
}

interface RemoveOwnerConfirmProps {
  open: boolean;
  store: PlatformStoreDetail;
  onClose: () => void;
  onDone: (result: StoreMutationResult) => void;
}

/** Confirma remover o responsável principal (PATCH { owner_user_id: null }). */
export function RemoveOwnerConfirm({ open, store, onClose, onDone }: RemoveOwnerConfirmProps) {
  const [saving, setSaving] = useState(false);

  async function handleConfirm() {
    setSaving(true);
    try {
      const result = await setOwner(store, null);
      toast.success('Responsável removido.');
      onDone(result);
      onClose();
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Não foi possível remover o responsável.'), { duration: 6000 });
    } finally {
      setSaving(false);
    }
  }

  return (
    <ConfirmModal
      isOpen={open}
      onClose={onClose}
      onConfirm={handleConfirm}
      closeOnConfirm={false}
      loading={saving}
      title="Remover o responsável?"
      message={`${store.name} fica sem responsável principal. A conta de ${store.owner?.name || store.owner?.email || 'quem era o responsável'} continua na equipe como está.`}
      confirmLabel="Remover responsável"
      isDestructive
    />
  );
}
