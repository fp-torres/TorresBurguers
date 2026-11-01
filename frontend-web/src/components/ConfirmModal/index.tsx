import { useRef, type ReactNode } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Modal, buttonClass, cx } from '../ui';

interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  /** Explicação da consequência (lida pelos leitores de tela ao abrir). */
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  isDestructive?: boolean;
  /** Conteúdo extra abaixo da mensagem (ex.: campo opcional de motivo). */
  children?: ReactNode;
  /** Ação em andamento: botões desabilitados e o diálogo não fecha (Esc, fundo e X). */
  loading?: boolean;
  /** Desabilita só o botão de confirmar (ex.: campo obrigatório vazio). */
  confirmDisabled?: boolean;
  /**
   * true (padrão): fecha ao confirmar (onConfirm e depois onClose).
   * false: quem chama fecha (ex.: depois de uma ação assíncrona, usando `loading` enquanto espera).
   */
  closeOnConfirm?: boolean;
}

/**
 * Confirmação de ação (alertdialog acessível do kit de UI): foco inicial em "Cancelar" (Enter sem querer
 * não confirma uma ação destrutiva), Esc e o fundo fecham, foco preso no diálogo e devolvido ao sair.
 */
export default function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  isDestructive = false,
  children,
  loading = false,
  confirmDisabled = false,
  closeOnConfirm = true,
}: ConfirmModalProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  function handleConfirm() {
    if (loading || confirmDisabled) return;
    onConfirm();
    if (closeOnConfirm) onClose();
  }

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      role="alertdialog"
      size="sm"
      title={title}
      // A mensagem é a descrição do diálogo (aria-describedby); na tela ela aparece no corpo, com o ícone
      description={<span className="sr-only">{message}</span>}
      dismissible={!loading}
      // Sem campos no corpo, o foco começa na opção segura
      initialFocusRef={children ? undefined : cancelRef}
      footer={(
        <>
          <button ref={cancelRef} type="button" onClick={onClose} disabled={loading} className={buttonClass('secondary', 'md', 'sm:min-w-28')}>
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={loading || confirmDisabled}
            aria-busy={loading || undefined}
            className={buttonClass(isDestructive ? 'danger' : 'primary', 'md', 'sm:min-w-28')}
          >
            {loading && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
            {confirmLabel}
          </button>
        </>
      )}
    >
      <div className="flex items-start gap-4">
        <div
          className={cx(
            'shrink-0 w-11 h-11 rounded-full flex items-center justify-center',
            isDestructive
              ? 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'
              : 'bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400',
          )}
          aria-hidden="true"
        >
          <AlertTriangle size={22} />
        </div>
        <div className="min-w-0 flex-1 space-y-4">
          {/* Já anunciada como descrição do diálogo: não é lida duas vezes */}
          <div aria-hidden="true" className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">{message}</div>
          {children}
        </div>
      </div>
    </Modal>
  );
}
