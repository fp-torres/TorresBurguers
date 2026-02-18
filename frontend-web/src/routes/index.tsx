import { Routes, Route, Navigate } from 'react-router-dom';
import type { JSX } from 'react/jsx-dev-runtime';

import DefaultLayout from '../layouts/DefaultLayout'; 
import ClientLayout from '../layouts/ClientLayout';   

// Pages - Admin/Staff
import Login from '../pages/Login';
import Dashboard from '../pages/Dashboard';
import Products from '../pages/Products'; 
import Orders from '../pages/Orders'; 
import Users from '../pages/Users';
import Trash from '../pages/Trash';

// Pages - Client
import ClientHome from '../pages/Client/Home';
import ClientCart from '../pages/Client/Cart';
import ClientLogin from '../pages/Client/Login';
import ClientSignup from '../pages/Client/Signup';
import OrderSuccess from '../pages/Client/OrderSuccess';
import ClientOrders from '../pages/Client/Orders'; 
import ClientProfile from '../pages/Client/Profile'; // <--- IMPORT NOVO

function PrivateRoute({ children }: { children: JSX.Element }) {
  const token = localStorage.getItem('torresburgers.token');
  const userStored = localStorage.getItem('torresburgers.user');
  
  if (!token || !userStored) return <Navigate to="/login" />;

  try {
    const user = JSON.parse(userStored);
    if (user.role === 'CLIENT') return <Navigate to="/" />;
  } catch {
    localStorage.clear();
    return <Navigate to="/login" />;
  }

  return children;
}

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<ClientLayout />}>
        <Route index element={<ClientHome />} />
        <Route path="cart" element={<ClientCart />} />
        <Route path="order-success" element={<OrderSuccess />} />
        <Route path="my-orders" element={<ClientOrders />} />
        
        {/* NOVA ROTA CORRIGIDA */}
        <Route path="profile" element={<ClientProfile />} />
      </Route>

      <Route path="/signin" element={<ClientLogin />} />
      <Route path="/signup" element={<ClientSignup />} />
      <Route path="/login" element={<Login />} />

      <Route element={<PrivateRoute><DefaultLayout /></PrivateRoute>}>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/products" element={<Products />} /> 
        <Route path="/orders" element={<Orders />} /> 
        <Route path="/users" element={<Users />} />
        <Route path="/trash" element={<Trash />} /> 
      </Route>

      <Route path="/admin" element={<Navigate to="/dashboard" />} />
    </Routes>
  );
}