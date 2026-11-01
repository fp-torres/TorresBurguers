import { useId } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cx } from './styles';

export interface PaginationProps {
  /** Página atual (começa em 1). */
  page: number;
  pageSize: number;
  /** Total de itens em todas as páginas. */
  total: number;
  onPageChange: (page: number) => void;
  /** Com onPageSizeChange, mostra o seletor de itens por página (ex.: [10, 20, 50]). */
  pageSizeOptions?: number[];
  onPageSizeChange?: (pageSize: number) => void;
  /** Desabilita a navegação (ex.: durante o carregamento). */
  disabled?: boolean;
  /** Nome dos itens no resumo (ex.: "lojas"). Padrão: "registros". */
  itemLabel?: string;
  className?: string;
}

const NAV_BUTTON = 'inline-flex items-center gap-1 px-3 py-2 rounded-xl border text-sm font-bold transition-colors bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white dark:disabled:hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500';

/** Paginação das listas: resumo ("21–40 de 135"), anterior/próxima e itens por página. */
export default function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  pageSizeOptions,
  onPageSizeChange,
  disabled = false,
  itemLabel = 'registros',
  className,
}: PaginationProps) {
  const sizeId = useId();
  const safeSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(total / safeSize));
  const current = Math.min(Math.max(1, page), totalPages);
  const first = total === 0 ? 0 : (current - 1) * safeSize + 1;
  const last = Math.min(total, current * safeSize);

  return (
    <nav aria-label="Paginação" className={cx('flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3 text-sm', className)}>
      <p className="text-gray-500 dark:text-gray-400 tabular-nums" aria-live="polite">
        {total === 0 ? (
          <>Nenhum resultado</>
        ) : (
          <>
            <span className="font-bold text-gray-700 dark:text-gray-200">{first}–{last}</span> de{' '}
            <span className="font-bold text-gray-700 dark:text-gray-200">{total}</span> {itemLabel}
          </>
        )}
      </p>

      <div className="flex flex-wrap items-center justify-center gap-2">
        {pageSizeOptions && pageSizeOptions.length > 0 && onPageSizeChange && (
          <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
            <label htmlFor={sizeId} className="whitespace-nowrap">Por página</label>
            <select
              id={sizeId}
              value={pageSize}
              disabled={disabled}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
              className="px-2 py-2 rounded-xl border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-700 dark:text-gray-200 font-bold outline-none focus:ring-2 focus:ring-orange-500 disabled:opacity-60"
            >
              {pageSizeOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </div>
        )}

        <button
          type="button"
          onClick={() => onPageChange(current - 1)}
          disabled={disabled || current <= 1}
          aria-label="Página anterior"
          className={NAV_BUTTON}
        >
          <ChevronLeft size={16} aria-hidden="true" /> <span className="hidden sm:inline">Anterior</span>
        </button>
        <span className="px-1 font-semibold text-gray-600 dark:text-gray-300 tabular-nums whitespace-nowrap">
          Página {current} de {totalPages}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(current + 1)}
          disabled={disabled || current >= totalPages}
          aria-label="Próxima página"
          className={NAV_BUTTON}
        >
          <span className="hidden sm:inline">Próxima</span> <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
