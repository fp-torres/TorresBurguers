import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { lazy, Suspense, type ReactNode } from 'react';

import DefaultLayout from '../layouts/DefaultLayout';
import ClientLayout from '../layouts/ClientLayout';
import PageLoader from '../components/PageLoader';
import ErrorBoundary from '../components/ErrorBoundary';
import { useAuth } from '../contexts/AuthContext';
import { homePathForRole, isStaffRole, type UserRole } from '../utils/roles';

// Pages - Admin/Staff
import Login from '../pages/Login';

// Pages - Client
import ClientHome from '../pages/Client/Home';
import ClientLogin from '../pages/Client/Login';
import ClientSignup from '../pages/Client/Signup';
import OrderSuccess from '../pages/Client/OrderSuccess';
import ClientOrders from '../pages/Client/Orders';
import ClientProfile from '../pages/Client/Profile';
import NotFound from '../pages/NotFound';

// Carregadas sob demanda: quem só usa a loja não baixa o painel (nem os gráficos),
// e o checkout (cartão e PIX) só é baixado ao abrir o carrinho.
const Dashboard = lazy(() => import('../pages/Dashboard'));
const Products = lazy(() => import('../pages/Products'));
const Orders = lazy(() => import('../pages/Orders'));
const Users = lazy(() => import('../pages/Users'));
const Trash = lazy(() => import('../pages/Trash'));
const ClientCart = lazy(() => import('../pages/Client/Cart'));

/** Painel interno: exige um perfil da equipe. Visitantes vão para /login e clientes voltam para a loja. */
function StaffRoute({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  
  if (!user) return <Navigate to="/login" replace />;
  if (!isStaffRole(user.role)) return <Navigate to="/" replace />;

  return <>{children}</>;
}

/** Página restrita a alguns perfis; os demais são levados à página inicial do próprio perfil. */
function RoleRoute({ roles, children }: { roles: UserRole[]; children: ReactNode }) {
  const { user } = useAuth();

  if (!user || !roles.includes(user.role)) return <Navigate to={homePathForRole(user?.role)} replace />;

  return <>{children}</>;
}

/** Área da conta (Meus Pedidos, Meus Dados): exige login. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useAuth();

  if (!user) return <Navigate to="/signin" replace />;

  return <>{children}</>;
}

export default function AppRoutes() {
  const { pathname } = useLocation();

  // Os layouts têm o próprio Suspense e ErrorBoundary (o cabeçalho fica visível enquanto a página carrega
  // ou se ela falhar); estes são a rede de segurança das telas sem layout (logins) e dos próprios layouts
  return (
    <ErrorBoundary resetKey={pathname}>
    <Suspense fallback={<PageLoader />}>
    <Routes>
      <Route path="/" element={<ClientLayout />}>
        <Route index element={<ClientHome />} />
        <Route path="cart" element={<ClientCart />} />
        <Route path="order-success" element={<OrderSuccess />} />
        <Route path="my-orders" element={<RequireAuth><ClientOrders /></RequireAuth>} />
        <Route path="profile" element={<RequireAuth><ClientProfile /></RequireAuth>} />
        {/* Qualquer endereço desconhecido: página 404 com o layout da loja */}
        <Route path="*" element={<NotFound />} />
      </Route>

      <Route path="/signin" element={<ClientLogin />} />
      <Route path="/signup" element={<ClientSignup />} />
      <Route path="/login" element={<Login />} />

      {/* Pedidos: toda a equipe. Dashboard, Cardápio, Equipe e Lixeira: só Administrador. */}
      <Route element={<StaffRoute><DefaultLayout /></StaffRoute>}>
        <Route path="/dashboard" element={<RoleRoute roles={['ADMIN']}><Dashboard /></RoleRoute>} />
        <Route path="/products" element={<RoleRoute roles={['ADMIN']}><Products /></RoleRoute>} />
        <Route path="/orders" element={<Orders />} /> 
        <Route path="/users" element={<RoleRoute roles={['ADMIN']}><Users /></RoleRoute>} />
        <Route path="/trash" element={<RoleRoute roles={['ADMIN']}><Trash /></RoleRoute>} />
      </Route>

      <Route path="/admin" element={<Navigate to="/dashboard" replace />} />
    </Routes>
    </Suspense>
    </ErrorBoundary>
  );
}
