import { Routes, Route, Navigate } from 'react-router-dom';
import type { JSX } from 'react/jsx-dev-runtime';

// Layouts
import DefaultLayout from '../layouts/DefaultLayout'; // Admin
import ClientLayout from '../layouts/ClientLayout';   // Cliente

// Pages - Admin
import Login from '../pages/Login';
import Dashboard from '../pages/Dashboard';
import Products from '../pages/Products'; 
import Orders from '../pages/Orders'; 
import Users from '../pages/Users';

// Pages - Client
import ClientHome from '../pages/Client/Home';
import ClientCart from '../pages/Client/Cart';
import ClientLogin from '../pages/Client/Login';
import ClientSignup from '../pages/Client/Signup';
import OrderSuccess from '../pages/Client/OrderSuccess';
import ClientOrders from '../pages/Client/Orders';

// --- PROTEÇÃO DE ROTA (ADMIN/FUNCIONÁRIO) ---
function PrivateRoute({ children }: { children: JSX.Element }) {
  const token = localStorage.getItem('torresburgers.token');
  const userStored = localStorage.getItem('torresburgers.user');
  
  // Se não tem login, manda pro login do Admin
  if (!token || !userStored) {
    return <Navigate to="/login" />;
  }

  try {
    const user = JSON.parse(userStored);

    // Se o usuário logado for CLIENTE, ele NÃO pode ver o painel Admin.
    // Manda ele para a Home do site ou Meus Pedidos.
    if (user.role === 'CLIENT') {
      return <Navigate to="/" />;
    }
  } catch (error) {
    // Se deu erro ao ler o usuário, limpa tudo e manda logar de novo
    localStorage.removeItem('torresburgers.token');
    localStorage.removeItem('torresburgers.user');
    return <Navigate to="/login" />;
  }

  // Se for ADMIN ou EMPLOYEE, libera o acesso
  return children;
}

export default function AppRoutes() {
  return (
    <Routes>
      
      {/* =========================================================
          ÁREA PÚBLICA (CLIENTE)
      ========================================================= */}
      <Route path="/" element={<ClientLayout />}>
        <Route index element={<ClientHome />} />
        <Route path="cart" element={<ClientCart />} />
        <Route path="order-success" element={<OrderSuccess />} />
        <Route path="my-orders" element={<ClientOrders />} />
      </Route>

      {/* Auth do Cliente (Tela Cheia) */}
      <Route path="/signin" element={<ClientLogin />} />
      <Route path="/signup" element={<ClientSignup />} />


      {/* =========================================================
          ÁREA ADMINISTRATIVA (PROTEGIDA)
      ========================================================= */}
      
      {/* Login do Admin */}
      <Route path="/login" element={<Login />} />

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

      <Route path="/admin" element={<Navigate to="/dashboard" />} />

    </Routes>
  );
}