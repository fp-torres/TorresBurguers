import React, { useEffect, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, StyleProp, ViewStyle } from 'react-native';

interface KeyboardAwareScreenProps {
  children: React.ReactNode;
  className?: string;
  /** O plugin do NativeWind pode converter o className deste componente em `style`, então aceitamos os dois. */
  style?: StyleProp<ViewStyle>;
}

/**
 * Raiz das telas com formulário. Com o teclado aberto, o espaço dele vira padding no fim da tela:
 * o ScrollView (flex-1) encolhe, o campo focado é rolado para a área visível e o rodapé, que fica
 * no fluxo logo depois do ScrollView (não `absolute`), aparece acima do teclado com o botão principal.
 *
 * Usa behavior "padding" nas duas plataformas. No Android o "height" não funciona: o `flex-1` do
 * NativeWind vira flexGrow 1, que vence a altura calculada pelo KeyboardAvoidingView, e com o
 * edge-to-edge (Android 15+) a janela também não encolhe sozinha quando o teclado abre.
 */
export default function KeyboardAwareScreen({ children, className, style }: KeyboardAwareScreenProps) {
  return (
    <KeyboardAvoidingView behavior="padding" className={className} style={style}>
      {children}
    </KeyboardAvoidingView>
  );
}

/** true enquanto o teclado está aberto (ex.: para enxugar o rodapé e sobrar espaço para o campo). */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(() => Keyboard.isVisible());

  useEffect(() => {
    // O iOS avisa antes da animação; o Android, depois que o teclado abriu ou fechou
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const subscriptions = [
      Keyboard.addListener(showEvent, () => setVisible(true)),
      Keyboard.addListener(hideEvent, () => setVisible(false)),
    ];
    return () => subscriptions.forEach((subscription) => subscription.remove());
  }, []);

  return visible;
}
