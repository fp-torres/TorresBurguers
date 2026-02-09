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
import ClientLogin from '../pages/Client/Login';  // <--- Importe
import ClientSignup from '../pages/Client/Signup'; // <--- Importe

// Proteção de Rota (Admin)
function PrivateRoute({ children }: { children: JSX.Element }) {
  const token = localStorage.getItem('torresburgers.token');
  return token ? children : <Navigate to="/login" />;
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
      </Route>

      {/* Rotas de Autenticação do Cliente (Tela Cheia) */}
      <Route path="/signin" element={<ClientLogin />} />
      <Route path="/signup" element={<ClientSignup />} />


      {/* =========================================================
          ÁREA ADMINISTRATIVA (PROTEGIDA)
      ========================================================= */}
      
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