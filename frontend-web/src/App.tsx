import AppRoutes from './routes';
import { Toaster } from 'react-hot-toast';
import { AuthProvider } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';

/**
 * Provedores globais: sessão e tema. O que depende de uma loja não fica aqui:
 * - vitrine: perfil/status da loja e carrinho por loja são montados pelo StoreLayout (/loja/:slug);
 * - painel: o status da loja da equipe é montado pelo layout do painel.
 */
export default function App() {
  return (
    <AuthProvider>
      <ThemeProvider>
        {/* O Toaster usa classes do Tailwind para se adaptar ao tema */}
        <Toaster
          position="top-right"
          toastOptions={{
            className: '!bg-white dark:!bg-slate-800 !text-gray-800 dark:!text-white !shadow-lg border dark:border-slate-700',
            success: { iconTheme: { primary: '#16a34a', secondary: '#fff' } },
            error: { iconTheme: { primary: '#ef4444', secondary: '#fff' } },
          }}
        />

        <AppRoutes />
      </ThemeProvider>
    </AuthProvider>
  );
}
