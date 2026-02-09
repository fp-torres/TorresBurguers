import { Routes, Route, Navigate } from 'react-router-dom';
import Login from '../pages/Login';
import DefaultLayout from '../layouts/DefaultLayout';
import Products from '../pages/Products'; 
import Orders from '../pages/Orders'; 
import Dashboard from '../pages/Dashboard'; // <--- IMPORTADO AQUI
import type { JSX } from 'react/jsx-dev-runtime'; 

// Proteção de Rota
function PrivateRoute({ children }: { children: JSX.Element }) {
  const token = localStorage.getItem('torresburgers.token');
  return token ? children : <Navigate to="/" />;
}

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Login />} />
      
      {/* Rotas Protegidas com Layout */}
      <Route element={
        <PrivateRoute>
          <DefaultLayout />
        </PrivateRoute>
      }>
        {/* ROTA DASHBOARD ATIVADA */}
        <Route path="/dashboard" element={<Dashboard />} />
        
        <Route path="/products" element={<Products />} /> 

        <Route path="/orders" element={<Orders />} /> 
        
        <Route path="/users" element={<div className="text-3xl font-bold text-gray-800">👥 Equipe (Em breve)</div>} />
      </Route>
    </Routes>
  );
}