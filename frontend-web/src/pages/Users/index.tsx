import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ChefHat, Edit, Headset, Mail, MailPlus, Phone, Plus, Shield, Trash2, Truck, Users as UsersGroup, X, ZoomIn,
} from 'lucide-react';
import toast from 'react-hot-toast';
import {
  DataTable, FilterTabs, PageHeader, SearchInput, StatusBadge, buttonClass, cx, type DataTableColumn, type FilterTabOption,
} from '../../components/ui';
import ConfirmModal from '../../components/ConfirmModal';
import { useAuth } from '../../contexts/AuthContext';
import { avatarUrl, getApiErrorMessage, getApiErrorStatus } from '../../services/api';
import { userService, type User } from '../../services/userService';
import { storeInvitationService, type StoreInvitation } from '../../services/storeInvitationService';
import { usePaginatedQuery } from '../../hooks/usePaginatedQuery';
import { usePanelStore } from '../../layouts/DefaultLayout/panelStore';
import { useResource } from '../../hooks/useResource';
import LockedNotice from '../../layouts/DefaultLayout/LockedNotice';
import { roleLabel } from '../../utils/roles';
import { maskPhone } from '../../utils/masks';
import MemberModal from './MemberModal';
import InviteModal from './InviteModal';
import InvitationsCard from './InvitationsCard';
import {
  DEFAULT_AVATAR_CLASSES, DEFAULT_BADGE_CLASSES, ROLE_AVATAR_CLASSES, ROLE_BADGE_CLASSES, TEAM_ROLES, TEAM_ROLE_PLURALS, type TeamRole,
} from './teamRoles';

type RoleFilter = 'ALL' | TeamRole;

const ROLE_ICONS: Record<TeamRole, ReactNode> = {
  ADMIN: <Shield size={16} />,
  EMPLOYEE: <Headset size={16} />,
  KITCHEN: <ChefHat size={16} />,
  COURIER: <Truck size={16} />,
};

/** Busca sem diferenciar maiúsculas e acentos. */
function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/**
 * Painel da loja › Equipe (/users; só Administrador): a equipe da PRÓPRIA loja (GET /users), cadastro
 * direto, edição, remoção para a lixeira e convites por e-mail (GET/POST/DELETE /store/invitations).
 * Limites do plano (403) aparecem como aviso com o atalho para a Assinatura.
 */
