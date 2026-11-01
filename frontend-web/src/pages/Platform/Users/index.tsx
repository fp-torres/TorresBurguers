import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icon } from '@iconify/react';
import { History, Users as UsersIcon } from 'lucide-react';
import { PageHeader, Tabs, type TabItem } from '../../../components/ui';
import { useAuth } from '../../../contexts/AuthContext';
import { EMPTY_AUTH_EVENT_FILTERS } from '../../../services/platform/authEventsService';
import type { PlatformUser } from '../../../services/platform/usersService';
import type { PickerOption } from '../Audit/pickerOptions';
import AccountsTab from './AccountsTab';
import AuthEventsTab from './AuthEventsTab';
import UserDetailModal from './UserDetailModal';
import { authEventFiltersToParams, detailIdFromParams, tabFromParams, type UsersTab } from './urlFilters';

const TABS: TabItem<UsersTab>[] = [
  { value: 'contas', label: 'Contas', icon: <UsersIcon size={16} /> },
  { value: 'eventos', label: 'Eventos de autenticação', icon: <History size={16} /> },
];

/**
 * Superpainel › Usuários e acessos (/platform/users): contas de clientes, das equipes de todas as lojas e
 * da plataforma (GET /platform/users), detalhe com as ações de acesso (bloquear, desbloquear, encerrar
 * sessões, link de redefinição de senha) e os eventos de autenticação (GET /platform/auth-events).
 * Aba, filtros e conta aberta ficam no endereço (?aba=eventos, ?usuario=<id>...).
 */
export default function PlatformUsers() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = tabFromParams(searchParams);
  const detailId = detailIdFromParams(searchParams);
  const [refreshToken, setRefreshToken] = useState(0);
  // "Ver todos os eventos" no detalhe: a aba de eventos recomeça filtrada pela conta
  const [eventsNav, setEventsNav] = useState<{ key: number; account: PickerOption | null }>({ key: 0, account: null });

  function changeTab(next: UsersTab) {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (next === 'eventos') params.set('aba', 'eventos');
      else params.delete('aba');
      return params;
    }, { replace: true });
  }

  function openUser(account: PlatformUser) {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      params.set('usuario', String(account.id));
      return params;
    }, { replace: true });
  }

  function closeUser() {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      params.delete('usuario');
      return params;
    }, { replace: true });
  }

  function showEventsFor(account: PickerOption) {
    setEventsNav((current) => ({ key: current.key + 1, account }));
    setSearchParams((current) => {
      const params = authEventFiltersToParams({ ...EMPTY_AUTH_EVENT_FILTERS, user_id: account.id }, current);
      params.set('aba', 'eventos');
      params.delete('usuario');
      return params;
    }, { replace: true });
  }

  return (
    <div className="space-y-6 pb-20">
      <PageHeader
        title="Usuários e acessos"
        subtitle="Contas, bloqueios, sessões e eventos de autenticação"
        icon={<Icon icon="solar:shield-user-bold-duotone" width={26} />}
      />

      <Tabs tabs={TABS} value={tab} onChange={changeTab} label="Usuários e acessos">
        {tab === 'contas' ? (
          <AccountsTab currentUserId={user?.id ?? null} onOpen={openUser} refreshToken={refreshToken} />
        ) : (
          <AuthEventsTab key={eventsNav.key} knownAccount={eventsNav.account} />
        )}
      </Tabs>

      <UserDetailModal
        userId={detailId}
        currentUserId={user?.id ?? null}
        onClose={closeUser}
        onChanged={() => setRefreshToken((current) => current + 1)}
        onShowEvents={showEventsFor}
      />
    </div>
  );
}
