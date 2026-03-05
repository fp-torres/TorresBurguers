import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import Home from '../screens/home'; 
import ProductDetails from '../screens/ProductDetails';
import Welcome from '../screens/Welcome';
import SignIn from '../screens/SignIn';

export type AppStackParamList = {
  Home: undefined;
  ProductDetails: { product_id: number };
  Welcome: undefined;
  SignIn: { type: 'cliente' | 'funcionario' }; 
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
    </Stack.Navigator>
  );
}