export default function Users() {
  const { user: currentUser } = useAuth();
  const panel = usePanelStore();
  // Sessão de suporte ou loja que não pode ser alterada: a API recusaria cadastros, edições e convites (403)
  const locked = panel.locked;
  const lockTitle = panel.lockReason ?? undefined;

  const team = useResource((signal) => userService.getAll(signal), {
    errorMessage: 'Não foi possível carregar a equipe.',
  });
  const invitations = usePaginatedQuery<StoreInvitation, { status: 'PENDING' }>({
    fetcher: ({ page, pageSize, filters, signal }) => storeInvitationService.list({ page, pageSize, status: filters.status }, signal),
    initialFilters: { status: 'PENDING' },
    initialPageSize: 10,
    errorMessage: 'Não foi possível carregar os convites.',
  });

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('ALL');
  const [memberModal, setMemberModal] = useState<{ open: boolean; member: User | null }>({ open: false, member: null });
  const [inviteOpen, setInviteOpen] = useState(false);
  const [toDelete, setToDelete] = useState<User | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [zoomImage, setZoomImage] = useState<string | null>(null);

  const members = useMemo(
    () => [...(team.data ?? [])].sort((a, b) => b.id - a.id),
    [team.data],
  );

  const filtered = useMemo(() => {
    const term = normalize(search);
    return members.filter((member) => {
      const matchesRole = roleFilter === 'ALL' || member.role === roleFilter;
      const matchesSearch = !term
        || normalize(member.name).includes(term)
        || normalize(member.email).includes(term)
        || String(member.id).includes(term);
      return matchesRole && matchesSearch;
    });
  }, [members, search, roleFilter]);

  const roleTabs: FilterTabOption<RoleFilter>[] = [
    { value: 'ALL', label: 'Todos', count: members.length, icon: <UsersGroup size={16} /> },
    ...TEAM_ROLES.map((role) => ({
      value: role,
      label: TEAM_ROLE_PLURALS[role],
      count: members.filter((member) => member.role === role).length,
      icon: ROLE_ICONS[role],
    })),
  ];

  // Vagas da equipe no plano (GET /store/subscription, lido pelo layout); sem assinatura vigente não há limite a mostrar
  const planOverview = panel.subscription;
  const staffUsage = planOverview?.limitsAvailable ? planOverview.usage.find((item) => item.key === 'staff_users') ?? null : null;
  const planName = planOverview?.plan?.name;
  const atStaffLimit = !!staffUsage && staffUsage.limit !== null && staffUsage.used !== null && staffUsage.used >= staffUsage.limit;

  function reloadAll() {
    void team.reload({ silent: true });
    void invitations.reload({ silent: true });
    void panel.refresh();
  }

  async function executeDelete() {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await userService.delete(toDelete.id);
      toast.success('Usuário removido.');
      setToDelete(null);
      reloadAll();
    } catch (error) {
      // Ex.: a API não deixa remover o último Administrador ativo (400 com o motivo); 404 = já saiu da equipe
      toast.error(getApiErrorMessage(error, 'Erro ao excluir usuário.'), { duration: 6000 });
      if (getApiErrorStatus(error) === 404) {
        setToDelete(null);
        void team.reload({ silent: true });
      }
    } finally {
      setDeleting(false);
    }
  }

  const columns: DataTableColumn<User>[] = [
    {
      key: 'member',
      header: 'Membro',
      cell: (member) => {
        const avatar = avatarUrl(member.avatar);
        const isSelf = member.id === currentUser?.id;
        return (
          <div className="flex items-center gap-3">
            {avatar ? (
              <button
                type="button"
                className="relative group rounded-full shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                onClick={() => setZoomImage(avatar)}
                aria-label={`Ampliar a foto de ${member.name}`}
              >
                <img src={avatar} alt="" className="w-10 h-10 rounded-full object-cover border border-gray-200 dark:border-slate-600 shadow-sm bg-white dark:bg-slate-700" />
                <span className="absolute inset-0 bg-black/20 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity" aria-hidden="true">
                  <ZoomIn size={14} className="text-white drop-shadow-md" />
                </span>
              </button>
            ) : (
              <div className={cx('w-10 h-10 rounded-full flex items-center justify-center font-bold border shrink-0', ROLE_AVATAR_CLASSES[member.role] ?? DEFAULT_AVATAR_CLASSES)} aria-hidden="true">
                {member.name[0]?.toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <p className="font-bold text-gray-800 dark:text-white truncate max-w-56">
                {member.name}
                {isSelf && <span className="ml-1.5 text-xs font-semibold text-orange-600 dark:text-orange-400">(você)</span>}
              </p>
              <p className="text-xs text-gray-400 dark:text-gray-500 font-mono">ID: {member.id}</p>
            </div>
          </div>
        );
      },
    },
    {
      key: 'contact',
      header: 'Contato',
      cell: (member) => (
        <div className="text-sm text-gray-600 dark:text-gray-300 min-w-0">
          <div className="flex items-center gap-2 mb-1"><Mail size={14} className="shrink-0 text-gray-400 dark:text-gray-500" aria-hidden="true" /> <span className="break-all">{member.email}</span></div>
          {member.phone && <div className="flex items-center gap-2"><Phone size={14} className="shrink-0 text-gray-400 dark:text-gray-500" aria-hidden="true" /> {maskPhone(member.phone)}</div>}
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Cargo',
      cell: (member) => (
        <span className={cx('px-3 py-1.5 rounded-lg text-xs font-bold border inline-flex items-center w-fit whitespace-nowrap', ROLE_BADGE_CLASSES[member.role] ?? DEFAULT_BADGE_CLASSES)}>
          {roleLabel(member.role)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Ações</span>,
      align: 'right',
      cell: (member) => {
        const isSelf = member.id === currentUser?.id;
        return (
          <div className="flex justify-end gap-1">
            <button
              type="button"
              onClick={() => setMemberModal({ open: true, member })}
              disabled={locked}
              aria-label="Editar"
              title={lockTitle ?? `Editar ${member.name}`}
              className="p-2 text-blue-500 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 hover:text-blue-600 dark:hover:text-blue-300 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              <Edit size={18} aria-hidden="true" />
            </button>
            {/* A própria conta não pode ser excluída (a API recusa) */}
            <button
              type="button"
              onClick={() => setToDelete(member)}
              disabled={isSelf || locked}
              // Na própria conta, o nome acessível já explica por que o botão está desabilitado
              aria-label={isSelf ? 'Você não pode excluir a própria conta' : 'Excluir'}
              title={isSelf ? 'Você não pode excluir a própria conta' : lockTitle ?? `Excluir ${member.name}`}
              className="p-2 text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-300 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              <Trash2 size={18} aria-hidden="true" />
            </button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-6 pb-20">
      <PageHeader
        title="Equipe"
        subtitle="Gerencie quem acessa o painel da sua loja"
        icon={<UsersGroup size={26} />}
        actions={locked ? undefined : (
          <>
            <button type="button" onClick={() => setInviteOpen(true)} className={buttonClass('secondary')}>
              <MailPlus size={18} aria-hidden="true" /> Convidar por e-mail
            </button>
            <button type="button" onClick={() => setMemberModal({ open: true, member: null })} className={buttonClass('primary')}>
              <Plus size={20} aria-hidden="true" /> Novo Membro
            </button>
          </>
        )}
      >
        {staffUsage && (
          <div className={cx(
            'flex flex-wrap items-center gap-2 text-sm',
            atStaffLimit ? 'text-red-700 dark:text-red-300' : 'text-gray-600 dark:text-gray-300',
          )}
          >
            <StatusBadge tone={atStaffLimit ? 'danger' : 'info'}>
              {staffUsage.limit === null
                ? `Equipe ilimitada${planName ? ` no plano ${planName}` : ''}`
                : `${staffUsage.used ?? '—'} de ${staffUsage.limit} usuários${planName ? ` do plano ${planName}` : ''}`}
            </StatusBadge>
            {atStaffLimit && (
              <span>
                A equipe do plano está completa: novos membros e convites serão recusados.{' '}
                <Link to="/subscription" className="font-bold underline">Ver plano</Link>
              </span>
            )}
          </div>
        )}
      </PageHeader>

      <LockedNotice subject="Equipe" />

      <div className="space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center gap-3">
          {/* relative: os contadores (texto só para leitores de tela) ficam presos na área rolável das abas no celular */}
          <FilterTabs options={roleTabs} value={roleFilter} onChange={setRoleFilter} label="Filtrar por perfil" className="relative min-w-0 flex-1 p-0" />
          <SearchInput
            value={search}
            onChange={setSearch}
            delay={150}
            placeholder="Buscar por nome, e-mail ou ID..."
            label="Buscar na equipe"
            className="lg:w-80"
          />
        </div>

        <DataTable
          stackOnMobile
          caption="Equipe da loja"
          columns={columns}
          rows={filtered}
          rowKey={(member) => member.id}
          loading={team.loading}
          error={team.error}
          onRetry={() => void team.reload()}
          emptyIcon={<UsersGroup size={28} />}
          emptyTitle={members.length === 0 ? 'Nenhum membro na equipe' : 'Nenhum membro encontrado'}
          emptyDescription={members.length === 0 ? 'Cadastre ou convide as pessoas que vão usar o painel.' : 'Ajuste a busca ou o filtro de perfil.'}
        />
      </div>

      <InvitationsCard query={invitations} readOnly={locked} onInvite={() => setInviteOpen(true)} />

      <MemberModal
        open={memberModal.open}
        member={memberModal.member}
        onClose={() => setMemberModal({ open: false, member: null })}
        onSaved={reloadAll}
      />

      <InviteModal open={inviteOpen} onClose={() => setInviteOpen(false)} onCreated={reloadAll} />

      <ConfirmModal
        isOpen={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={executeDelete}
        closeOnConfirm={false}
        loading={deleting}
        title="Remover Membro?"
        message="O usuário será movido para a Lixeira e perderá o acesso. Ele pode ser restaurado depois pela Lixeira."
        confirmLabel="Sim, Remover"
        isDestructive
      />

      {/* Foto ampliada */}
      {zoomImage && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Foto ampliada"
          className="fixed inset-0 z-60 bg-black/90 backdrop-blur-md flex items-center justify-center p-4"
          onClick={() => setZoomImage(null)}
          onKeyDown={(event) => { if (event.key === 'Escape') setZoomImage(null); }}
        >
          <button type="button" autoFocus aria-label="Fechar" className="absolute top-6 right-6 text-white/60 hover:text-white transition-colors rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-white" onClick={() => setZoomImage(null)}>
            <X size={32} aria-hidden="true" />
          </button>
          <img src={zoomImage} alt="Foto ampliada" className="max-w-full max-h-[85vh] rounded-lg shadow-2xl object-contain" onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </div>
  );
}
