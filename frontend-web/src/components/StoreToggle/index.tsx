import { useState } from 'react';
import { Store, Lock, Power, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import ConfirmModal from '../ConfirmModal';
import { useStoreStatus } from '../../contexts/StoreStatusContext';
import { getApiErrorMessage, getApiErrorStatus } from '../../services/api';
import { usePanelStore } from '../../layouts/DefaultLayout/panelStore';

interface StoreToggleProps {
  /** 'compact': interruptor do cabeçalho de Pedidos; 'hero': botão grande do Dashboard. */
  variant?: 'compact' | 'hero';
}

/**
 * Abre/fecha a própria loja (PATCH /store/status). Usado por Administrador e Atendente.
 * Fechar pede confirmação, porque bloqueia novos pedidos na vitrine e no app na hora.
 * Em sessão de suporte (somente leitura) ou com a loja impedida de alterar (ex.: suspensa), fica desabilitado.
 */
export default function StoreToggle({ variant = 'compact' }: StoreToggleProps) {
  const { status, setOpen, refresh } = useStoreStatus();
  // A API decide; aqui só evitamos um clique que seria recusado (sessão de suporte ou loja que não pode ser alterada)
  const { lockReason: blockedReason } = usePanelStore();
  const [saving, setSaving] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);

  const unknown = !status;
  const isOpen = status?.is_open ?? false;
  const disabled = saving || unknown || !!blockedReason;

  async function changeStatus(open: boolean) {
    setSaving(true);
    try {
      await setOpen(open);
      toast.success(open ? 'Loja aberta! Os clientes já podem fazer pedidos.' : 'Loja fechada. Novos pedidos estão pausados.');
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Não foi possível alterar o status da loja.'));
      // Recusado (ex.: loja suspensa ou perfil alterado): confere o status atual
      if (getApiErrorStatus(error) === 403) void refresh();
    } finally {
      setSaving(false);
    }
  }

  function handleClick() {
    if (disabled) return;
    if (isOpen) setConfirmCloseOpen(true);
    else changeStatus(true);
  }

  const title = blockedReason ?? (isOpen ? 'Clique para fechar a loja' : 'Clique para abrir a loja');

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
          type="button"
          onClick={handleClick}
          disabled={disabled}
          aria-pressed={isOpen}
          title={title}
          className={`relative overflow-hidden flex items-center gap-4 px-8 py-4 rounded-2xl font-bold text-white shadow-xl transition-all hover:scale-105 active:scale-95 disabled:hover:scale-100 disabled:cursor-not-allowed disabled:opacity-80 group focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900 ${
            unknown
              ? 'bg-linear-to-br from-gray-400 to-gray-600 dark:shadow-none'
              : isOpen
                ? 'bg-linear-to-br from-green-500 to-green-700 shadow-green-200 dark:shadow-none'
                : 'bg-linear-to-br from-red-500 to-red-700 shadow-red-200 dark:shadow-none'
          }`}
        >
          <div className="bg-white/20 p-2 rounded-xl backdrop-blur-sm" aria-hidden="true">
            {saving ? <Loader2 size={24} className="animate-spin" /> : isOpen ? <Store size={24} /> : <Lock size={24} />}
          </div>
          <div className="text-left z-10">
            <p className="text-[10px] uppercase opacity-80 font-black tracking-widest">Loja Online</p>
            <p className="text-2xl leading-none tracking-tight">{unknown ? '...' : isOpen ? 'ABERTA' : 'FECHADA'}</p>
          </div>
          <Power size={120} aria-hidden="true" className="absolute -right-6 -bottom-8 opacity-10 rotate-12 group-hover:rotate-45 transition-transform duration-500" />
        </button>
        {confirmModal}
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        role="switch"
        aria-checked={isOpen}
        title={title}
        className={`flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-full border text-xs font-bold transition-colors disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
          unknown
            ? 'bg-gray-50 dark:bg-slate-700 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-slate-600'
            : isOpen
              ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800 hover:bg-green-100 dark:hover:bg-green-900/40'
              : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800 hover:bg-red-100 dark:hover:bg-red-900/40'
        }`}
      >
        <span aria-hidden="true" className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${isOpen ? 'bg-green-500' : 'bg-gray-300 dark:bg-slate-600'}`}>
          <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${isOpen ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
        </span>
        <span aria-hidden="true" className="inline-flex">
          {saving ? <Loader2 size={14} className="animate-spin" /> : isOpen ? <Store size={14} /> : <Lock size={14} />}
        </span>
        <span className="whitespace-nowrap">{unknown ? 'Loja...' : isOpen ? 'Loja aberta' : 'Loja fechada'}</span>
      </button>
      {confirmModal}
    </>
  );
}
