import { Link } from 'react-router-dom';
import { CheckCircle, Home, ShoppingBag } from 'lucide-react';

export default function OrderSuccess() {
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center text-center p-6 animate-in zoom-in duration-500">
      <div className="bg-green-100 dark:bg-green-900/30 p-6 rounded-full text-green-600 dark:text-green-400 mb-6 transition-colors">
        <CheckCircle size={64} />
      </div>
      
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2 transition-colors">Pedido Confirmado! 🎉</h1>
      <p className="text-gray-500 dark:text-gray-400 max-w-md mb-8 transition-colors">
        Seu pedido foi enviado para a cozinha e já está sendo preparado com muito carinho.
      </p>

      <div className="flex flex-col sm:flex-row gap-4 w-full max-w-sm">
        {/* Botão Principal */}
        <Link 
          to="/my-orders" 
          className="flex-1 flex items-center justify-center gap-2 bg-orange-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-orange-700 transition-colors shadow-lg shadow-orange-200 dark:shadow-none"
        >
          <ShoppingBag size={20} />
          Meus Pedidos
        </Link>
        
        {/* Botão Secundário (Adaptado ao Dark Mode) */}
        <Link 
          to="/" 
          className="flex-1 flex items-center justify-center gap-2 bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-gray-200 px-6 py-3 rounded-xl font-bold hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
        >
          <Home size={20} />
          Voltar à Home
        </Link>
      </div>
    </div>
  );
}