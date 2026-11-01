import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { lazy, Suspense } from 'react';

import DefaultLayout from '../layouts/DefaultLayout';
import ClientLayout from '../layouts/ClientLayout';
import PlatformLayout from '../layouts/PlatformLayout';
import StoreLayout from '../layouts/StoreLayout';
import PageLoader from '../components/PageLoader';
import ErrorBoundary from '../components/ErrorBoundary';
import { LastStoreRedirect, PlatformRoute, RequireAuth, RoleRoute, StaffRoute } from './guards';

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

// Plataforma (pública): diretório de lojas e cadastro de estabelecimento
const Directory = lazy(() => import('../pages/Directory'));
const StoreSignup = lazy(() => import('../pages/Auth/StoreSignup'));

// Conta: recuperação de senha e convite da equipe
const ForgotPassword = lazy(() => import('../pages/Auth/ForgotPassword'));
const ResetPassword = lazy(() => import('../pages/Auth/ResetPassword'));
const AcceptInvitation = lazy(() => import('../pages/Auth/AcceptInvitation'));
// Conta: links recebidos por e-mail (verificação, troca de e-mail e "Não fui eu")
const VerifyEmail = lazy(() => import('../pages/Auth/VerifyEmail'));
const ConfirmEmailChange = lazy(() => import('../pages/Auth/ConfirmEmailChange'));
const RevertEmailChange = lazy(() => import('../pages/Auth/RevertEmailChange'));

// Painel da loja: áreas novas
const Customers = lazy(() => import('../pages/Customers'));
const StoreSettings = lazy(() => import('../pages/Settings'));
const Subscription = lazy(() => import('../pages/Subscription'));

// Superpainel
const PlatformDashboard = lazy(() => import('../pages/Platform/Dashboard'));
const PlatformStores = lazy(() => import('../pages/Platform/Stores'));
const PlatformStoreNew = lazy(() => import('../pages/Platform/StoreNew'));
const PlatformStoreDetail = lazy(() => import('../pages/Platform/StoreDetail'));
const PlatformPlans = lazy(() => import('../pages/Platform/Plans'));
const PlatformSubscriptions = lazy(() => import('../pages/Platform/Subscriptions'));
const PlatformUsers = lazy(() => import('../pages/Platform/Users'));
const PlatformFinance = lazy(() => import('../pages/Platform/Finance'));
const PlatformAudit = lazy(() => import('../pages/Platform/Audit'));
const PlatformSettings = lazy(() => import('../pages/Platform/Settings'));

export default function AppRoutes() {
  const { pathname } = useLocation();

  // Os layouts têm o próprio Suspense e ErrorBoundary (o cabeçalho fica visível enquanto a página carrega
  // ou se ela falhar); estes são a rede de segurança das telas sem layout (logins, contas, diretório) e dos layouts
  return (
    <ErrorBoundary resetKey={pathname}>
    <Suspense fallback={<PageLoader />}>
    <Routes>
      {/* Plataforma (pública): diretório de lojas e cadastro de estabelecimento */}
      <Route path="/" element={<Directory />} />
      <Route path="/cadastrar-loja" element={<StoreSignup />} />

      {/* Vitrine de cada loja */}
      <Route path="/loja/:slug" element={<StoreLayout />}>
        <Route index element={<ClientHome />} />
        <Route path="cart" element={<ClientCart />} />
        <Route path="order-success" element={<OrderSuccess />} />
        <Route path="*" element={<NotFound />} />
      </Route>
      {/* Endereços da versão de loja única: mesma página da última loja visitada (ou o diretório) */}
      <Route path="/cart" element={<LastStoreRedirect page="cart" />} />
      <Route path="/order-success" element={<LastStoreRedirect page="order-success" />} />

      {/* Conta do cliente (pedidos em todas as lojas) */}
      <Route element={<ClientLayout />}>
        <Route path="/my-orders" element={<RequireAuth><ClientOrders /></RequireAuth>} />
        <Route path="/profile" element={<RequireAuth><ClientProfile /></RequireAuth>} />
        {/* Qualquer endereço desconhecido: página 404 com o cabeçalho do site */}
        <Route path="*" element={<NotFound />} />
      </Route>
      <Route path="/signin" element={<ClientLogin />} />
      <Route path="/signup" element={<ClientSignup />} />
      <Route path="/esqueci-senha" element={<ForgotPassword />} />
      <Route path="/redefinir-senha/:token" element={<ResetPassword />} />
      <Route path="/convite/:token" element={<AcceptInvitation />} />
      <Route path="/verificar-email/:token" element={<VerifyEmail />} />
      <Route path="/confirmar-email/:token" element={<ConfirmEmailChange />} />
      <Route path="/desfazer-troca-de-email/:token" element={<RevertEmailChange />} />

      {/* Painel da loja. Pedidos: toda a equipe. Clientes: Administrador e Atendente.
          Dashboard, Cardápio, Equipe, Lixeira, Configurações e Assinatura: só Administrador. */}
      <Route path="/login" element={<Login />} />
      <Route element={<StaffRoute><DefaultLayout /></StaffRoute>}>
        <Route path="/dashboard" element={<RoleRoute roles={['ADMIN']}><Dashboard /></RoleRoute>} />
        <Route path="/products" element={<RoleRoute roles={['ADMIN']}><Products /></RoleRoute>} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/users" element={<RoleRoute roles={['ADMIN']}><Users /></RoleRoute>} />
        <Route path="/trash" element={<RoleRoute roles={['ADMIN']}><Trash /></RoleRoute>} />
        <Route path="/customers" element={<RoleRoute roles={['ADMIN', 'EMPLOYEE']}><Customers /></RoleRoute>} />
        <Route path="/settings" element={<RoleRoute roles={['ADMIN']}><StoreSettings /></RoleRoute>} />
        <Route path="/subscription" element={<RoleRoute roles={['ADMIN']}><Subscription /></RoleRoute>} />
      </Route>

      <Route path="/admin" element={<Navigate to="/dashboard" replace />} />

      {/* Superpainel: só o superadministrador (fora de sessão de suporte) */}
      <Route path="/platform" element={<PlatformRoute><PlatformLayout /></PlatformRoute>}>
        <Route index element={<PlatformDashboard />} />
        <Route path="stores" element={<PlatformStores />} />
        <Route path="stores/new" element={<PlatformStoreNew />} />
        <Route path="stores/:id" element={<PlatformStoreDetail />} />
        <Route path="plans" element={<PlatformPlans />} />
        <Route path="subscriptions" element={<PlatformSubscriptions />} />
        <Route path="users" element={<PlatformUsers />} />
        <Route path="finance" element={<PlatformFinance />} />
        <Route path="audit" element={<PlatformAudit />} />
        <Route path="settings" element={<PlatformSettings />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
    </Suspense>
    </ErrorBoundary>
  );
}
