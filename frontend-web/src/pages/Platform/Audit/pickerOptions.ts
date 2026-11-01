import { platformLookups, type StoreOption } from '../../../services/platform/insightsLookups';
import { platformUsersService, type PlatformUser } from '../../../services/platform/usersService';
import { platformRoleLabel, roleLabel } from '../../../utils/roles';
import { STORE_ACCOUNT_STATUS, statusMeta } from '../../../utils/saasStatus';

/** Opção dos seletores com busca (lojas e contas). */
export interface PickerOption {
  id: number;
  label: string;
  description?: string;
  /** Motivo de não poder escolher (a opção aparece desabilitada). */
  disabledReason?: string | null;
}

export function storeToOption(store: StoreOption, options: { disableInactive?: boolean } = {}): PickerOption {
  const status = statusMeta(STORE_ACCOUNT_STATUS, store.account_status);
  return {
    id: store.id,
    label: store.name,
    description: `/${store.slug} · ${status.label}`,
    disabledReason: options.disableInactive && store.account_status === 'INACTIVE'
      ? 'Desativada: restaure a loja antes de escolhê-la.'
      : null,
  };
}

export function userToOption(user: PlatformUser): PickerOption {
  const details = [
    user.email,
    user.platform_role ? platformRoleLabel(user.platform_role) : roleLabel(user.role),
    user.store?.name,
    user.deleted_at ? 'na lixeira' : null,
  ].filter(Boolean);
  return { id: user.id, label: user.name || user.email || `Conta #${user.id}`, description: details.join(' · ') };
}

/** Lojas por nome, endereço, razão social, e-mail ou documento (GET /platform/stores). */
export async function searchStoreOptions(term: string, signal: AbortSignal, disableInactive = false): Promise<PickerOption[]> {
  const stores = await platformLookups.searchStores(term, signal);
  return stores.map((store) => storeToOption(store, { disableInactive }));
}

/** Contas por nome, e-mail ou telefone, inclusive na lixeira (GET /platform/users). */
export async function searchUserOptions(term: string, signal: AbortSignal): Promise<PickerOption[]> {
  const page = await platformUsersService.list({ page: 1, pageSize: 8, search: term, include_deleted: true }, signal);
  return page.items.map(userToOption);
}

/** Nome de uma loja escolhida pelo endereço da página (?loja=7). */
export async function resolveStoreOption(id: number, signal?: AbortSignal): Promise<PickerOption | null> {
  const store = await platformLookups.getStore(id, signal);
  return store ? storeToOption(store) : null;
}

/** Nome de uma conta escolhida pelo endereço da página (?autor=12). */
export async function resolveUserOption(id: number, signal?: AbortSignal): Promise<PickerOption | null> {
  const user = await platformUsersService.detail(id, signal);
  return userToOption(user);
}
