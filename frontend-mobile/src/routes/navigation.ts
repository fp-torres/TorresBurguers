import { createNavigationContainerRef } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { AppStackParamList } from './app.routes';

/** Referência do NavigationContainer, para navegar fora das telas (ex.: sessão expirada). */
export const navigationRef = createNavigationContainerRef<AppStackParamList>();

type AppNavigation = NativeStackNavigationProp<AppStackParamList>;

/**
 * Leva o cliente para "Meus Pedidos" com a Home por baixo (voltar → Home),
 * sem empilhar telas de checkout/pagamento. Use depois de concluir um pedido.
 */
export function resetToMyOrders(navigation: AppNavigation) {
  navigation.reset({ index: 1, routes: [{ name: 'Home' }, { name: 'MyOrders' }] });
}

/** Volta para a Home existente na pilha (ou a recria), sem duplicá-la. */
export function backToHome(navigation: AppNavigation) {
  navigation.popTo('Home');
}
