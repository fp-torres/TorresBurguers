import React, { useContext, useEffect } from 'react';
import { View, ActivityIndicator, Image, Text } from 'react-native';

import { AuthContext } from '../contexts/AuthContext';
import { BRAND } from '../config/brand';
import AppRoutes from './app.routes';
import { navigationRef } from './navigation';

const MAX_REDIRECT_ATTEMPTS = 20;

export default function Routes() {
  const { user, loading, redirect, clearRedirect } = useContext(AuthContext);

  // Depois de um logout da equipe, de uma sessão expirada ou de um perfil alterado, abre a tela de acesso certa.
  // Espera o navegador registrar as telas públicas (elas só existem sem sessão).
  useEffect(() => {
    if (loading || user || !redirect) return;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;

    const tryNavigate = () => {
      const ready = navigationRef.isReady()
        && navigationRef.getRootState()?.routeNames?.includes(redirect.screen);
      if (ready) {
        if (redirect.screen === 'SignIn') {
          navigationRef.navigate('SignIn', { type: redirect.type, notice: redirect.notice });
        } else {
          navigationRef.navigate('Welcome');
        }
        clearRedirect();
      } else if (attempts++ < MAX_REDIRECT_ATTEMPTS) {
        timer = setTimeout(tryNavigate, 50);
      } else {
        clearRedirect();
      }
    };

    timer = setTimeout(tryNavigate, 0);
    return () => clearTimeout(timer);
  }, [user, loading, redirect, clearRedirect]);

  if (loading) {
    return (
      <View className="flex-1 justify-center items-center bg-slate-900">
        <Image source={require('../../assets/icon.png')} className="w-20 h-20 rounded-3xl mb-4" />
        <Text className="text-white text-xl font-bold mb-6">{BRAND.name}</Text>
        <ActivityIndicator size="large" color="#f97316" />
      </View>
    );
  }

  // O perfil decide as telas: equipe → painel; cliente → loja + área do cliente; visitante → loja + acesso.
  return <AppRoutes role={user?.role ?? null} />;
}
