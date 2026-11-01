import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cx } from './styles';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Título (h2), que também nomeia o diálogo (aria-labelledby). */
  title: ReactNode;
  /** Texto de apoio abaixo do título (aria-describedby). */
  description?: ReactNode;
  children?: ReactNode;
  /** Botões do rodapé (ex.: Cancelar e Salvar). */
  footer?: ReactNode;
  /** Largura máxima: sm (24rem), md (32rem, padrão), lg (42rem), xl (56rem). */
  size?: ModalSize;
  /** false impede fechar (Esc, fundo e X), ex.: enquanto salva. Padrão: true. */
  dismissible?: boolean;
  /** Fecha ao clicar no fundo escuro. Padrão: true. */
  closeOnOverlayClick?: boolean;
  /** Elemento que recebe o foco ao abrir (padrão: o primeiro campo/botão do conteúdo). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** 'alertdialog' para confirmações que exigem resposta. */
  role?: 'dialog' | 'alertdialog';
  className?: string;
}

const SIZE_CLASSES: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
};

const FOCUSABLE_SELECTOR = [
  'a[href]', 'area[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', 'iframe', 'audio[controls]', 'video[controls]',
  '[contenteditable]:not([contenteditable="false"])', '[tabindex]:not([tabindex="-1"])',
].join(',');

const DIALOG_SELECTOR = '[role="dialog"],[role="alertdialog"]';

function focusableIn(container: Element): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => !element.closest('[inert]') && element.getClientRects().length > 0);
}

// Modais abertos, do mais antigo ao mais recente: só o de cima responde ao Esc e prende o foco.
const openModals: symbol[] = [];
let overflowBeforeModals = '';

/**
 * Diálogo acessível: role="dialog" + aria-modal, título ligado por aria-labelledby, Esc fecha,
 * foco inicial no conteúdo, Tab preso dentro do diálogo, foco devolvido a quem abriu, fundo escuro
 * clicável e rolagem da página travada. Renderizado em portal (acima do layout).
 */
export default function Modal(props: ModalProps) {
  if (!props.open) return null;
  return <ModalDialog {...props} />;
}

function ModalDialog({
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  dismissible = true,
  closeOnOverlayClick = true,
  initialFocusRef,
  role = 'dialog',
  className,
}: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pointerDownOnOverlay = useRef(false);

  // Versões atuais das props usadas pelos ouvintes registrados na abertura
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  useEffect(() => {
    onCloseRef.current = onClose;
    dismissibleRef.current = dismissible;
  });

  useEffect(() => {
    const id = Symbol('modal');
    if (openModals.length === 0) {
      overflowBeforeModals = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    openModals.push(id);
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const isTopmost = () => openModals[openModals.length - 1] === id;

    // Foco inicial (um campo com autoFocus no conteúdo já terá recebido o foco)
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) {
      const target = initialFocusRef?.current
        ?? (bodyRef.current ? focusableIn(bodyRef.current)[0] : undefined)
        ?? focusableIn(dialog)[0]
        ?? dialog;
      target.focus();
    }

    /** Um diálogo aberto por cima e fora desta pilha (ex.: ConfirmModal) cuida do próprio teclado. */
    function focusIsInAnotherDialog(): boolean {
      const activeDialog = document.activeElement?.closest(DIALOG_SELECTOR);
      return !!activeDialog && activeDialog !== dialogRef.current;
    }

    function trapTab(event: KeyboardEvent) {
      const current = dialogRef.current;
      if (!current) return;
      const items = focusableIn(current);
      if (items.length === 0) {
        event.preventDefault();
        current.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const outside = !active || !current.contains(active);
      if (event.shiftKey && (outside || active === first || active === current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (outside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (!isTopmost() || event.defaultPrevented || focusIsInAnotherDialog()) return;
      if (event.key === 'Escape') {
        if (!dismissibleRef.current) return;
        event.preventDefault();
        onCloseRef.current();
      } else if (event.key === 'Tab') {
        trapTab(event);
      }
    }

    // Foco que escapa do diálogo (clique fora, atalhos) volta para ele
    function handleFocusIn(event: FocusEvent) {
      const current = dialogRef.current;
      const target = event.target instanceof Element ? event.target : null;
      if (!isTopmost() || !current || !target || current.contains(target) || target.closest(DIALOG_SELECTOR)) return;
      current.focus();
    }

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('focusin', handleFocusIn);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('focusin', handleFocusIn);
      const index = openModals.indexOf(id);
      if (index >= 0) openModals.splice(index, 1);
      if (openModals.length === 0) document.body.style.overflow = overflowBeforeModals;
      // Devolve o foco a quem abriu o diálogo (se ainda estiver na página)
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [initialFocusRef]);

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
      onMouseDown={(event) => {
        pointerDownOnOverlay.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        // Só fecha se o clique começou e terminou no fundo (arrastar uma seleção de texto para fora não fecha)
        const startedOnOverlay = pointerDownOnOverlay.current;
        pointerDownOnOverlay.current = false;
        if (event.target === event.currentTarget && startedOnOverlay && closeOnOverlayClick && dismissible) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cx(
          'w-full max-h-[90vh] flex flex-col overflow-hidden rounded-2xl shadow-2xl outline-none',
          'bg-white dark:bg-slate-900 border border-gray-100 dark:border-slate-800 animate-in zoom-in-95 duration-200',
          SIZE_CLASSES[size],
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 px-6 py-4 shrink-0 bg-gray-50 dark:bg-slate-900/50 border-b border-gray-100 dark:border-slate-800">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-bold text-gray-800 dark:text-white">{title}</h2>
            {description && <p id={descriptionId} className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{description}</p>}
          </div>
          {dismissible && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Fechar"
              className="shrink-0 p-1.5 -mr-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              <X size={20} aria-hidden="true" />
            </button>
          )}
        </div>

        <div ref={bodyRef} className="flex-1 overflow-y-auto p-6 custom-scrollbar text-gray-700 dark:text-gray-200">
          {children}
        </div>

        {footer && (
          <div className="shrink-0 px-6 py-4 flex flex-col-reverse sm:flex-row sm:justify-end gap-3 bg-gray-50 dark:bg-slate-800 border-t border-gray-100 dark:border-slate-700">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
