import React, { useEffect, useState } from 'react';
import { Image, ImageResizeMode, ImageStyle, StyleProp, View, ViewStyle } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { assetUrl } from '../../services/api';
import type { FeatherIconName } from '../../utils/catalog';

interface RemoteImageProps {
  /** Caminho salvo no backend ("/uploads/x.webp", "x.webp") ou URL absoluta. */
  path?: string | null;
  className?: string;
  /**
   * O plugin do NativeWind pode converter o className deste componente em `style`
   * (depende de como ele é importado), então aceitamos os dois.
   */
  style?: StyleProp<ViewStyle>;
  resizeMode?: ImageResizeMode;
  fallbackIcon?: FeatherIconName;
  iconSize?: number;
}

/** Imagem servida pela API, com ícone no lugar quando não existe ou falha ao carregar. */
export default function RemoteImage({
  path,
  className = '',
  style,
  resizeMode = 'cover',
  fallbackIcon = 'image',
  iconSize = 24,
}: RemoteImageProps) {
  const uri = assetUrl(path);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [uri]);

  if (!uri || failed) {
    return (
      <View className={`${className} items-center justify-center bg-gray-100 dark:bg-slate-700`} style={style}>
        <Feather name={fallbackIcon} size={iconSize} color="#94a3b8" />
      </View>
    );
  }

  return (
    <Image
      source={{ uri }}
      className={className}
      style={style as StyleProp<ImageStyle>}
      resizeMode={resizeMode}
      onError={() => setFailed(true)}
    />
  );
}
