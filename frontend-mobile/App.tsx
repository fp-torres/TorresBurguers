import React, { useState } from 'react';
import { StatusBar } from 'react-native';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider } from './src/contexts/AuthContext';

// AQUI ESTÁ A CORREÇÃO: Importamos o nosso Maestro de rotas!
import Routes from './src/routes'; 

export default function App() {
  const [isDark] = useState(true); 

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor="#0f172a" />
      <NavigationContainer theme={isDark ? DarkTheme : DefaultTheme}>
        <AuthProvider>
          <Routes />
        </AuthProvider>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}