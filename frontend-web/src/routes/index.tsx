import { Routes, Route, Navigate } from 'react-router-dom';
import Login from '../pages/Login';
import DefaultLayout from '../layouts/DefaultLayout';
import Products from '../pages/Products'; 
import Orders from '../pages/Orders'; // <--- IMPORTADO AQUI
import type { JSX } from 'react/jsx-dev-runtime'; // <--- IMPORTADO O JSX

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
        <Route path="/dashboard" element={<div className="text-3xl font-bold text-gray-800">📊 Dashboard (Em breve)</div>} />
        
        <Route path="/products" element={<Products />} /> 

        {/* ROTA DE PEDIDOS ATIVADA */}
        <Route path="/orders" element={<Orders />} /> 
        
        <Route path="/users" element={<div className="text-3xl font-bold text-gray-800">👥 Equipe (Em breve)</div>} />
      </Route>
    </Routes>
  );
}