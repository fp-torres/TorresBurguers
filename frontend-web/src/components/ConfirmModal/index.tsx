import { AlertTriangle } from 'lucide-react';

interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  isDestructive?: boolean;
}

export default function ConfirmModal({ 
  isOpen, onClose, onConfirm, title, message, 
  confirmLabel = "Confirmar", isDestructive = false 
}: ConfirmModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden scale-100 animate-in zoom-in-95 duration-200 border border-transparent dark:border-slate-800">
        
        <div className="p-6 text-center">
          <div className={`mx-auto w-12 h-12 rounded-full flex items-center justify-center mb-4 ${isDestructive ? 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400' : 'bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400'}`}>
            <AlertTriangle size={24} />
          </div>
          <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">{title}</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">{message}</p>
        </div>

        <div className="bg-gray-50 dark:bg-slate-800 px-6 py-4 flex gap-3 border-t border-gray-100 dark:border-slate-700">
          <button 
            onClick={onClose}
            className="flex-1 px-4 py-2.5 bg-white dark:bg-slate-700 border border-gray-300 dark:border-slate-600 text-gray-700 dark:text-white font-bold rounded-xl hover:bg-gray-100 dark:hover:bg-slate-600 transition-colors text-sm"
          >
            Cancelar
          </button>
          <button 
            onClick={() => { onConfirm(); onClose(); }}
            className={`flex-1 px-4 py-2.5 text-white font-bold rounded-xl transition-colors text-sm shadow-lg ${
              isDestructive 
                ? 'bg-red-600 hover:bg-red-700 shadow-red-200 dark:shadow-none' 
                : 'bg-orange-600 hover:bg-orange-700 shadow-orange-200 dark:shadow-none'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}