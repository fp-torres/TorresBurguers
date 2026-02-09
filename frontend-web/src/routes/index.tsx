import { Routes, Route, Navigate } from 'react-router-dom';
import Login from '../pages/Login';
import DefaultLayout from '../layouts/DefaultLayout';
import Products from '../pages/Products'; // <--- 1. IMPORTANTE: Importar a tela nova
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
        <Route path="/dashboard" element={<div className="text-3xl font-bold text-gray-800">📊 Dashboard (Em breve)</div>} />
        
        {/* 2. AQUI ESTAVA O ERRO: Trocamos a div pelo Componente Real */}
        <Route path="/products" element={<Products />} /> 

        <Route path="/orders" element={<div className="text-3xl font-bold text-gray-800">🍔 Pedidos (Em breve)</div>} />
        <Route path="/users" element={<div className="text-3xl font-bold text-gray-800">👥 Equipe (Em breve)</div>} />
      </Route>
    </Routes>
  );
}