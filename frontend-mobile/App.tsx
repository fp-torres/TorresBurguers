import React, { useContext } from 'react';
import { StatusBar } from 'react-native';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider } from './src/contexts/AuthContext';
import { CartProvider } from './src/contexts/CartContext'; 
import { ThemeProvider, ThemeContext } from './src/contexts/ThemeContext'; 
import Routes from './src/routes'; 

function AppContent() {
  // Agora usamos o activeTheme, que sabe exatamente qual cor está renderizando
  const { activeTheme } = useContext(ThemeContext);

  return (
    <>
      <StatusBar 
        barStyle={activeTheme === 'dark' ? 'light-content' : 'dark-content'} 
        backgroundColor={activeTheme === 'dark' ? '#0f172a' : '#f9fafb'} 
      />
      <NavigationContainer theme={activeTheme === 'dark' ? DarkTheme : DefaultTheme}>
        <AuthProvider>
          <CartProvider>
            <Routes />
          </CartProvider>
        </AuthProvider>
      </NavigationContainer>
    </>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AppContent />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}