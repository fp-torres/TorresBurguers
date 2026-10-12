import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import Home from '../screens/home';
import ProductDetails from '../screens/ProductDetails';
import Welcome from '../screens/Welcome';
import SignIn from '../screens/SignIn';
import Cart from '../screens/Cart';
import Checkout from '../screens/Checkout';
import AddAddress from '../screens/AddAddress';
import Profile from '../screens/Profile';
import SignUp from '../screens/SignUp';
import ForgotPassword from '../screens/ForgotPassword';
import MyOrders from '../screens/MyOrders';
import OrderDetails from '../screens/OrderDetails';
import PaymentPix from '../screens/PaymentPix';
import PaymentCard from '../screens/PaymentCard';
import AdminDashboard from '../screens/AdminDashboard';
import { isStaffRole } from '../utils/roles';
import type { SessionNotice } from '../contexts/AuthContext';

/**
 * Parâmetros livres: as telas de checkout/pagamento tipam os próprios params localmente
 * (useRoute com tipo da tela), então aqui só exigimos um objeto.
 */
type ScreenParams = Record<string, unknown> | undefined;

export type LoginType = 'cliente' | 'funcionario';

export type AppStackParamList = {
  // Loja (visitantes e clientes)
  Home: undefined;
  ProductDetails: { product_id: number };
  Cart: undefined;
  // Acesso (somente sem login)
  Welcome: undefined;
  /** notice: aviso de sessão encerrada pelo app (expirada ou perfil de acesso alterado). */
  SignIn: { type: LoginType; notice?: SessionNotice } | undefined;
  SignUp: undefined;
  ForgotPassword: undefined;
  // Área do cliente (CLIENT logado)
  Checkout: ScreenParams;
  AddAddress: undefined;
  Profile: undefined;
  MyOrders: ScreenParams;
  OrderDetails: { order_id: number };
  PaymentPix: ScreenParams;
  PaymentCard: ScreenParams;
  // Painel da equipe (ADMIN, EMPLOYEE, KITCHEN, COURIER)
  AdminDashboard: undefined;
};

const Stack = createNativeStackNavigator<AppStackParamList>();

/**
 * Uma única pilha cujas telas dependem da sessão (padrão "auth flow" do React Navigation):
 * ao entrar/sair, as telas que deixam de existir saem da pilha e o usuário continua de onde estava
 * (ex.: carrinho → login → carrinho). A equipe vê apenas o painel; o perfil decide as seções.
 */
export default function AppRoutes({ role }: { role: string | null }) {
  const isStaff = isStaffRole(role);
  const isClient = !!role && !isStaff;

  return (
    <Stack.Navigator
      initialRouteName={isStaff ? 'AdminDashboard' : 'Home'}
      screenOptions={{ headerShown: false }}
    >
      {isStaff ? (
        <Stack.Screen name="AdminDashboard" component={AdminDashboard} />
      ) : (
        <>
          <Stack.Screen name="Home" component={Home} />
          <Stack.Screen name="ProductDetails" component={ProductDetails} />
          <Stack.Screen name="Cart" component={Cart} />
          {isClient ? (
            <>
              <Stack.Screen name="Checkout" component={Checkout} />
              <Stack.Screen name="AddAddress" component={AddAddress} />
              <Stack.Screen name="Profile" component={Profile} />
              <Stack.Screen name="MyOrders" component={MyOrders} />
              <Stack.Screen name="OrderDetails" component={OrderDetails} />
              {/* Pagamentos: sem gesto de voltar (iOS); a tela decide quando é seguro sair */}
              <Stack.Screen name="PaymentPix" component={PaymentPix} options={{ gestureEnabled: false }} />
              <Stack.Screen name="PaymentCard" component={PaymentCard} options={{ gestureEnabled: false }} />
            </>
          ) : (
            <>
              <Stack.Screen name="Welcome" component={Welcome} />
              <Stack.Screen name="SignIn" component={SignIn} />
              <Stack.Screen name="SignUp" component={SignUp} />
              <Stack.Screen name="ForgotPassword" component={ForgotPassword} />
            </>
          )}
        </>
      )}
    </Stack.Navigator>
  );
}
