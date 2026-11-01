import { useState } from 'react';
import { Package, RotateCcw, Trash2, User, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { DataTable, PageHeader, Tabs, type DataTableColumn, type TabItem } from '../../components/ui';
import ConfirmModal from '../../components/ConfirmModal';
import { getApiErrorMessage } from '../../services/api';
import { productService } from '../../services/productService';
import { userService } from '../../services/userService';
import { planRestrictionMessage } from '../../services/storeSubscriptionService';
import { usePanelStore } from '../../layouts/DefaultLayout/panelStore';
import { useResource } from '../../hooks/useResource';
import { toastPlanLimit } from '../../layouts/DefaultLayout/planLimit';
import LockedNotice from '../../layouts/DefaultLayout/LockedNotice';
import { roleLabel } from '../../utils/roles';
import { formatDateTime } from '../../utils/format';

type TrashTab = 'products' | 'users';

/** Item da lixeira (produto ou membro da equipe). */
interface DeletedItem {
  id: number;
  name: string;
  description?: string | null;
  email?: string;
  role?: string;
  /** Produtos: disponibilidade que voltará com a restauração. */
  available?: boolean;
  deleted_at?: string | null;
}

interface PendingConfirm {
  title: string;
  message: string;
  confirmLabel: string;
  isDestructive: boolean;
  action: () => Promise<void>;
}

/**
 * Painel da loja › Lixeira (/trash; só Administrador): produtos (GET /products/trash) e membros da equipe
 * (GET /users/trash) da própria loja, com restauração e exclusão definitiva. Itens que aparecem em pedidos
 * não podem ser apagados (409, o histórico é preservado); restaurar respeita os limites do plano (403).
 */
export default function Trash() {
  const panel = usePanelStore();
  const [activeTab, setActiveTab] = useState<TrashTab>('products');
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [confirming, setConfirming] = useState(false);

  const products = useResource<DeletedItem[]>((signal) => productService.getTrash(signal), {
    errorMessage: 'Erro ao carregar a lixeira de produtos.',
  });
  const users = useResource<DeletedItem[]>((signal) => userService.getTrash(signal), {
    errorMessage: 'Erro ao carregar a lixeira da equipe.',
  });

  const isProducts = activeTab === 'products';
  const current = isProducts ? products : users;
  const items = current.data ?? [];
  // Sessão de suporte ou loja que não pode ser alterada: restaurar e excluir seriam recusados (403)
  const locked = panel.locked;
  const lockTitle = panel.lockReason ?? undefined;

  function handleError(error: unknown, fallback: string) {
    const planMessage = planRestrictionMessage(error);
    if (planMessage) toastPlanLimit(planMessage);
    else toast.error(getApiErrorMessage(error, fallback), { duration: 6000 });
  }

  async function runConfirmed() {
    if (!pendingConfirm) return;
    setConfirming(true);
    try {
      await pendingConfirm.action();
    } finally {
      setConfirming(false);
      setPendingConfirm(null);
    }
  }

  function handleRestore(item: DeletedItem) {
    const product = isProducts;
    // Produtos voltam com a disponibilidade que tinham antes da exclusão
    const message = product
      ? item.available === false
        ? `O produto "${item.name}" voltará para o cardápio, mas continuará Esgotado até ser ativado.`
        : `O produto "${item.name}" voltará para o cardápio.`
      : `O usuário "${item.name}" voltará a ter acesso ao painel da loja.`;
    setPendingConfirm({
      title: 'Restaurar Item?',
      message,
      confirmLabel: 'Sim, Restaurar',
      isDestructive: false,
      action: async () => {
        try {
          if (product) await productService.restore(item.id);
          else await userService.restore(item.id);
          toast.success('Item restaurado com sucesso!');
          void current.reload({ silent: true });
          void panel.refresh();
        } catch (error) {
          handleError(error, 'Erro ao restaurar.');
        }
      },
    });
  }

  function handleHardDelete(item: DeletedItem) {
    const product = isProducts;
    setPendingConfirm({
      title: 'Excluir Definitivamente?',
      message: `ATENÇÃO: "${item.name}" será apagado para sempre. ${product ? 'Produtos' : 'Usuários'} que aparecem em pedidos não podem ser apagados, para preservar o histórico.`,
      confirmLabel: 'Sim, Excluir',
      isDestructive: true,
      action: async () => {
        try {
          if (product) await productService.deletePermanent(item.id);
          else await userService.deletePermanent(item.id);
          toast.success('Item excluído permanentemente.');
          void current.reload({ silent: true });
        } catch (error) {
          // 409: item referenciado por pedidos (a API explica o motivo)
          handleError(error, 'Erro ao excluir.');
        }
      },
    });
  }

  const tabs: TabItem<TrashTab>[] = [
    { value: 'products', label: 'Produtos', icon: <Package size={18} />, badge: products.data?.length },
    { value: 'users', label: 'Usuários', icon: <User size={18} />, badge: users.data?.length },
  ];

  const columns: DataTableColumn<DeletedItem>[] = [
    {
      key: 'item',
      header: 'Item Excluído',
      cell: (item) => (
        <div className="min-w-0">
          <div className="font-bold text-gray-800 dark:text-white">{item.name}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">ID: {item.id}</div>
        </div>
      ),
    },
    {
      key: 'details',
      header: 'Detalhes',
      className: 'hidden md:table-cell',
      headerClassName: 'hidden md:table-cell',
      cell: (item) => (isProducts ? (
        <span className="truncate max-w-56 block text-gray-600 dark:text-gray-300" title={item.description ?? undefined}>{item.description || '-'}</span>
      ) : (
        <div className="flex flex-col text-gray-600 dark:text-gray-300">
          <span className="break-all">{item.email}</span>
          <span className="text-xs bg-gray-100 dark:bg-slate-700 w-fit px-1.5 rounded mt-1">{roleLabel(item.role)}</span>
        </div>
      )),
    },
    {
      key: 'deleted',
      header: 'Data de Exclusão',
      className: 'hidden sm:table-cell whitespace-nowrap text-gray-500 dark:text-gray-400',
      headerClassName: 'hidden sm:table-cell',
      cell: (item) => formatDateTime(item.deleted_at),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Ações</span>,
      align: 'right',
      cell: (item) => (
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => handleRestore(item)}
            disabled={locked}
            title={lockTitle}
            className="px-3 py-1.5 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 rounded-lg hover:bg-green-100 dark:hover:bg-green-900/40 font-bold text-xs inline-flex items-center gap-1 transition-colors disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          >
            <RotateCcw size={14} aria-hidden="true" /> Restaurar
          </button>
          <button
            type="button"
            onClick={() => handleHardDelete(item)}
            disabled={locked}
            title={lockTitle}
            className="px-3 py-1.5 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/40 font-bold text-xs inline-flex items-center gap-1 transition-colors disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          >
            <XCircle size={14} aria-hidden="true" /> Excluir
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6 pb-20">
      <PageHeader
        title="Lixeira do Sistema"
        subtitle="Recupere itens excluídos ou limpe definitivamente."
        icon={<Trash2 size={26} />}
      />

      <LockedNotice subject="Lixeira" />

      <Tabs tabs={tabs} value={activeTab} onChange={setActiveTab} label="Itens da lixeira" panelClassName="pt-4">
        <DataTable
          stackOnMobile
          caption={isProducts ? 'Produtos na lixeira' : 'Usuários na lixeira'}
          columns={columns}
          rows={items}
          rowKey={(item) => item.id}
          loading={current.loading}
          error={current.error}
          onRetry={() => void current.reload()}
          emptyIcon={<Trash2 size={28} />}
          emptyTitle="A lixeira está vazia."
          emptyDescription={isProducts ? 'Produtos movidos para a lixeira no Cardápio aparecem aqui.' : 'Membros removidos da Equipe aparecem aqui.'}
        />
      </Tabs>

      <ConfirmModal
        isOpen={!!pendingConfirm}
        onClose={() => setPendingConfirm(null)}
        onConfirm={() => void runConfirmed()}
        closeOnConfirm={false}
        loading={confirming}
        title={pendingConfirm?.title ?? ''}
        message={pendingConfirm?.message ?? ''}
        confirmLabel={pendingConfirm?.confirmLabel}
        isDestructive={pendingConfirm?.isDestructive}
      />
    </div>
  );
}
