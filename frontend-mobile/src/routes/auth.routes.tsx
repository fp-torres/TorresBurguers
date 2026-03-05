import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import Welcome from '../screens/Welcome';
import SignIn from '../screens/SignIn';

// Exportação obrigatória para a Welcome saber que precisa enviar o 'type' para o SignIn
export type AuthStackParamList = {
  Welcome: undefined;
  SignIn: { type: 'cliente' | 'funcionario' }; 
};

const Stack = createNativeStackNavigator<AuthStackParamList>();

export default function AuthRoutes() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Welcome" component={Welcome} />
      <Stack.Screen name="SignIn" component={SignIn} />
    </Stack.Navigator>
  );
}