import Feather from '@expo/vector-icons/Feather';

/**
 * Ícones são decorativos: quem descreve o botão ou o card é o texto ao lado ou o accessibilityLabel.
 * Sem isto o caractere da fonte de ícones entra na descrição lida pelo TalkBack/VoiceOver
 * (ex.: ", Entrar como Cliente" ou "R$ 23,50, " com um item vazio no fim).
 * Importado uma vez no App.tsx, antes de qualquer tela.
 */
Feather.defaultProps = {
  ...Feather.defaultProps,
  accessible: false,
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants',
};
