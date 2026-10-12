/**
 * Tipagem do `className` (NativeWind 2) para o React Native 0.81.
 *
 * O NativeWind 2 aplica `className` pelo plugin do Babel, mas o arquivo de tipos dele
 * (`nativewind/types`) aumenta o módulo "react-native" — que, desde o RN 0.71, apenas
 * reexporta as interfaces de props declaradas nos arquivos de `Libraries/`. Aumento em
 * reexportação não é mesclado pelo TypeScript, então aqui aumentamos os módulos onde cada
 * interface é declarada de fato. As demais props herdam daqui: TextInput, ScrollView,
 * FlatList, KeyboardAvoidingView, ActivityIndicator, SafeAreaView etc. estendem ViewProps;
 * TouchableOpacity/TouchableHighlight estendem TouchableWithoutFeedbackProps; os ícones
 * do @expo/vector-icons estendem TextProps.
 */
import 'react-native';

declare module 'react-native/Libraries/Components/View/ViewPropTypes' {
  interface ViewProps {
    className?: string;
    tw?: string;
  }
}

declare module 'react-native/Libraries/Text/Text' {
  interface TextProps {
    className?: string;
    tw?: string;
  }
}

declare module 'react-native/Libraries/Image/Image' {
  interface ImagePropsBase {
    className?: string;
    tw?: string;
  }
}

declare module 'react-native/Libraries/Components/Touchable/TouchableWithoutFeedback' {
  interface TouchableWithoutFeedbackProps {
    className?: string;
    tw?: string;
  }
}

declare module 'react-native/Libraries/Components/TextInput/InputAccessoryView' {
  interface InputAccessoryViewProps {
    className?: string;
    tw?: string;
  }
}
