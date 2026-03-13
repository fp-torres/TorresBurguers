import React, { useContext } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { AuthContext } from '../contexts/AuthContext';

import AppRoutes from './app.routes';

export default function Routes() {
  const { loading } = useContext(AuthContext);

  if (loading) {
    return (
      <View className="flex-1 justify-center items-center bg-slate-900">
        <ActivityIndicator size="large" color="#f97316" />
      </View>
    );
  }

  return <AppRoutes />;
}