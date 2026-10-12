import { useState } from 'react';
import { Store, Lock, Power, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import ConfirmModal from '../ConfirmModal';
import { useStoreStatus } from '../../contexts/StoreStatusContext';
import { getApiErrorMessage } from '../../services/api';

interface StoreToggleProps {
  /** 'compact': interruptor do cabeçalho de Pedidos; 'hero': botão grande do Dashboard. */
  variant?: 'compact' | 'hero';
}

/**
 * Abre/fecha a loja (PATCH /store/status). Usado por Administrador e Atendente.
 * Fechar pede confirmação, porque bloqueia novos pedidos na vitrine e no app na hora.
 */
export default function StoreToggle({ variant = 'compact' }: StoreToggleProps) {
  const { status, setOpen } = useStoreStatus();
  const [saving, setSaving] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);

  const unknown = !status;
  const isOpen = status?.is_open ?? false;

  async function changeStatus(open: boolean) {
    setSaving(true);
    try {
      await setOpen(open);
      toast.success(open ? 'Loja aberta! Os clientes já podem fazer pedidos.' : 'Loja fechada. Novos pedidos estão pausados.');
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Não foi possível alterar o status da loja.'));
    } finally {
      setSaving(false);
    }
  }

  function handleClick() {
    if (saving || unknown) return;
    if (isOpen) setConfirmCloseOpen(true);
    else changeStatus(true);
  }

  const confirmModal = (
    <ConfirmModal
      isOpen={confirmCloseOpen}
      onClose={() => setConfirmCloseOpen(false)}
      onConfirm={() => changeStatus(false)}
      title="Fechar a loja?"
      message="Os clientes não conseguirão fazer novos pedidos até a loja ser aberta de novo. Os pedidos em andamento continuam no quadro."
      confirmLabel="Fechar loja"
      isDestructive
    />
  );

  if (variant === 'hero') {
    return (
      <>
        <button
          onClick={handleClick}
          disabled={saving || unknown}
          aria-pressed={isOpen}
          title={isOpen ? 'Clique para fechar a loja' : 'Clique para abrir a loja'}
          className={`relative overflow-hidden flex items-center gap-4 px-8 py-4 rounded-2xl font-bold text-white shadow-xl transition-all hover:scale-105 active:scale-95 disabled:hover:scale-100 disabled:cursor-wait group ${
            unknown
              ? 'bg-linear-to-br from-gray-400 to-gray-600 dark:shadow-none'
              : isOpen
                ? 'bg-linear-to-br from-green-500 to-green-700 shadow-green-200 dark:shadow-none'
                : 'bg-linear-to-br from-red-500 to-red-700 shadow-red-200 dark:shadow-none'
          }`}
        >
          <div className="bg-white/20 p-2 rounded-xl backdrop-blur-sm">
            {saving ? <Loader2 size={24} className="animate-spin" /> : isOpen ? <Store size={24} /> : <Lock size={24} />}
          </div>
          <div className="text-left z-10">
            <p className="text-[10px] uppercase opacity-80 font-black tracking-widest">Loja Online</p>
            <p className="text-2xl leading-none tracking-tight">{unknown ? '...' : isOpen ? 'ABERTA' : 'FECHADA'}</p>
          </div>
          <Power size={120} className="absolute -right-6 -bottom-8 opacity-10 rotate-12 group-hover:rotate-45 transition-transform duration-500" />
        </button>
        {confirmModal}
      </>
    );
  }

  return (
    <>
      <button
        onClick={handleClick}
        disabled={saving || unknown}
        role="switch"
        aria-checked={isOpen}
        title={isOpen ? 'Clique para fechar a loja' : 'Clique para abrir a loja'}
        className={`flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-full border text-xs font-bold transition-colors disabled:opacity-60 disabled:cursor-wait ${
          unknown
            ? 'bg-gray-50 dark:bg-slate-700 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-slate-600'
            : isOpen
              ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800 hover:bg-green-100 dark:hover:bg-green-900/40'
              : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800 hover:bg-red-100 dark:hover:bg-red-900/40'
        }`}
      >
        <span className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${isOpen ? 'bg-green-500' : 'bg-gray-300 dark:bg-slate-600'}`}>
          <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${isOpen ? 'translate-x-[18px]' : 'translate-x-[2px]'}`} />
        </span>
        {saving ? <Loader2 size={14} className="animate-spin" /> : isOpen ? <Store size={14} /> : <Lock size={14} />}
        <span className="whitespace-nowrap">{unknown ? 'Loja...' : isOpen ? 'Loja aberta' : 'Loja fechada'}</span>
      </button>
      {confirmModal}
    </>
  );
}
