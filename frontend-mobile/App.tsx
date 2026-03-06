import React, { useState } from 'react';
import { StatusBar } from 'react-native';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider } from './src/contexts/AuthContext';
import { CartProvider } from './src/contexts/CartContext'; 
import Routes from './src/routes'; 

export default function App() {
  const [isDark] = useState(true); 

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor="#0f172a" />
      <NavigationContainer theme={isDark ? DarkTheme : DefaultTheme}>
        <AuthProvider>
          <CartProvider>
            <Routes />
          </CartProvider>
        </AuthProvider>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}