import AppRoutes from './routes';
import { Toaster } from 'react-hot-toast';
import { AuthProvider } from './contexts/AuthContext';
import { CartProvider } from './contexts/CartContext';
import { ThemeProvider } from './contexts/ThemeContext'; 

export default function App() {
  return (
    <AuthProvider>
      <ThemeProvider>
        <CartProvider>
          {/* O Toaster agora usa classes do Tailwind para se adaptar ao tema */}
          <Toaster 
            position="top-right"
            toastOptions={{
              className: '!bg-white dark:!bg-slate-800 !text-gray-800 dark:!text-white !shadow-lg border dark:border-slate-700',
              success: { iconTheme: { primary: '#16a34a', secondary: '#fff' } },
              error: { iconTheme: { primary: '#ef4444', secondary: '#fff' } },
            }}
          />
          
          <AppRoutes />
          
        </CartProvider>
      </ThemeProvider>
    </AuthProvider>
  );
}