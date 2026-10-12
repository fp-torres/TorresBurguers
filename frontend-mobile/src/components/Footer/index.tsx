import React, { useContext } from 'react';
import { View, Text, TouchableOpacity, Linking } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { AppStackParamList } from '../../routes/app.routes';
import { ThemeContext } from '../../contexts/ThemeContext';
import { AuthContext } from '../../contexts/AuthContext';
import { StoreContext } from '../../contexts/StoreContext';
import { BRAND, STORE_INFO } from '../../config/brand';
import type { FeatherIconName } from '../../utils/catalog';
import BrandWordmark from '../BrandWordmark';

/** Redes sociais configuradas em STORE_INFO.social (as vazias não aparecem). */
const SOCIAL_LINKS = ([
  { key: 'instagram', label: 'Instagram', icon: 'instagram', url: STORE_INFO.social.instagram },
  { key: 'facebook', label: 'Facebook', icon: 'facebook', url: STORE_INFO.social.facebook },
  { key: 'twitter', label: 'X (Twitter)', icon: 'twitter', url: STORE_INFO.social.twitter },
] satisfies { key: string; label: string; icon: FeatherIconName; url: string }[]).filter((link) => /^https?:\/\//i.test(link.url));

export default function Footer() {
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  const { activeTheme } = useContext(ThemeContext);
  const { user } = useContext(AuthContext);
  const { isOpen, status, closedMessage } = useContext(StoreContext);

  const isDark = activeTheme === 'dark';

  const quickLinks: { label: string; onPress: () => void }[] = [
    { label: 'Meu Carrinho', onPress: () => navigation.navigate('Cart') },
    {
      label: 'Acompanhar Pedidos',
      onPress: () => (user ? navigation.navigate('MyOrders') : navigation.navigate('SignIn', { type: 'cliente' })),
    },
    {
      label: user ? 'Minha Conta' : 'Entrar ou Cadastrar',
      onPress: () => (user ? navigation.navigate('Profile') : navigation.navigate('Welcome')),
    },
  ];

  return (
    <View className="bg-white dark:bg-slate-950 pt-10 pb-24 border-t-4 border-orange-600 mt-8 px-6">

      {/* Sobre a Loja */}
      <View className="mb-8">
        <View className="mb-2">
          <BrandWordmark size="lg" showMark />
        </View>
        <Text className="text-slate-500 dark:text-slate-400 text-sm leading-6 mb-4">
          {BRAND.tagline} Ingredientes selecionados, receitas da casa e entrega rápida.
        </Text>
        {SOCIAL_LINKS.length > 0 && (
          <View className="flex-row">
            {SOCIAL_LINKS.map((link) => (
              <TouchableOpacity
                key={link.key}
                onPress={() => Linking.openURL(link.url).catch(() => undefined)}
                accessibilityRole="link"
                accessibilityLabel={`${link.label} da loja`}
                className="bg-gray-100 dark:bg-slate-900 p-2.5 rounded-lg border border-transparent dark:border-slate-800 mr-3"
              >
                <Feather name={link.icon} size={20} color={isDark ? '#9ca3af' : '#64748b'} />
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>

      {/* Navegação Rápida */}
      <View className="mb-8">
        <Text className="text-slate-900 dark:text-white font-bold text-lg mb-4">Navegação</Text>
        <View>
          {quickLinks.map((item) => (
            <TouchableOpacity key={item.label} className="flex-row items-center py-2" onPress={item.onPress}>
              <View className="w-1.5 h-1.5 bg-orange-600 rounded-full mr-2" />
              <Text className="text-slate-600 dark:text-slate-400 text-sm">{item.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Atendimento */}
      <View className="mb-8">
        <Text className="text-slate-900 dark:text-white font-bold text-lg mb-4">Atendimento</Text>
        <View>
          {STORE_INFO.addressLine ? (
            <View className="flex-row items-start mb-4">
              <Feather name="map-pin" size={18} color="#ea580c" style={{ marginTop: 2 }} />
              <Text className="text-slate-600 dark:text-slate-400 text-sm flex-1 ml-3">
                {STORE_INFO.addressLine}{STORE_INFO.cityLine ? `\n${STORE_INFO.cityLine}` : ''}
              </Text>
            </View>
          ) : null}
          <View className="flex-row items-start mb-4">
            <Feather name="clock" size={18} color="#ea580c" style={{ marginTop: 2 }} />
            <View className="ml-3 flex-1">
              <Text className={`font-bold text-sm ${isOpen ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                {isOpen ? 'Aberto agora' : 'Fechado no momento'}
              </Text>
              <Text className="text-slate-600 dark:text-slate-400 text-sm">
                {isOpen ? (status?.opening_message?.trim() || 'Faça seu pedido pelo app.') : closedMessage}
              </Text>
            </View>
          </View>
          <TouchableOpacity
            className="flex-row items-center"
            onPress={() => Linking.openURL(`mailto:${BRAND.supportEmail}`).catch(() => undefined)}
            accessibilityRole="link"
            accessibilityLabel={`Enviar e-mail para ${BRAND.supportEmail}`}
          >
            <Feather name="mail" size={18} color="#ea580c" />
            <Text className="text-slate-600 dark:text-slate-400 text-sm ml-3">{BRAND.supportEmail}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Direitos e Acesso Func */}
      <View className="border-t border-gray-100 dark:border-slate-800 pt-6 items-center">
        <Text className="text-xs text-slate-500 mb-4 text-center">
          &copy; {new Date().getFullYear()} {BRAND.name}. Todos os direitos reservados.
        </Text>
        {!user && (
          <TouchableOpacity onPress={() => navigation.navigate('SignIn', { type: 'funcionario' })}>
            <Text className="text-xs text-orange-600 font-bold">Área do Funcionário</Text>
          </TouchableOpacity>
        )}
      </View>

    </View>
  );
}
