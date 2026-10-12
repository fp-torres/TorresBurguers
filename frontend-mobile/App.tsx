import './src/config/accessibility';
import React, { useContext } from 'react';
import { StatusBar } from 'react-native';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider } from './src/contexts/AuthContext';
import { CartProvider } from './src/contexts/CartContext';
import { StoreProvider } from './src/contexts/StoreContext';
import { ThemeProvider, ThemeContext } from './src/contexts/ThemeContext';
import Routes from './src/routes';
import { navigationRef } from './src/routes/navigation';

function AppContent() {
  // Agora usamos o activeTheme, que sabe exatamente qual cor está renderizando
  const { activeTheme } = useContext(ThemeContext);

  return (
    <>
      <StatusBar
        barStyle={activeTheme === 'dark' ? 'light-content' : 'dark-content'}
        backgroundColor={activeTheme === 'dark' ? '#0f172a' : '#f9fafb'}
      />
      <NavigationContainer ref={navigationRef} theme={activeTheme === 'dark' ? DarkTheme : DefaultTheme}>
        <AuthProvider>
          <StoreProvider>
            <CartProvider>
              <Routes />
            </CartProvider>
          </StoreProvider>
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
