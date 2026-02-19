import AppRoutes from './routes';
import { Toaster } from 'react-hot-toast';
import { AuthProvider } from './contexts/AuthContext';
import { CartProvider } from './contexts/CartContext';
import { ThemeProvider } from './contexts/ThemeContext'; // Importação do Tema

export default function App() {
  return (
    <AuthProvider>
      {/* ThemeProvider precisa estar dentro do Auth (caso queira salvar tema no perfil do user futuramente) */}
      <ThemeProvider>
        <CartProvider>
          {/* Configuração Global das Notificações */}
          <Toaster 
            position="top-right"
            toastOptions={{
              style: {
                background: '#333',
                color: '#fff',
                borderRadius: '12px',
                fontSize: '14px',
                padding: '12px',
              },
              success: { iconTheme: { primary: '#16a34a', secondary: '#fff' } },
              error: { iconTheme: { primary: '#ef4444', secondary: '#fff' } },
            }}
          />
          
          {/* As rotas ficam no miolo, com acesso a todos os contextos acima */}
          <AppRoutes />
          
        </CartProvider>
      </ThemeProvider>
    </AuthProvider>
  );
}