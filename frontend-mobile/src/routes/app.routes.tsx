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
import AdminDashboard from '../screens/AdminDashboard'; // Importando o novo painel

export type AppStackParamList = {
  Home: undefined;
  ProductDetails: { product_id: number };
  Welcome: undefined;
  SignIn: { type: 'cliente' | 'funcionario' }; 
  Cart: undefined; 
  Checkout: undefined; 
  AddAddress: undefined;
  Profile: undefined; 
  SignUp: undefined; 
  ForgotPassword: undefined; 
  MyOrders: undefined; 
  OrderDetails: { order_id: number }; 
  PaymentPix: { payment_id: number, qr_code: string, qr_code_base64: string, total: number }; 
  PaymentCard: { payload_order: any, total: number, email: string }; 
  AdminDashboard: undefined; // Adicionando a tipagem da rota
};

const Stack = createNativeStackNavigator<AppStackParamList>();

export default function AppRoutes() {
  return (
    <Stack.Navigator 
      initialRouteName="Home" 
      screenOptions={{ headerShown: false }}
    >
      <Stack.Screen name="Home" component={Home} />
      <Stack.Screen name="ProductDetails" component={ProductDetails} />
      <Stack.Screen name="Welcome" component={Welcome} />
      <Stack.Screen name="SignIn" component={SignIn} />
      <Stack.Screen name="Cart" component={Cart} />
      <Stack.Screen name="Checkout" component={Checkout} />
      <Stack.Screen name="AddAddress" component={AddAddress} />
      <Stack.Screen name="Profile" component={Profile} />
      <Stack.Screen name="SignUp" component={SignUp} />
      <Stack.Screen name="ForgotPassword" component={ForgotPassword} />
      <Stack.Screen name="MyOrders" component={MyOrders} />
      <Stack.Screen name="OrderDetails" component={OrderDetails} />
      <Stack.Screen name="PaymentPix" component={PaymentPix} />
      <Stack.Screen name="PaymentCard" component={PaymentCard} />
      <Stack.Screen name="AdminDashboard" component={AdminDashboard} />
    </Stack.Navigator>
  );
}