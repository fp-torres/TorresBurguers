import { cx } from '../ui/styles';

export interface ChartDataDetailsProps {
  /** Nome dos dados (legenda da tabela). */
  caption: string;
  /** Cabeçalhos: a primeira coluna é a categoria; as demais, valores (alinhados à direita). */
  columns: string[];
  rows: string[][];
  /** Texto do botão que abre a tabela. */
  summary?: string;
}

/** Os mesmos dados de um gráfico em tabela, recolhida (alternativa acessível e para conferência). */
export default function ChartDataDetails({ caption, columns, rows, summary = 'Ver dados em tabela' }: ChartDataDetailsProps) {
  return (
    <details className="mt-3">
      <summary className="cursor-pointer select-none text-xs font-bold text-gray-500 dark:text-gray-400 hover:text-orange-600 dark:hover:text-orange-400 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 w-fit">
        {summary}
      </summary>
      <div className="mt-2 max-h-72 overflow-auto custom-scrollbar rounded-xl border border-gray-100 dark:border-slate-700">
        <table className="w-full text-xs">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 bg-gray-50 dark:bg-slate-900 text-gray-600 dark:text-gray-400">
            <tr>
              {columns.map((column, index) => (
                <th key={column} scope="col" className={cx('px-3 py-2 font-semibold whitespace-nowrap', index === 0 ? 'text-left' : 'text-right')}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-slate-700 text-gray-700 dark:text-gray-200">
            {rows.map((row, rowIndex) => (
              <tr key={`${row[0]}-${rowIndex}`}>
                {row.map((cell, index) => (
                  index === 0
                    ? <th key={index} scope="row" className="px-3 py-1.5 text-left font-normal">{cell}</th>
                    : <td key={index} className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
