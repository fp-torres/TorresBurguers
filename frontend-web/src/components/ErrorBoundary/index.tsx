import { Component, type ReactNode } from 'react';
import { AlertTriangle, Home, RefreshCw, RotateCcw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Ao mudar (ex.: o endereço da página), a tela tenta renderizar de novo. */
  resetKey?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Falha ao baixar o código de uma página carregada sob demanda. Acontece quando uma nova versão
 * é publicada com a página aberta (os arquivos antigos deixam de existir) ou quando a conexão cai.
 */
function isChunkLoadError(error: Error): boolean {
  return /dynamically imported module|Importing a module script failed|ChunkLoadError|Loading (CSS )?chunk .* failed|Unable to preload CSS/i
    .test(`${error.name} ${error.message}`);
}

/**
 * Rede de segurança das rotas: um erro de renderização ou de carregamento de página mostra
 * uma mensagem com ações (tentar de novo / recarregar) em vez de deixar a tela em branco.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    // Navegou para outra página: a nova tela tem outra chance
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  private retry = () => this.setState({ error: null });

  private reload = () => window.location.reload();

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const chunkError = isChunkLoadError(error);

    return (
      <div role="alert" className="min-h-[50vh] flex flex-col items-center justify-center text-center p-6 animate-in fade-in duration-300">
        <div className="bg-orange-100 dark:bg-orange-900/30 p-5 rounded-full text-orange-600 dark:text-orange-400 mb-5">
          <AlertTriangle size={44} />
        </div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
          {chunkError ? 'Há uma nova versão do sistema' : 'Algo deu errado nesta tela'}
        </h1>
        <p className="text-gray-500 dark:text-gray-400 max-w-md mb-8">
          {chunkError
            ? 'Não foi possível carregar esta página. Recarregue para usar a versão mais recente (seu carrinho continua salvo).'
            : 'Um erro inesperado impediu a exibição desta página. Tente de novo ou recarregue; seu carrinho continua salvo.'}
        </p>

        <div className="flex flex-col sm:flex-row gap-3 w-full max-w-md">
          <button
            type="button"
            onClick={this.reload}
            className="flex-1 flex items-center justify-center gap-2 bg-orange-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-orange-700 transition-colors"
          >
            <RefreshCw size={18} /> Recarregar página
          </button>
          {!chunkError && (
            <button
              type="button"
              onClick={this.retry}
              className="flex-1 flex items-center justify-center gap-2 bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-gray-200 px-6 py-3 rounded-xl font-bold hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
            >
              <RotateCcw size={18} /> Tentar de novo
            </button>
          )}
          {/* Link comum (não o do roteador): funciona mesmo se o erro veio de fora das rotas */}
          <a
            href="/"
            className="flex-1 flex items-center justify-center gap-2 bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-gray-200 px-6 py-3 rounded-xl font-bold hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
          >
            <Home size={18} /> Início
          </a>
        </div>
      </div>
    );
  }
}
