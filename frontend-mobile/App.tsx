import React, { useContext, useState } from 'react';
import { View, StatusBar, ActivityIndicator } from 'react-native';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider, AuthContext } from './src/contexts/AuthContext';

// Importando as nossas telas separadas!
import SignIn from './src/screens/SignIn';
import Home from './src/screens/home';

const Stack = createNativeStackNavigator();

// --- GERENCIADOR DE ROTAS INTELIGENTE ---
function Routes() {
  const { signed, loading } = useContext(AuthContext);

  if (loading) {
    return (
      <View className="flex-1 justify-center items-center bg-slate-900">
        <ActivityIndicator size="large" color="#ea580c" />
      </View>
    );
  }

  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      {signed ? (
        <Stack.Screen name="Home" component={Home} />
      ) : (
        <Stack.Screen name="SignIn" component={SignIn} />
      )}
    </Stack.Navigator>
  );
}

// --- APP PRINCIPAL ---
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