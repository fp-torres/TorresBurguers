import React, { useContext } from 'react';
import { View, Text, TouchableOpacity, FlatList, Alert } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';

import { CartContext, CartItem, MAX_ITEM_QUANTITY } from '../../contexts/CartContext';
import { AuthContext } from '../../contexts/AuthContext';
import { StoreContext } from '../../contexts/StoreContext';
import { ThemeContext } from '../../contexts/ThemeContext';
import { AppStackParamList } from '../../routes/app.routes';
import RemoteImage from '../../components/RemoteImage';
import { formatPrice } from '../../utils/format';

export default function Cart() {
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  const insets = useSafeAreaInsets();

  const { cart, removeItemFromCart, updateItemQuantity, totalCartValue } = useContext(CartContext);
  const { user } = useContext(AuthContext);
  const { isOpen, closedMessage, refresh: refreshStore } = useContext(StoreContext);
  const { activeTheme } = useContext(ThemeContext);

  async function handleCheckout() {
    // Confere o status na hora: o admin pode ter fechado a loja enquanto o cliente montava o pedido
    const status = await refreshStore();
    if (status ? !status.is_open : !isOpen) {
      Alert.alert('Loja fechada', closedMessage);
      return;
    }

    if (!user) {
      Alert.alert(
        'Falta pouco! 🍔',
        'Para finalizar seu pedido, você precisa acessar sua conta.',
        [
          { text: 'Cancelar', style: 'cancel' },
          // Depois do login o app volta para este carrinho
          { text: 'Fazer Login', onPress: () => navigation.navigate('SignIn', { type: 'cliente' }) }
        ]
      );
      return;
    }
    navigation.navigate('Checkout');
  }

  function handleGoBack() {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.popTo('Home');
  }

  const disabledIconColor = activeTheme === 'dark' ? '#475569' : '#9ca3af';
  const stepperIconColor = activeTheme === 'dark' ? '#fff' : '#0f172a';

  const renderCartItem = ({ item }: { item: CartItem }) => {
    const canDecrease = item.quantity > 1;
    const canIncrease = item.quantity < MAX_ITEM_QUANTITY;
    return (
      <View className="bg-white dark:bg-slate-800 p-4 rounded-2xl mb-4 flex-row items-center shadow-sm dark:shadow-md border border-gray-100 dark:border-transparent">

        <View className="w-20 h-20 rounded-xl overflow-hidden bg-gray-200 dark:bg-slate-700">
          <RemoteImage path={item.product.image} className="w-full h-full" />
        </View>

        <View className="flex-1 ml-4 justify-center">
          <View className="flex-row justify-between items-start">
            <Text className="text-slate-900 dark:text-white font-bold text-lg flex-1 mr-2" numberOfLines={2}>
              {item.product.name}
            </Text>
            <TouchableOpacity
              onPress={() => removeItemFromCart(item.id)}
              accessibilityRole="button"
              accessibilityLabel={`Remover ${item.product.name} do carrinho`}
              className="p-2 bg-red-50 dark:bg-slate-900 rounded-lg"
            >
              <Feather name="trash-2" size={20} color="#ef4444" />
            </TouchableOpacity>
          </View>

          {/* Escolhas da linha: ponto da carne, adicionais e observação */}
          {item.meatPoint || item.addons.length > 0 || item.observation ? (
            <View className="mt-1 mb-2">
              {item.meatPoint ? (
                <Text className="text-orange-600 dark:text-orange-400 text-xs font-bold">🔥 {item.meatPoint}</Text>
              ) : null}
              {item.addons.map((addonItem) => (
                <Text key={addonItem.addon.id} className="text-slate-500 dark:text-slate-400 text-xs">
                  + {addonItem.quantity}x {addonItem.addon.name}
                </Text>
              ))}
              {item.observation ? (
                <Text className="text-slate-500 dark:text-slate-400 text-xs italic" numberOfLines={3}>
                  Obs: {item.observation}
                </Text>
              ) : null}
            </View>
          ) : null}

          <View className="flex-row items-center justify-between mt-1">
            <Text className="text-orange-500 font-bold text-lg">
              {formatPrice(item.total)}
            </Text>

            {/* Quantidade (1 a 50); para tirar o item use a lixeira */}
            <View className="flex-row items-center bg-gray-100 dark:bg-slate-900 rounded-lg border border-gray-200 dark:border-slate-700">
              <TouchableOpacity
                onPress={() => updateItemQuantity(item.id, item.quantity - 1)}
                disabled={!canDecrease}
                accessibilityRole="button"
                accessibilityLabel={`Diminuir quantidade de ${item.product.name}`}
                className="px-2.5 py-1.5"
              >
                <Feather name="minus" size={16} color={canDecrease ? stepperIconColor : disabledIconColor} />
              </TouchableOpacity>
              <Text
                className="text-slate-900 dark:text-white font-bold text-base px-1.5 min-w-[24px] text-center"
                accessibilityLabel={`${item.quantity} ${item.quantity === 1 ? 'unidade' : 'unidades'}`}
              >
                {item.quantity}
              </Text>
              <TouchableOpacity
                onPress={() => updateItemQuantity(item.id, item.quantity + 1)}
                disabled={!canIncrease}
                accessibilityRole="button"
                accessibilityLabel={`Aumentar quantidade de ${item.product.name}`}
                className="px-2.5 py-1.5"
              >
                <Feather name="plus" size={16} color={canIncrease ? stepperIconColor : disabledIconColor} />
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </View>
    );
  };

  return (
    <View className="flex-1 bg-gray-50 dark:bg-slate-900" style={{ paddingTop: insets.top + 16 }}>
      <View className="flex-row items-center px-6 mb-6">
        <TouchableOpacity
          onPress={handleGoBack}
          accessibilityRole="button"
          accessibilityLabel="Voltar"
          className="w-10 h-10 bg-white dark:bg-slate-800 rounded-full justify-center items-center shadow-sm dark:shadow-none border border-gray-200 dark:border-transparent"
        >
          <Feather name="arrow-left" size={24} color="#f97316" />
        </TouchableOpacity>
        <Text className="text-2xl font-bold text-slate-900 dark:text-white ml-4">Seu Pedido</Text>
      </View>

      {!isOpen && cart.length > 0 && (
        <View className="mx-6 mb-4 flex-row items-center bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900/40 rounded-xl p-3">
          <Feather name="lock" size={16} color="#ef4444" />
          <Text className="text-red-700 dark:text-red-300 text-sm ml-2 flex-1">Loja fechada. {closedMessage}</Text>
        </View>
      )}

      <FlatList
        data={cart}
        keyExtractor={(item) => item.id}
        renderItem={renderCartItem}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 180 + insets.bottom }}
        ListEmptyComponent={
          <View className="items-center justify-center mt-20">
            <Feather name="shopping-bag" size={64} color={activeTheme === 'dark' ? '#475569' : '#9ca3af'} />
            <Text className="text-slate-500 dark:text-slate-400 text-lg text-center mt-4">
              Seu carrinho está vazio.{"\n"}Que tal adicionar um lanche? 🍔
            </Text>
            <TouchableOpacity className="mt-6 bg-orange-600 px-6 py-3 rounded-xl" onPress={() => navigation.popTo('Home')}>
              <Text className="text-white font-bold">Ver cardápio</Text>
            </TouchableOpacity>
          </View>
        }
      />

      {cart.length > 0 && (
        <View
          className="absolute bottom-0 w-full bg-white dark:bg-slate-800 border-t border-gray-200 dark:border-slate-700 px-6 pt-6 shadow-lg"
          style={{ paddingBottom: Math.max(insets.bottom, 16) + 16 }}
        >
          <View className="flex-row justify-between mb-1">
            <Text className="text-slate-600 dark:text-slate-300 text-lg">Subtotal:</Text>
            <Text className="text-slate-900 dark:text-white font-bold text-2xl">{formatPrice(totalCartValue)}</Text>
          </View>
          <Text className="text-slate-400 dark:text-slate-500 text-xs mb-4">
            Taxa de entrega e total final são calculados no checkout.
          </Text>

          <TouchableOpacity
            className={`w-full rounded-xl py-4 flex-row justify-center items-center ${isOpen ? 'bg-green-600 active:scale-95' : 'bg-gray-400 dark:bg-slate-600'}`}
            onPress={handleCheckout}
          >
            <Text className="text-white font-bold text-lg mr-2">{isOpen ? 'Avançar para Pagamento' : 'Loja fechada'}</Text>
            <Feather name={isOpen ? 'chevron-right' : 'lock'} size={22} color="#fff" />
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}
