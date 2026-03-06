import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import Home from '../screens/home'; 
import ProductDetails from '../screens/ProductDetails';
import Welcome from '../screens/Welcome';
import SignIn from '../screens/SignIn';
import Cart from '../screens/Cart'; 
import Checkout from '../screens/Checkout';

export type AppStackParamList = {
  Home: undefined;
  ProductDetails: { product_id: number };
  Welcome: undefined;
  SignIn: { type: 'cliente' | 'funcionario' }; 
  Cart: undefined; 
  Checkout: undefined; // Registramos o Checkout
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
    </Stack.Navigator>
  );
}