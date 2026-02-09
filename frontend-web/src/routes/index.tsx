import { Routes, Route, Navigate } from 'react-router-dom';
import type { JSX } from 'react/jsx-dev-runtime';

// Layouts
import DefaultLayout from '../layouts/DefaultLayout'; // Layout do Admin (com Sidebar)
import ClientLayout from '../layouts/ClientLayout';   // Layout do Cliente (Header fixo)

// Pages - Admin
import Login from '../pages/Login';
import Dashboard from '../pages/Dashboard';
import Products from '../pages/Products'; 
import Orders from '../pages/Orders'; 
import Users from '../pages/Users';

// Pages - Client
import ClientHome from '../pages/Client/Home';

// Proteção de Rota (Apenas para Admin)
function PrivateRoute({ children }: { children: JSX.Element }) {
  const token = localStorage.getItem('torresburgers.token');
  // Se não tiver token, manda para o Login (/login), pois a raiz (/) agora é o cardápio público
  return token ? children : <Navigate to="/login" />;
}

export default function AppRoutes() {
  return (
    <Routes>
      
      {/* =========================================================
          ÁREA PÚBLICA (CLIENTE - MOBILE FIRST) 
          Acesse: http://localhost:5173/
      ========================================================= */}
      <Route path="/" element={<ClientLayout />}>
        <Route index element={<ClientHome />} />
        <Route path="cart" element={<div className="p-10 text-center">🛒 Carrinho (Em breve)</div>} />
      </Route>


      {/* =========================================================
          ÁREA ADMINISTRATIVA 
          Acesse: http://localhost:5173/login ou /dashboard
      ========================================================= */}
      
      {/* Tela de Login Admin */}
      <Route path="/login" element={<Login />} />

      {/* Rotas Protegidas (Dashboard, Pedidos, etc) */}
      <Route element={
        <PrivateRoute>
          <DefaultLayout />
        </PrivateRoute>
      }>
        <Route path="/dashboard" element={<Dashboard />} />
        
        <Route path="/products" element={<Products />} /> 

        <Route path="/orders" element={<Orders />} /> 
        
        <Route path="/users" element={<Users />} />
      </Route>

      {/* Redirecionamento de conveniência: /admin -> /dashboard */}
      <Route path="/admin" element={<Navigate to="/dashboard" />} />

    </Routes>
  );
}