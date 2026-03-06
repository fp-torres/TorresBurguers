import React, { useContext } from 'react';
import { StatusBar } from 'react-native';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider } from './src/contexts/AuthContext';
import { CartProvider } from './src/contexts/CartContext'; 
// Importando o nosso Cérebro de Temas
import { ThemeProvider, ThemeContext } from './src/contexts/ThemeContext'; 
import Routes from './src/routes'; 

// Este componente interno serve para conseguirmos "escutar" a mudança do tema
function AppContent() {
  const { theme } = useContext(ThemeContext);

  return (
    <>
      {/* O StatusBar muda a cor dos ícones da bateria/wifi e o fundo lá no topo do celular */}
      <StatusBar 
        barStyle={theme === 'dark' ? 'light-content' : 'dark-content'} 
        backgroundColor={theme === 'dark' ? '#0f172a' : '#f3f4f6'} 
      />
      {/* O NavigationContainer muda a cor de fundo padrão de transição das telas */}
      <NavigationContainer theme={theme === 'dark' ? DarkTheme : DefaultTheme}>
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
      {/* O ThemeProvider abraça todo o aplicativo, permitindo que qualquer tela mude o tema */}
      <ThemeProvider>
        <AppContent />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}