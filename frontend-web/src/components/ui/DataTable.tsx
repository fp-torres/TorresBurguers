import { Fragment, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import EmptyState from './EmptyState';
import ErrorState from './ErrorState';
import { CARD_CLASS, cx } from './styles';
import { useMediaQuery } from '../../hooks/useMediaQuery';

export type ColumnAlign = 'left' | 'center' | 'right';

/**
 * Papel da coluna no modo empilhado (stackOnMobile, abaixo de sm):
 * - 'primary': topo do cartão, sem rótulo (ex.: nome com avatar);
 * - 'field': par "rótulo: valor";
 * - 'actions': rodapé do cartão, sempre visível;
 * - 'hidden': fora do cartão (a informação já aparece em outra coluna).
 */
export type ColumnMobileRole = 'primary' | 'field' | 'actions' | 'hidden';

export interface DataTableColumn<T> {
  /** Identificador único da coluna. */
  key: string;
  /** Cabeçalho; para colunas sem texto visível (ex.: ações), use <span className="sr-only">Ações</span>. */
  header: ReactNode;
  /** Conteúdo da célula. */
  cell: (row: T, index: number) => ReactNode;
  align?: ColumnAlign;
  /** Classes extras das células (ex.: largura, "hidden md:table-cell"). Não valem no modo empilhado. */
  className?: string;
  /** Classes extras do cabeçalho (use as mesmas de visibilidade das células). */
  headerClassName?: string;
  /**
   * Papel no modo empilhado. Padrão: a primeira coluna é 'primary', a coluna de key "actions" é 'actions'
   * e as demais são 'field' (inclusive as escondidas na tabela estreita com "hidden md:table-cell").
   */
  mobile?: ColumnMobileRole;
  /** Rótulo no modo empilhado (padrão: o próprio cabeçalho). */
  mobileLabel?: ReactNode;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string | number;
  /** Nome acessível da tabela (legenda lida por leitores de tela e rótulo da área rolável). */
  caption: string;
  /** Carregando: sem linhas mostra o esqueleto; com linhas, elas ficam esmaecidas até a resposta. */
  loading?: boolean;
  /** Erro: sem linhas mostra o ErrorState; com linhas, um aviso acima delas. */
  error?: string | null;
  /** Ação do "Tentar novamente". */
  onRetry?: () => void;
  emptyTitle?: string;
  emptyDescription?: ReactNode;
  emptyIcon?: ReactNode;
  emptyAction?: ReactNode;
  /** Linhas do esqueleto de carregamento (padrão: 5). */
  skeletonRows?: number;
  /**
   * Classes da área rolável. O cabeçalho fica fixo dentro dela; o padrão limita a altura a 70% da tela
   * para que a rolagem (e o cabeçalho fixo) aconteça dentro da tabela. No modo empilhado, só vale quando
   * informada (ex.: lista dentro de um modal); sem ela, os cartões rolam com a página.
   */
  scrollClassName?: string;
  /** Classes extras por linha (ex.: destacar bloqueados). */
  rowClassName?: (row: T, index: number) => string | undefined;
  /** Rodapé do cartão (ex.: <Pagination />). */
  footer?: ReactNode;
  className?: string;
  /**
   * Modo responsivo: abaixo de sm (640px), cada linha vira um cartão com pares "rótulo: valor" e as ações
   * visíveis, em vez da rolagem horizontal. A partir de sm a tabela é a mesma de sempre.
   */
  stackOnMobile?: boolean;
}

const ALIGN_CLASSES: Record<ColumnAlign, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

/** Abaixo do breakpoint sm do Tailwind (40rem). Sem suporte à media query, vale a tabela. */
const NARROW_SCREEN_QUERY = '(width < 40rem)';

/** Larguras variadas e estáveis para as barras do esqueleto. */
function skeletonWidth(row: number, column: number): string {
  return `${55 + ((row * 17 + column * 29) % 40)}%`;
}

function mobileRoleOf<T>(column: DataTableColumn<T>, index: number): ColumnMobileRole {
  if (column.mobile) return column.mobile;
  if (column.key === 'actions') return 'actions';
  return index === 0 ? 'primary' : 'field';
}

/**
 * Tabela de dados do painel: colunas tipadas, cabeçalho fixo, rolagem horizontal em telas estreitas
 * (ou cartões empilhados com stackOnMobile) e os estados de carregamento (esqueleto), vazio e erro com
 * "Tentar novamente".
 */
export default function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  loading = false,
  error = null,
  onRetry,
  emptyTitle = 'Nenhum registro encontrado',
  emptyDescription,
  emptyIcon,
  emptyAction,
  skeletonRows = 5,
  scrollClassName,
  rowClassName,
  footer,
  className,
  stackOnMobile = false,
}: DataTableProps<T>) {
  const narrowScreen = useMediaQuery(NARROW_SCREEN_QUERY);
  const stacked = stackOnMobile && narrowScreen;
  const hasRows = rows.length > 0;
  const showSkeleton = loading && !hasRows;
  const showError = !loading && !!error && !hasRows;
  const showEmpty = !loading && !error && !hasRows;

  return (
    <div className={cx(CARD_CLASS, 'overflow-hidden flex flex-col min-w-0', className)}>
      {/* Falha numa atualização: os dados anteriores continuam na tela, com o aviso */}
      {error && hasRows && !loading && (
        <div role="alert" className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border-b border-amber-200 dark:border-amber-800">
          <AlertTriangle size={16} className="shrink-0" aria-hidden="true" />
          <span className="flex-1 min-w-48">{error} Os dados abaixo podem estar desatualizados.</span>
          {onRetry && (
            <button type="button" onClick={onRetry} className="inline-flex items-center gap-1.5 font-bold hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
              <RotateCcw size={14} aria-hidden="true" /> Tentar novamente
            </button>
          )}
        </div>
      )}

      {showError ? (
        <ErrorState message={error} onRetry={onRetry} compact />
      ) : showEmpty ? (
        <EmptyState title={emptyTitle} description={emptyDescription} icon={emptyIcon} action={emptyAction} compact />
      ) : stacked ? (
        <StackedRows
          columns={columns}
          rows={rows}
          rowKey={rowKey}
          caption={caption}
          loading={loading}
          showSkeleton={showSkeleton}
          skeletonRows={skeletonRows}
          scrollClassName={scrollClassName}
          rowClassName={rowClassName}
        />
      ) : (
        // Área rolável focável: quem usa teclado também consegue rolar a tabela
        <div
          role="region"
          aria-label={caption}
          tabIndex={0}
          className={cx(
            'relative overflow-auto custom-scrollbar focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-500',
            scrollClassName ?? 'max-h-[70vh]',
          )}
        >
          <table className="w-full text-sm" aria-busy={loading || undefined}>
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className={cx(
                      'sticky top-0 z-10 px-4 sm:px-6 py-3.5 font-semibold whitespace-nowrap',
                      'bg-gray-50 dark:bg-slate-900 text-gray-600 dark:text-gray-400',
                      'shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] dark:shadow-[inset_0_-1px_0_rgba(255,255,255,0.08)]',
                      ALIGN_CLASSES[column.align ?? 'left'],
                      column.headerClassName,
                    )}
                  >
                    {column.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={cx('divide-y divide-gray-100 dark:divide-slate-700', loading && hasRows && 'opacity-60 transition-opacity')}>
              {showSkeleton
                ? Array.from({ length: skeletonRows }, (_, rowIndex) => (
                  <tr key={`skeleton-${rowIndex}`} aria-hidden="true">
                    {columns.map((column, columnIndex) => (
                      <td key={column.key} className={cx('px-4 sm:px-6 py-4', column.className)}>
                        <div className="h-4 rounded-md bg-gray-200 dark:bg-slate-700 animate-pulse" style={{ width: skeletonWidth(rowIndex, columnIndex) }} />
                      </td>
                    ))}
                  </tr>
                ))
                : rows.map((row, rowIndex) => (
                  <tr key={rowKey(row, rowIndex)} className={cx('hover:bg-gray-50 dark:hover:bg-slate-700/50 transition-colors', rowClassName?.(row, rowIndex))}>
                    {columns.map((column) => (
                      <td
                        key={column.key}
                        className={cx('px-4 sm:px-6 py-4 align-middle text-gray-700 dark:text-gray-200', ALIGN_CLASSES[column.align ?? 'left'], column.className)}
                      >
                        {column.cell(row, rowIndex)}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
          {showSkeleton && <span className="sr-only" role="status">Carregando {caption.toLowerCase()}...</span>}
        </div>
      )}

      {footer && <div className="border-t border-gray-100 dark:border-slate-700">{footer}</div>}
    </div>
  );
}

interface StackedRowsProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string | number;
  caption: string;
  loading: boolean;
  showSkeleton: boolean;
  skeletonRows: number;
  scrollClassName?: string;
  rowClassName?: (row: T, index: number) => string | undefined;
}

/**
 * Modo empilhado (celular): uma lista (ul) nomeada pela legenda da tabela; cada linha é um cartão (li) com a
 * coluna principal no topo, os demais dados numa lista de definições (dl: "rótulo: valor") e as ações no rodapé.
 */
function StackedRows<T>({
  columns, rows, rowKey, caption, loading, showSkeleton, skeletonRows, scrollClassName, rowClassName,
}: StackedRowsProps<T>) {
  const roles = columns.map((column, index) => ({ column, role: mobileRoleOf(column, index) }));
  const primary = roles.filter((item) => item.role === 'primary').map((item) => item.column);
  const fields = roles.filter((item) => item.role === 'field').map((item) => item.column);
  const actions = roles.filter((item) => item.role === 'actions').map((item) => item.column);

  const list = showSkeleton ? (
    <ul aria-hidden="true" className="divide-y divide-gray-100 dark:divide-slate-700">
      {Array.from({ length: skeletonRows }, (_, rowIndex) => (
        <li key={`skeleton-${rowIndex}`} className="px-4 py-4 space-y-2.5">
          {[0, 1, 2].map((barIndex) => (
            <div key={barIndex} className="h-4 rounded-md bg-gray-200 dark:bg-slate-700 animate-pulse" style={{ width: skeletonWidth(rowIndex, barIndex) }} />
          ))}
        </li>
      ))}
    </ul>
  ) : (
    <ul
      aria-label={caption}
      aria-busy={loading || undefined}
      className={cx('divide-y divide-gray-100 dark:divide-slate-700', loading && 'opacity-60 transition-opacity')}
    >
      {rows.map((row, rowIndex) => (
        <li
          key={rowKey(row, rowIndex)}
          className={cx('flex flex-col gap-3 px-4 py-4 text-sm text-gray-700 dark:text-gray-200', rowClassName?.(row, rowIndex))}
        >
          {primary.map((column) => (
            <div key={column.key} className="min-w-0">{column.cell(row, rowIndex)}</div>
          ))}
          {fields.length > 0 && (
            <dl className="grid gap-2">
              {fields.map((column) => (
                <div key={column.key} className="grid grid-cols-[minmax(6.5rem,38%)_minmax(0,1fr)] items-baseline gap-x-3">
                  <dt className="text-xs font-semibold text-gray-500 dark:text-gray-400">{column.mobileLabel ?? column.header}</dt>
                  <dd className="min-w-0 wrap-break-word">{column.cell(row, rowIndex)}</dd>
                </div>
              ))}
            </dl>
          )}
          {actions.length > 0 && (
            <div className="flex flex-wrap items-center justify-end gap-2 pt-3 border-t border-gray-100 dark:border-slate-700">
              {actions.map((column) => <Fragment key={column.key}>{column.cell(row, rowIndex)}</Fragment>)}
            </div>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <>
      {scrollClassName ? (
        // Altura limitada (ex.: dentro de um modal): área rolável focável, como na tabela
        <div
          role="region"
          aria-label={caption}
          tabIndex={0}
          className={cx('overflow-auto custom-scrollbar focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-500', scrollClassName)}
        >
          {list}
        </div>
      ) : list}
      {showSkeleton && <span className="sr-only" role="status">Carregando {caption.toLowerCase()}...</span>}
    </>
  );
}
